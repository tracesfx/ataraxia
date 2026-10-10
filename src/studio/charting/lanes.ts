import type { Lane, Note } from '../../core/chart';
import { noteEnd } from '../../core/chart';
import { firstAtOrAfter, hash01 } from './hits';
import type { GeneratorParams } from './presets';

/**
 * Step E, lanes: ONE continuous optimisation over the whole range (beam search), not templates.
 * Each event (a moment with 1-3 notes, some held) is placed on lanes by expanding every kept
 * state with every valid lane choice and keeping the cheapest BEAM_WIDTH distinct states.
 *
 * Hard rules: a lane under a hold (or within the minimum same-lane gap of its last note) is
 * unavailable; no more than `maxHolds` holds down; no more than `maxSameLane` notes in a row in
 * a lane; with jacks at 0, nothing in one lane faster than an eighth. Existing notes block their
 * lanes. Soft costs (weights from the settings): hand comfort, jack, trill and stair tendencies,
 * the melody contour, repeat consistency (lanes of the first occurrence), hand balance, chords on
 * split hands, keeping holds, and seeded noise for ties. Jacks, trills, stairs and chords are
 * therefore emergent, not templates.
 */

export const BEAM_WIDTH = 48;

export interface LaneEvent {
  tMs: number;
  /** Hold length of each note (0 = tap); the first is the main note. */
  notes: number[];
  pitch: number | null;
  /** Lanes the same position had in the first occurrence of its repeat (null = none). */
  ref: Lane[] | null;
}

export interface LaneChoice {
  lanes: Lane[];
  holds: number[];
}

const LANES: readonly Lane[] = [0, 1, 2, 3];
const hand = (l: number): 0 | 1 => (l < 2 ? 0 : 1);

function combos(k: number): Lane[][] {
  const out: Lane[][] = [];
  const rec = (start: number, acc: Lane[]): void => {
    if (acc.length === k) {
      out.push([...acc]);
      return;
    }
    for (let l = start; l < 4; l++) rec(l + 1, [...acc, LANES[l] as Lane]);
  };
  rec(0, []);
  return out;
}
const COMBOS = [[], combos(1), combos(2), combos(3)] as const;

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  const out: T[][] = [];
  items.forEach((x, i) => {
    for (const rest of permutations(items.filter((_, j) => j !== i))) out.push([x, ...rest]);
  });
  return out;
}

interface State {
  cost: number;
  /** Per lane: end of its last note (head for taps, tail for holds), -Infinity if none. */
  free: number[];
  /** Per lane: last head time. */
  last: number[];
  /** Per lane: end of an active hold (0 = none). */
  holdEnd: number[];
  prevLane: number;
  prev2Lane: number;
  prevT: number;
  prevPitch: number | null;
  sameRun: number;
  hand: number;
  handRun: number;
  trillRun: number;
  trace: Trace | null;
}

interface Trace {
  parent: Trace | null;
  choice: LaneChoice | null;
}

interface Expansion {
  from: State;
  choice: LaneChoice;
  cost: number;
  sig: number;
}

/** Existing notes per lane, for "is this lane free around t". */
class Blocked {
  private readonly lanes: Note[][] = [[], [], [], []];
  private readonly longest: number;
  constructor(notes: readonly Note[]) {
    let longest = 0;
    for (const n of notes) {
      this.lanes[n.lane]?.push(n);
      longest = Math.max(longest, noteEnd(n) - n.t);
    }
    for (const l of this.lanes) l.sort((a, b) => a.t - b.t);
    this.longest = longest;
  }
  /** Any existing note in `lane` touching [fromMs, toMs]. */
  hits(lane: Lane, fromMs: number, toMs: number): boolean {
    const list = this.lanes[lane] as Note[];
    for (let i = firstAtOrAfter(list, fromMs - this.longest, (n) => n.t); i < list.length; i++) {
      const n = list[i] as Note;
      if (n.t > toMs) break;
      if (noteEnd(n) >= fromMs) return true;
    }
    return false;
  }
}

export interface LaneResult {
  /** Per event: the lanes chosen, or null when it could not be placed. */
  choices: (LaneChoice | null)[];
}

