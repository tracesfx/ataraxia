import { validatedChart } from '../../core/noteEdit';
import { parseChart, serializeChart } from '../../core/parseChart';
import { safeFileName } from '../../library/fileNames';
import { LibraryError } from '../../library/repository';
import type { App } from '../../ui/app';
import { downloadBlob } from '../../ui/files';
import { openModal, showErrors } from '../../ui/modal';
import type { SceneScope } from '../../ui/sceneManager';
import type { StudioLibrary } from '../studioLibrary';
import type { EditorState } from './editorState';

/**
 * The editor's file operations: export the chart being edited (unsaved changes included),
 * export the song package (after saving), and import a chart file into this chart.
 */

function errorsOf(err: unknown): string[] {
  if (err instanceof LibraryError) return err.errors;
  return [err instanceof Error ? err.message : String(err)];
}

/** Download the current chart as .json. Refuses (with the reasons) if it doesn't validate. */
export async function exportChartFile(
  scope: SceneScope,
  app: App,
  state: EditorState,
): Promise<void> {
  const checked = validatedChart(state.toChart());
  if (!checked.ok) {
    await showErrors(scope, app.ui, 'The chart was not exported', [
      'The chart has problems that would make the file unplayable:',
      ...checked.errors,
    ]);
    return;
  }
  const { chart } = checked;
  downloadBlob(
    new Blob([serializeChart(chart)], { type: 'application/json' }),
    `${safeFileName(`${chart.title} - ${chart.difficulty}`, 'chart')}.json`,
  );
  state.notify('Chart exported.');
}

/** Save, then download the song with its audio and every chart as a .zip package. */
export async function exportSongPackage(
  scope: SceneScope,
  app: App,
  studioLibrary: StudioLibrary,
  songId: string,
  state: EditorState,
  flush: () => Promise<boolean>,
): Promise<void> {
  if (!(await flush())) {
    await showErrors(scope, app.ui, 'The package was not exported', [
      'The latest changes could not be saved, and the package is built from the saved charts. Fix the problem shown next to "Not saved" and try again.',
    ]);
    return;
  }
  try {
    const { blob, fileName } = await studioLibrary.exportPackage(songId);
    if (scope.disposed) return;
    downloadBlob(blob, fileName);
    state.notify('Song package exported.');
  } catch (err) {
    await showErrors(scope, app.ui, 'The package was not exported', errorsOf(err));
  }
}

/**
 * Import a chart file into the chart being edited: validate it with parseChart (problems are
 * listed and nothing changes), then ask before replacing. Replacing the notes is one undo step;
 * difficulty, level and charter follow the file, and optionally its BPM and offset.
 */
export async function importChartFile(
  scope: SceneScope,
  app: App,
  state: EditorState,
  file: File,
): Promise<void> {
  let text: string;
  try {
    text = await file.text();
  } catch {
    await showErrors(scope, app.ui, 'The chart was not imported', [
      `"${file.name}" could not be read. Check that the file still exists and try again.`,
    ]);
    return;
  }
  const parsed = parseChart(text);
  if (!parsed.ok) {
    await showErrors(scope, app.ui, `"${file.name}" could not be imported`, [
      ...parsed.errors,
      'Your current chart was not changed.',
    ]);
    return;
  }
  const chart = parsed.chart;
  const m = state.meta;
  const timingDiffers = chart.bpm !== m.bpm || chart.offsetMs !== m.offsetMs;
  type Choice = 'cancel' | 'replace' | 'timing';
  const buttons: { label: string; value: Choice; primary?: boolean; danger?: boolean }[] = [
    { label: 'Cancel', value: 'cancel' },
    { label: 'Replace', value: 'replace', primary: true, danger: true },
  ];
  if (timingDiffers) buttons.push({ label: 'Replace and use its BPM/offset', value: 'timing' });
  const body = [
    `Replace the ${state.notes.length} notes of this chart with the ${chart.notes.length} notes from "${file.name}"? Difficulty, level and charter are replaced too.`,
    'Ctrl+Z undoes the note change.',
  ];
  if (timingDiffers) {
    body.push(
      `The file's timing (${chart.bpm} BPM, offset ${chart.offsetMs} ms) differs from this song's (${m.bpm} BPM, offset ${m.offsetMs} ms). The BPM and offset belong to the song and are shared by all its charts.`,
    );
  }
  const choice = await openModal<Choice>(scope, app.ui, {
    title: 'Import chart',
    body,
    buttons,
    cancelValue: 'cancel',
  });
  if (choice === 'cancel' || scope.disposed) return;
  if (!state.replaceNotes(chart.notes)) return;
  state.setMeta({
    difficulty: chart.difficulty,
    level: chart.level,
    charter: chart.charter,
    ...(choice === 'timing' ? { bpm: chart.bpm, offsetMs: chart.offsetMs } : {}),
  });
  state.notify(`Imported ${chart.notes.length} notes from "${file.name}".`);
}
