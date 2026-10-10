import type { AudioAnalysis, AudioAnalyzer } from '../../audio/audioAnalysis';
import type { Lane } from '../../core/chart';
import { confidenceLevel, type TempoCandidate, type TempoEstimate } from '../../core/tempo';
import { button as uiButton, progressBar } from '../../ui/components';
import { el } from '../../ui/dom';
import type { SceneScope } from '../../ui/sceneManager';
import type { EditorChange, EditorState } from './editorState';
import { tip } from './editorUi';
import type { NpsCurve } from './overviewRenderer';
import {
  createSuggestPanel,
  type ChartAnalysisSource,
  type PendingSuggestion,
} from './suggestPanel';
import type { AnalysisOverlay } from './timelineRenderer';

/**
 * Charting assistance in the side panel: "Detect BPM" (suggests BPM and offset from the audio,
 * applied only on a click, as one undoable step; under Timing > More; uses the AudioAnalyzer)
 * and "Suggest" (the Phase 18 generator, suggestPanel.ts, on the ChartAnalysis the analysis
 * viewer owns).
 */

export interface AssistParts {
  /** Contents for the Detect BPM area. */
  detect: HTMLElement[];
  /** Contents for the Suggest section. */
  suggest: HTMLElement[];
  update(change: EditorChange): void;
  /**
   * Suggested notes waiting for Accept or Discard, the notes they would replace, the time range
   * they were generated for and a one-line summary (for the accept bar).
   */
  suggestion(): PendingSuggestion | null;
  /** Add the pending suggestion as one undo step. */
  accept(): void;
  /** Drop the pending suggestion. */
  discard(): void;
  /** Generate again with a new random seed (only while a suggestion is pending). */
  regenerate(): void;
  /** The density plan to draw on the timeline and minimap, or null when the overlay is off. */
  overlay(): AnalysisOverlay | null;
  /** Before/after notes per second for the minimap while a suggestion is shown. */
  npsCurve(): NpsCurve | null;
  /** The decision entry of a suggested note near (ms, lane), as rows. */
  describeAt(ms: number, lane: Lane, toleranceMs: number): [string, string][] | null;
}

export type { PendingSuggestion };

const LEVEL_TEXT = {
  high: 'high',
  medium: 'medium: check it with the metronome',
  low: 'low: the beat is unclear, check by ear before applying',
} as const;

/** Button text for a tempo choice relative to the detected one. */
function candidateLabel(bpm: number, detected: number): string {
  if (bpm === detected) return `${bpm.toFixed(2)} (detected)`;
  return `${bpm > detected ? 'x2' : '/2'} = ${bpm.toFixed(2)}`;
}

