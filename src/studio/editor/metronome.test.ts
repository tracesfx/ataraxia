import { describe, expect, it } from 'vitest';
import { audioSecToSongMs, type SongAnchor } from '../../core/clock';
import { tapNote } from '../../core/noteEdit';
import {
  HitSounds,
  Metronome,
  noteHitsInRange,
  type ClickScheduler,
  type ClickTarget,
} from './metronome';

/** A fake audio engine: a settable context clock and a song anchor. */
class FakeTarget implements ClickTarget {
  readonly ctx = { currentTime: 0 };
  anchor: SongAnchor | null = null;
  clicks: { ms: number; accent: boolean }[] = [];

  get context(): AudioContext {
    return this.ctx as unknown as AudioContext;
  }
  songMsAtContextTime(sec: number): number | null {
    return this.anchor ? audioSecToSongMs(sec, this.anchor) : null;
  }
  scheduleClick(ms: number, accent: boolean): void {
    this.clicks.push({ ms, accent });
  }
  cancelClicks(): void {
    this.clicks = [];
  }
  play(fromMs: number, rate = 1): void {
    this.cancelClicks();
    this.anchor = { audioSec: this.ctx.currentTime + 0.05, songMs: fromMs, rate };
  }
}

/** Run ticks every 25 ms (+ jitter) of audio time for `seconds`. */
function run(m: ClickScheduler, t: FakeTarget, seconds: number, jitter = 0): void {
  const end = t.ctx.currentTime + seconds;
  let i = 0;
  while (t.ctx.currentTime < end) {
    t.ctx.currentTime += 0.025 + (i++ % 3 === 0 ? jitter : -jitter / 2);
    m.tick();
  }
}

describe('Metronome scheduler', () => {
  it('schedules every beat exactly once, accenting downbeats', () => {
    const t = new FakeTarget();
    const m = new Metronome(t, () => ({ bpm: 120, offsetMs: 0 }));
    t.play(0);
    m.resync(0);
    run(m, t, 10, 0.008);
    const beats = t.clicks.map((c) => c.ms / 500);
    expect(beats).toEqual(beats.map((_, i) => i));
    expect(beats.length).toBeGreaterThanOrEqual(19);
    expect(t.clicks.filter((c) => c.accent).map((c) => c.ms)).toEqual(
      t.clicks.filter((_, i) => i % 4 === 0).map((c) => c.ms),
    );
  });

  it('schedules nothing while stopped', () => {
    const t = new FakeTarget();
    const m = new Metronome(t, () => ({ bpm: 120, offsetMs: 0 }));
    run(m, t, 1);
    expect(t.clicks).toEqual([]);
  });

  it('stays on the new grid after a seek', () => {
    const t = new FakeTarget();
    const m = new Metronome(t, () => ({ bpm: 150, offsetMs: 320 }));
    t.play(0);
    m.resync(0);
    run(m, t, 2);
    t.play(60_000);
    m.resync(60_000);
    run(m, t, 2);
    const ms = t.clicks.map((c) => c.ms);
    expect(ms[0]).toBeGreaterThanOrEqual(60_000);
    for (const v of ms) expect((v - 320) % 400).toBeCloseTo(0, 6);
    expect(new Set(ms).size).toBe(ms.length);
  });

  it('clicks a beat exactly at the start position', () => {
    const t = new FakeTarget();
    const m = new Metronome(t, () => ({ bpm: 120, offsetMs: 0 }));
    t.play(1000);
    m.resync(1000);
    m.tick();
    expect(t.clicks[0]?.ms).toBe(1000);
  });

  it('covers proportionally less song time per tick at half speed', () => {
    const t = new FakeTarget();
    const m = new Metronome(t, () => ({ bpm: 120, offsetMs: 0 }));
    t.play(0, 0.5);
    m.resync(0);
    run(m, t, 4);
    // 4 s of audio at half speed = 2 s of song = 4 or 5 beats (plus lookahead).
    expect(t.clicks.length).toBeGreaterThanOrEqual(4);
    expect(t.clicks.length).toBeLessThanOrEqual(5);
  });

  it('picks up a BPM change on the next tick without repeating beats', () => {
    const t = new FakeTarget();
    let bpm = 120;
    const m = new Metronome(t, () => ({ bpm, offsetMs: 0 }));
    t.play(0);
    m.resync(0);
    run(m, t, 2);
    const before = t.clicks.length;
    const last = t.clicks[before - 1]?.ms ?? 0;
    bpm = 240;
    run(m, t, 1);
    const after = t.clicks.slice(before).map((c) => c.ms);
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((ms) => ms > last && ms % 250 === 0)).toBe(true);
  });
});

describe('Hit sounds', () => {
  const notes = [tapNote(0, 500), tapNote(1, 500), tapNote(2, 750), tapNote(0, 1000)];

  it('lists note heads in (from, to], one click per chord', () => {
    expect(noteHitsInRange(notes, 0, 750).map((c) => c.ms)).toEqual([500, 750]);
    expect(noteHitsInRange(notes, 500, 1000).map((c) => c.ms)).toEqual([750, 1000]);
  });

  it('clicks each note once at full and half speed', () => {
    for (const rate of [1, 0.5]) {
      const t = new FakeTarget();
      const h = new HitSounds(t, () => notes);
      t.play(0, rate);
      h.resync(0);
      run(h, t, 3, 0.008);
      expect(t.clicks.map((c) => c.ms)).toEqual([500, 750, 1000]);
    }
  });
});