export function assignLanes(
  events: readonly LaneEvent[],
  existing: readonly Note[],
  beatMs: number,
  p: GeneratorParams,
  seed: number,
): LaneResult {
  const blocked = new Blocked(existing);
  const minGap = p.minLaneGapMs;
  const jackFloorMs = p.jack <= 0 ? beatMs / 2 : 0;
  const erg = p.ergonomics;
  let beam: State[] = [
    {
      cost: 0,
      free: [-Infinity, -Infinity, -Infinity, -Infinity],
      last: [-Infinity, -Infinity, -Infinity, -Infinity],
      holdEnd: [0, 0, 0, 0],
      prevLane: -1,
      prev2Lane: -1,
      prevT: -Infinity,
      prevPitch: null,
      sameRun: 0,
      hand: -1,
      handRun: 0,
      trillRun: 0,
      trace: null,
    },
  ];

  const laneOk = (s: State, l: Lane, t: number, holdMs: number): boolean => {
    const free = s.free[l] as number;
    if (t - free < minGap) return false;
    if (t - (s.last[l] as number) < jackFloorMs) return false;
    return !blocked.hits(l, t - minGap, t + holdMs + minGap);
  };

  const permCache = new Map<string, number[][]>();
  /** Distinct orders of the notes (taps are interchangeable). */
  const permsOf = (notes: number[]): number[][] => {
    const key = notes.join(',');
    let perms = permCache.get(key);
    if (!perms) {
      const seen = new Set<string>();
      perms = permutations(notes).filter((perm) => {
        const k = perm.join(',');
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      permCache.set(key, perms);
    }
    return perms;
  };

  const expand = (
    s: State,
    e: LaneEvent,
    notes: number[],
    extraCost: number,
    idx: number,
  ): Expansion[] => {
    const out: Expansion[] = [];
    const t = e.tMs;
    const k = notes.length;
    let activeHolds = 0;
    for (const l of LANES) if ((s.holdEnd[l] as number) > t) activeHolds++;
    const newHolds = notes.filter((h) => h > 0).length;
    if (activeHolds + newHolds > p.maxHolds) return out;
    const perms = permsOf(notes);
    const gap = t - s.prevT;
    const seqW = gap < 1.5 * beatMs ? 1 : Math.max(0.2, (1.5 * beatMs) / gap);
    for (const combo of COMBOS[k] ?? []) {
      for (const perm of perms) {
        let ok = true;
        for (let i = 0; i < k; i++) {
          if (!laneOk(s, combo[i] as Lane, t, perm[i] as number)) {
            ok = false;
            break;
          }
        }
        if (!ok) continue;
        let cost = extraCost;
        // Same lane at short gaps (jacks), and taps under a hold on the same hand.
        for (let i = 0; i < k; i++) {
          const l = combo[i] as Lane;
          const dt = t - (s.last[l] as number);
          if (dt < beatMs) {
            let c = (1 - p.jack) * 1.6 * (1 - dt / beatMs);
            if (
              k === 1 &&
              e.pitch !== null &&
              s.prevPitch !== null &&
              Math.abs(e.pitch - s.prevPitch) < 0.5 &&
              l === s.prevLane
            ) {
              c -= p.contour * 0.8 * p.jack;
            }
            cost += c;
          }
          for (const m of LANES) {
            if (m !== l && hand(m) === hand(l) && (s.holdEnd[m] as number) > t && dt < 2 * beatMs) {
              cost += erg * (gap < 180 ? 1.2 : 0.3);
            }
          }
        }
        let handRun = 0;
        if (k === 1) {
          const L = combo[0] as Lane;
          const P = s.prevLane;
          const Q = s.prev2Lane;
          const sameRun = L === P ? s.sameRun + 1 : 1;
          if (sameRun > p.maxSameLane) continue;
          if (P >= 0 && gap < 220) {
            if (hand(L) === hand(P) && L !== P) cost += erg * 0.9 * (1 - gap / 220);
            else if (hand(L) !== hand(P)) cost -= erg * 0.2;
          }
          if (P >= 0 && L === P && gap >= beatMs) cost += 0.15;
          if (Q >= 0 && L === Q && L !== P) {
            cost -= p.trill * 0.6 * seqW;
            const trillRun = s.trillRun + 1;
            if (trillRun > 6) cost += 0.15 * (trillRun - 6);
          }
          if (P >= 0 && Q >= 0) {
            const d1 = P - Q;
            const d2 = L - P;
            if (Math.abs(d2) === 1 && d1 !== 0 && Math.sign(d1) === Math.sign(d2)) {
              cost -= p.stair * 0.9 * seqW;
            }
          }
          if (e.pitch !== null && s.prevPitch !== null && P >= 0 && gap < 2 * beatMs) {
            const dp = e.pitch - s.prevPitch;
            const dl = L - P;
            if (Math.abs(dp) >= 0.5) {
              const match = dl !== 0 && Math.sign(dl) === Math.sign(dp);
              cost += p.contour * seqW * (match ? -1 : dl === 0 ? 0.4 : 0.8);
            } else if (dl !== 0) {
              cost += L === Q ? -p.contour * 0.5 * seqW : p.contour * 0.2 * seqW;
            }
          }
          handRun = hand(L) === s.hand ? s.handRun + 1 : 1;
          if (handRun > 4) cost += p.handBalance * 0.3 * (handRun - 4);
          if (e.ref && e.ref.length > 0 && !e.ref.includes(L)) cost += p.repeatConsistency * 1.6;
        } else {
          if (combo.every((l) => hand(l) === hand(combo[0] as Lane))) cost += erg * 0.4;
          if (e.ref && e.ref.length > 0) {
            for (const l of combo) if (!e.ref.includes(l)) cost += p.repeatConsistency * 0.8;
          }
        }
        let mask = 0;
        for (const l of combo) mask |= 1 << l;
        cost += (hash01(seed, idx, mask, 9) - 0.5) * p.randomness * 1.2;
        const lanes = combo.slice();
        const holds = perm.slice();
        let holdMask = 0;
        for (const l of LANES) if ((s.holdEnd[l] as number) > t) holdMask |= 1 << l;
        for (let i = 0; i < k; i++)
          if ((holds[i] as number) > 0) holdMask |= 1 << (lanes[i] as number);
        const main = k === 1 ? (lanes[0] as number) : -1;
        const sig =
          (((main + 1) * 5 + (k === 1 ? s.prevLane + 1 : 0)) * 16 + holdMask) * 8 +
          Math.min(7, handRun);
        out.push({ from: s, choice: { lanes, holds }, cost: s.cost + cost, sig });
      }
    }
    return out;
  };

  const apply = (x: Expansion, e: LaneEvent): State => {
    const s = x.from;
    const t = e.tMs;
    const free = s.free.slice();
    const last = s.last.slice();
    const holdEnd = s.holdEnd.slice();
    x.choice.lanes.forEach((l, i) => {
      const h = x.choice.holds[i] as number;
      free[l] = t + h;
      last[l] = t;
      holdEnd[l] = h > 0 ? t + h : 0;
    });
    const k = x.choice.lanes.length;
    const L = k === 1 ? (x.choice.lanes[0] as number) : -1;
    const sameRun = k === 1 ? (L === s.prevLane ? s.sameRun + 1 : 1) : 0;
    const handNow = k === 1 ? hand(L) : -1;
    const handRun = k === 1 ? (handNow === s.hand ? s.handRun + 1 : 1) : 0;
    const trillRun =
      k === 1 && s.prev2Lane >= 0 && L === s.prev2Lane && L !== s.prevLane ? s.trillRun + 1 : 0;
    return {
      cost: x.cost,
      free,
      last,
      holdEnd,
      prevLane: k === 1 ? L : (x.choice.lanes[0] as number),
      prev2Lane: k === 1 ? s.prevLane : -1,
      prevT: t,
      prevPitch: e.pitch,
      sameRun,
      hand: handNow,
      handRun,
      trillRun,
      trace: { parent: s.trace, choice: x.choice },
    };
  };

  events.forEach((e, idx) => {
    // Variants: as planned; holds as taps (a cost); then fewer notes, only if nothing fits.
    const planned = e.notes;
    const variants: { notes: number[]; cost: number }[] = [{ notes: planned, cost: 0 }];
    if (planned.some((h) => h > 0)) {
      variants.push({ notes: planned.map(() => 0), cost: 0.5 + p.holdAmount });
    }
    const all: Expansion[] = [];
    for (const s of beam) for (const v of variants) all.push(...expand(s, e, v.notes, v.cost, idx));
    for (let k = planned.length - 1; all.length === 0 && k >= 1; k--) {
      const fewer = planned.slice(0, k);
      for (const s of beam) {
        all.push(...expand(s, e, fewer, 1.5, idx));
        all.push(
          ...expand(
            s,
            e,
            fewer.map(() => 0),
            2,
            idx,
          ),
        );
      }
    }
    if (all.length === 0) {
      // Nothing fits anywhere: the event is dropped.
      beam = beam.map((s) => ({
        ...s,
        cost: s.cost + 5,
        trace: { parent: s.trace, choice: null },
      }));
      return;
    }
    all.sort((a, b) => a.cost - b.cost);
    const seen = new Set<number>();
    const next: State[] = [];
    for (const x of all) {
      if (seen.has(x.sig)) continue;
      seen.add(x.sig);
      next.push(apply(x, e));
      if (next.length >= BEAM_WIDTH) break;
    }
    beam = next;
  });

  const best = beam.reduce((a, b) => (b.cost < a.cost ? b : a));
  const choices: (LaneChoice | null)[] = new Array<LaneChoice | null>(events.length).fill(null);
  let tr = best.trace;
  for (let i = events.length - 1; i >= 0 && tr; i--) {
    choices[i] = tr.choice;
    tr = tr.parent;
  }
  return { choices };
}