export function createAssistPanel(
  scope: SceneScope,
  state: EditorState,
  analyzer: AudioAnalyzer,
  /** The ChartAnalysis the note generator uses (owned by the analysis viewer). */
  chartSource: ChartAnalysisSource,
  onVisualChange: () => void,
  /** The pending suggestion appeared, changed or went away. */
  onPendingChange: () => void,
): AssistParts {
  const button = (
    label: string,
    title: string,
    run: () => void,
    o: { primary?: boolean; block?: boolean } = {},
  ): HTMLButtonElement =>
    tip(
      uiButton(scope, {
        label,
        variant: o.primary ? 'primary' : 'ghost',
        block: o.block ?? false,
        onClick: run,
      }),
      title,
      [],
      'left',
    );

  /** A progress bar with a label, shown while the analysis runs. */
  const progressRow = (): { row: HTMLElement; set: (f: number | null) => void } => {
    const bar = progressBar('Audio analysis');
    const label = el('span', { className: 'editor-dim', text: 'Analysing audio...' });
    const row = el('div', { className: 'editor-progress-row' }, [bar.root, label]);
    row.hidden = true;
    return {
      row,
      set: (f) => {
        row.hidden = f === null;
        if (f === null) return;
        bar.set(f);
        label.textContent = `Analysing audio... ${Math.round(f * 100)}%`;
      },
    };
  };

  const detectProgress = progressRow();
  const suggestProgress = progressRow();
  scope.onDispose(
    analyzer.onProgress((f) => {
      detectProgress.set(f);
      suggestProgress.set(f);
    }),
  );

  const busyButtons: HTMLButtonElement[] = [];
  /** Run the (shared, cached) analysis with buttons disabled; null if it failed or we left. */
  const analysis = async (status: HTMLElement): Promise<AudioAnalysis | null> => {
    for (const b of busyButtons) b.disabled = true;
    try {
      const result = await analyzer.run();
      return scope.disposed ? null : result;
    } catch (err) {
      if (scope.disposed) return null;
      console.error('Audio analysis failed:', err);
      status.textContent = `The audio could not be analysed. ${err instanceof Error ? err.message : String(err)}`;
      status.hidden = false;
      return null;
    } finally {
      if (!scope.disposed) {
        for (const b of busyButtons) b.disabled = false;
        detectProgress.set(null);
        suggestProgress.set(null);
      }
    }
  };

  // --- Detect BPM --------------------------------------------------------------------------

  const detectButton = button(
    'Detect BPM',
    'Estimate BPM and offset from the audio. Nothing changes until you press Apply.',
    () => void detect(),
    { block: true },
  );
  busyButtons.push(detectButton);
  const detectStatus = el('p', { className: 'editor-assist-note', attrs: { role: 'status' } });
  detectStatus.hidden = true;

  const resultValue = el('p', { className: 'editor-assist-value t-label' });
  const resultConfidence = el('p', { className: 'editor-assist-note' });
  const altRow = el('div', { className: 'editor-row is-wrap' });
  const applyButton = button('Apply', 'Use this BPM and offset (one undo step)', () => apply(), {
    primary: true,
  });
  const dismissButton = button('Dismiss', 'Keep the current BPM and offset', () => dismiss());
  const resultBox = el('div', { className: 'card editor-assist-result' }, [
    resultValue,
    resultConfidence,
    altRow,
    el('div', { className: 'editor-row' }, [applyButton, dismissButton]),
  ]);
  resultBox.hidden = true;

  let estimate: TempoEstimate | null = null;
  let chosen: TempoCandidate | null = null;

  const renderResult = (): void => {
    if (!estimate || !chosen || estimate.bpm === null) {
      resultBox.hidden = true;
      return;
    }
    resultBox.hidden = false;
    resultValue.textContent = `${chosen.bpm.toFixed(2)} BPM, offset ${chosen.offsetMs} ms`;
    const level = confidenceLevel(estimate.confidence);
    resultConfidence.textContent = `Confidence ${Math.round(estimate.confidence * 100)}% (${LEVEL_TEXT[level]}).`;
    resultConfidence.dataset['level'] = level;
    const choices: TempoCandidate[] = [
      { bpm: estimate.bpm, offsetMs: estimate.offsetMs, fit: 1 },
      ...estimate.alternatives,
    ];
    altRow.replaceChildren(
      el('span', { className: 'editor-dim', text: 'Or:' }),
      ...choices
        .filter((c) => c.bpm !== chosen?.bpm)
        .map((c) =>
          button(
            candidateLabel(c.bpm, estimate?.bpm ?? c.bpm),
            `Suggest ${c.bpm.toFixed(2)} BPM (offset ${c.offsetMs} ms) instead`,
            () => {
              chosen = c;
              renderResult();
            },
          ),
        ),
    );
  };

  const detect = async (): Promise<void> => {
    detectStatus.hidden = true;
    resultBox.hidden = true;
    const result = await analysis(detectStatus);
    if (!result) return;
    estimate = result.tempo;
    if (estimate.bpm === null) {
      chosen = null;
      detectStatus.textContent =
        estimate.onsetCount === 0
          ? 'No beat was found: the audio has no clear note onsets (silence or steady noise). Set the BPM by ear or with tap tempo.'
          : `No steady beat was found (only ${estimate.onsetCount} onsets). Set the BPM by ear or with tap tempo.`;
      detectStatus.hidden = false;
      renderResult();
      return;
    }
    chosen = { bpm: estimate.bpm, offsetMs: estimate.offsetMs, fit: 1 };
    renderResult();
  };

  const apply = (): void => {
    if (!chosen) return;
    const { bpm, offsetMs } = chosen;
    if (state.applyTiming(bpm, offsetMs)) {
      state.notify(`BPM ${bpm} and offset ${offsetMs} ms applied. Ctrl+Z undoes it.`);
    } else {
      state.notify('The BPM and offset already have these values.');
    }
    dismiss();
  };

  const dismiss = (): void => {
    estimate = null;
    chosen = null;
    resultBox.hidden = true;
    detectStatus.hidden = true;
  };

  const detectParts = [detectButton, detectProgress.row, detectStatus, resultBox];
  const suggest = createSuggestPanel(scope, state, chartSource, onVisualChange, onPendingChange);

  return {
    detect: detectParts,
    suggest: suggest.parts,
    update: (change) => suggest.update(change),
    suggestion: () => suggest.suggestion(),
    accept: () => suggest.accept(),
    discard: () => suggest.discard(),
    regenerate: () => suggest.regenerate(),
    overlay: () => suggest.overlay(),
    npsCurve: () => suggest.npsCurve(),
    describeAt: (ms, lane, tol) => suggest.describeAt(ms, lane, tol),
  };
}
