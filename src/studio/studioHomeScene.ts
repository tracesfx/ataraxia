import { MAX_LEVEL, MIN_LEVEL } from '../core/chart';
import { COVER_ACCEPT, isCoverImageFile } from '../library/cover';
import { extensionOf } from '../library/fileNames';
import { validateChartMeta, validateSongMeta } from '../library/records';
import { LibraryError } from '../library/repository';
import type { CatalogChart, CatalogSong } from '../library/songLibrary';
import type { App } from '../ui/app';
import { button, iconButton } from '../ui/components';
import { forgetSongCovers } from '../ui/coverImages';
import { el } from '../ui/dom';
import { downloadBlob } from '../ui/files';
import { modalField, openModal } from '../ui/modal';
import type { Scene, SceneScope } from '../ui/sceneManager';
import type { SceneParams, SongSelectParams } from '../ui/scenes';
import { createSongBrowser, errorsOf, loadBrowser, type BrowserAction } from '../ui/songBrowser';
import { describeBackground } from '../core/background/config';
import { openBackgroundDialog } from './backgroundDialog';
import { openCoverCropDialog } from './coverCropDialog';
import type { StudioLibrary } from './studioLibrary';

const AUDIO_ACCEPT = 'audio/*,.mp3,.ogg,.oga,.opus,.wav,.flac,.m4a,.aac,.webm';

type ImportKind = 'audio' | 'chart' | 'package' | 'cover';

/** What a dropped file probably is, from its name (pictures become the selected song's cover). */
function importKindOf(file: File): ImportKind {
  const ext = extensionOf(file.name);
  if (ext === 'json') return 'chart';
  if (ext === 'zip') return 'package';
  if (isCoverImageFile(file, file.name)) return 'cover';
  return 'audio';
}

/**
 * Studio home: the creator's library. Import audio (picker or drag and drop), song packages and
 * chart files; edit song and chart metadata; create, duplicate and delete charts; export charts
 * and song packages; open the editor; and playtest a stored chart (the game comes back here).
 */
export class StudioHomeScene implements Scene<SceneParams['studio']> {
  constructor(
    private readonly app: App,
    private readonly studio: StudioLibrary,
  ) {}

  enter(scope: SceneScope, params: SceneParams['studio']): void {
    const { app, studio } = this;
    const library = app.library;

    /** The selected song, if it is one of the creator's own (not the read-only demo). */
    const requireUserSong = (): CatalogSong => {
      const song = browser.selectedSong();
      if (!song) throw new LibraryError(['Select a song first.']);
      if (song.builtIn) {
        throw new LibraryError([
          'The demo song is built in and read-only. Import your own audio (press I) to make charts.',
        ]);
      }
      return song;
    };

    const requireChart = (): { song: CatalogSong; chart: CatalogChart } => {
      const song = browser.selectedSong();
      const chart = browser.selectedChart();
      if (!song || !chart) {
        throw new LibraryError(['This song has no charts yet. Press N to create a blank chart.']);
      }
      return { song, chart };
    };

    /**
     * Crop a picture and make it the selected song's cover. Returns a status line, or null when
     * the crop was cancelled. Failures are thrown (LibraryError).
     */
    const applyCover = async (file: Blob, name?: string): Promise<string | null> => {
      const song = requireUserSong();
      const crop = await openCoverCropDialog(scope, app.ui, file, name);
      if (!crop || scope.disposed) return null;
      browser.setStatus('Saving the cover...');
      await studio.setCover(song.id, file, crop, name);
      forgetSongCovers(song.id);
      return `Saved the cover of "${song.title}".`;
    };

    const changeCover = (file: Blob, name?: string): Promise<void> =>
      browser.perform('Cover not saved', async () => {
        const song = requireUserSong();
        const status = await applyCover(file, name);
        if (!status || scope.disposed) return;
        await browser.refresh({ songId: song.id });
        browser.setStatus(status, 'success');
      });

    const removeCover = (): Promise<void> =>
      browser.perform('Cover not removed', async () => {
        const song = requireUserSong();
        if (!song.cover) return;
        await studio.removeCover(song.id);
        forgetSongCovers(song.id);
        await browser.refresh({ songId: song.id });
        browser.setStatus(`Removed the cover of "${song.title}".`);
      });

    const pickCover = (): void => {
      if (browser.selectedSong()?.builtIn === false) browser.picker.open(COVER_ACCEPT, 'cover');
      else void browser.perform('Cover not saved', () => Promise.resolve(void requireUserSong()));
    };

    const editBackground = (): Promise<void> =>
      browser.perform('Background not saved', async () => {
        const song = requireUserSong();
        const saved = await openBackgroundDialog(scope, app, studio, song);
        if (!saved || scope.disposed) return;
        await browser.refresh({ songId: song.id });
        browser.setStatus(`Saved the background of "${song.title}".`, 'success');
      });

    /** One line about a song's background for the detail panel. */
    const backgroundSummary = (song: CatalogSong): string => {
      const c = song.background;
      if (!c) return song.cover ? 'Default: the cover, softly blurred.' : 'Default: plain dark.';
      const pic =
        c.base.kind === 'image' && song.backgroundImageCount === 0 ? ' (picture missing)' : '';
      return `${describeBackground(c)}${pic}.`;
    };

    const importFiles = (files: File[], purpose: ImportKind | 'auto'): Promise<void> =>
      browser.perform('Import failed', async () => {
        let select: SongSelectParams | null = null;
        const done: string[] = [];
        const warnings: string[] = [];
        // Pictures: the first one becomes the selected song's cover (after cropping).
        const kinds = files.map((f) => (purpose === 'auto' ? importKindOf(f) : purpose));
        const picture = files.find((_, i) => kinds[i] === 'cover');
        if (picture) {
          const song = browser.selectedSong();
          try {
            const status = await applyCover(picture, picture.name);
            if (status && song) {
              select = { songId: song.id };
              done.push(status);
            }
          } catch (err) {
            if (scope.disposed) return;
            await openModal(scope, app.ui, {
              title: `Cover not saved: ${picture.name}`,
              errors: errorsOf(err),
              buttons: [{ label: 'OK', value: undefined, primary: true }],
              cancelValue: undefined,
            });
          }
        }
        for (const [index, file] of files.entries()) {
          const kind = kinds[index] ?? 'audio';
          if (kind === 'cover') continue;
          browser.setStatus(`Importing "${file.name}"...`);
          try {
            if (kind === 'audio') {
              const { song, fromTags } = await studio.importAudio(file);
              select = { songId: song.id };
              const tagged =
                fromTags.length > 0
                  ? ` Its ${fromTags.join(', ')} came from the file's tags (press R or use the cover tools to change them).`
                  : '';
              done.push(`Imported "${song.title}".${tagged} Press N to create a chart for it.`);
            } else if (kind === 'package') {
              const { song, warnings: notes } = await library.importPackage(file);
              select = { songId: song.id };
              done.push(`Imported the song package "${song.title}".`);
              warnings.push(...notes);
            } else {
              const song = requireUserSong();
              const { chart, notice } = await studio.importChart(file, song.id);
              select = { songId: song.id, chartId: chart.id };
              done.push(`Imported the ${chart.difficulty} chart.${notice ? ` ${notice}` : ''}`);
            }
          } catch (err) {
            const title =
              kind === 'chart'
                ? `Chart not imported: ${file.name}`
                : kind === 'package'
                  ? `Package not imported: ${file.name}`
                  : `Audio not imported: ${file.name}`;
            const intro =
              kind === 'audio' ? [] : ['Nothing was imported because of these problems:'];
            if (scope.disposed) return;
            await openModal(scope, app.ui, {
              title,
              body: intro,
              errors: errorsOf(err),
              buttons: [{ label: 'OK', value: undefined, primary: true }],
              cancelValue: undefined,
            });
          }
        }
        if (scope.disposed) return;
        await browser.refresh(select ?? undefined);
        browser.setStatus(done.join(' '));
        if (warnings.length > 0) browser.setStatus(warnings.join(' '), 'warning');
      });

    const newChart = (): Promise<void> =>
      browser.perform('Chart not created', async () => {
        const song = requireUserSong();
        const chart = await studio.createBlankChart(song.id);
        await browser.refresh({ songId: song.id, chartId: chart.id });
        browser.setStatus(`Created a blank ${chart.difficulty} chart. Press E to edit it.`);
      });

    const duplicateChart = (): Promise<void> =>
      browser.perform('Chart not duplicated', async () => {
        const song = requireUserSong();
        const { chart } = requireChart();
        const copy = await studio.duplicateChart(song.id, chart.id);
        await browser.refresh({ songId: song.id, chartId: copy.id });
        browser.setStatus(`Copied ${chart.difficulty} as "${copy.difficulty}".`);
      });

    const exportChart = (): Promise<void> =>
      browser.perform('Chart not exported', async () => {
        const { song, chart } = requireChart();
        const file = await studio.exportChart(song.id, chart.id);
        downloadBlob(file.blob, file.fileName);
        browser.setStatus(`Saved "${file.fileName}".`);
      });

    const exportPackage = (): Promise<void> =>
      browser.perform('Package not exported', async () => {
        const song = requireUserSong();
        browser.setStatus('Packing the song...');
        const file = await studio.exportPackage(song.id);
        downloadBlob(file.blob, file.fileName);
        browser.setStatus(`Saved "${file.fileName}".`);
      });

    const deleteSelected = (): Promise<void> =>
      browser.perform('Not deleted', async () => {
        const song = requireUserSong();
        const chart = browser.selectedChart();
        const chartCount = browser.chartsOf(song.id).length;
        type Choice = 'chart' | 'song' | 'cancel';
        const songLabel =
          chartCount === 0
            ? 'Delete song'
            : `Delete song + ${chartCount} chart${chartCount === 1 ? '' : 's'}`;
        const choice = await openModal<Choice>(scope, app.ui, {
          title: 'Delete?',
          body: [
            chart
              ? `Delete the ${chart.difficulty} chart, or the whole song "${song.title}" with its audio and all its charts? This cannot be undone.`
              : `Delete the song "${song.title}" and its audio? This cannot be undone.`,
          ],
          buttons: [
            { label: 'Cancel', value: 'cancel', primary: true },
            ...(chart
              ? [{ label: `Delete ${chart.difficulty}`, value: 'chart' as const, danger: true }]
              : []),
            { label: songLabel, value: 'song', danger: true },
          ],
          cancelValue: 'cancel',
        });
        if (choice === 'chart' && chart) {
          await studio.deleteChart(chart.id);
          browser.forgetChart(song.id);
          await browser.refresh({ songId: song.id });
          browser.setStatus(`Deleted the ${chart.difficulty} chart.`);
        } else if (choice === 'song') {
          await library.deleteSong(song.id);
          forgetSongCovers(song.id);
          const next = browser.neighbourSong();
          await browser.refresh(next ? { songId: next.id } : {});
          browser.setStatus(`Deleted "${song.title}".`);
        }
      });

    const editInfo = (): Promise<void> =>
      browser.perform('Not saved', async () => {
        const song = requireUserSong();
        const chart = browser.selectedChart();
        const title = modalField('Title', song.title, { maxlength: '200' });
        const artist = modalField('Artist', song.artist, { maxlength: '200' });
        const bpm = modalField('BPM', String(song.bpm), { inputmode: 'decimal' });
        const offset = modalField('Offset (ms)', String(song.offsetMs), { inputmode: 'numeric' });
        const previewStart = modalField('Preview start (ms)', String(song.previewStartMs), {
          inputmode: 'numeric',
        });
        const difficulty = modalField('Difficulty', chart?.difficulty ?? '', { maxlength: '40' });
        const level = modalField(`Level (${MIN_LEVEL}-${MAX_LEVEL})`, String(chart?.level ?? 1), {
          inputmode: 'numeric',
        });
        const charter = modalField('Charter', chart?.charter ?? '', { maxlength: '100' });
        const num = (input: HTMLInputElement): number =>
          input.value.trim() === '' ? NaN : Number(input.value.trim());

        const body: Node[] = [
          el('h3', { className: 'modal-section t-label', text: 'Song' }),
          title.row,
          artist.row,
          bpm.row,
          offset.row,
          previewStart.row,
        ];
        if (chart) {
          body.push(
            el('h3', { className: 'modal-section t-label', text: 'Chart' }),
            difficulty.row,
            level.row,
            charter.row,
          );
        }
        const saved = await openModal(scope, app.ui, {
          title: 'Edit info',
          body,
          buttons: [
            { label: 'Cancel', value: false },
            { label: 'Save', value: true, primary: true },
          ],
          cancelValue: false,
          validate: async () => {
            const songPatch = {
              title: title.input.value.trim(),
              artist: artist.input.value.trim(),
              bpm: num(bpm.input),
              offsetMs: num(offset.input),
              previewStartMs: num(previewStart.input),
            };
            const chartPatch = {
              difficulty: difficulty.input.value.trim(),
              level: num(level.input),
              charter: charter.input.value.trim(),
            };
            const errors = [
              ...validateSongMeta(songPatch),
              ...(chart ? validateChartMeta(chartPatch) : []),
            ];
            if (errors.length > 0) return errors;
            try {
              await studio.updateSong(song.id, songPatch);
              if (chart) await studio.updateChart(chart.id, chartPatch);
            } catch (err) {
              return errorsOf(err);
            }
            return [];
          },
        });
        if (!saved) return;
        await browser.refresh({ songId: song.id, ...(chart ? { chartId: chart.id } : {}) });
        browser.setStatus('Saved.');
      });

    const openEditor = (): void => {
      const song = browser.selectedSong();
      const chart = browser.selectedChart();
      if (!song || !browser.loaded) return;
      if (song.builtIn) {
        browser.setStatus(
          'The demo song is read-only. Import your own audio (press I) to make charts.',
        );
        return;
      }
      if (!chart) {
        browser.setStatus('This song has no charts yet. Press N to create one first.');
        return;
      }
      void app.scenes.goTo('editor', { songId: song.id, chartId: chart.id });
    };

    const playtest = (): void => {
      const song = browser.selectedSong();
      const chart = browser.selectedChart();
      if (!song || !browser.loaded) return;
      if (!chart) {
        browser.setStatus('This song has no charts yet. Press N to create one first.');
        return;
      }
      if (chart.noteCount === 0) {
        browser.setStatus('This chart has no notes yet. Press E to write some first.');
        return;
      }
      // Still inside the key/click handler: lets the game start its audio right away.
      void app.audio.unlock();
      const ids = { songId: song.id, chartId: chart.id };
      void app.scenes.goTo('game', {
        mode: 'playtest',
        ...ids,
        returnTo: { scene: 'studio', params: ids },
      });
    };

    const openSettings = (): void => {
      const song = browser.selectedSong();
      const chart = browser.selectedChart();
      void app.scenes.goTo('settings', {
        returnTo: {
          scene: 'studio',
          select: song ? { songId: song.id, ...(chart ? { chartId: chart.id } : {}) } : {},
        },
      });
    };

    const isUserSong = (): boolean => browser.selectedSong()?.builtIn === false;
    const hasChart = (): boolean => browser.selectedChart() !== null;
    const importAudio: BrowserAction = {
      key: 'I',
      label: 'Import audio',
      icon: 'import',
      variant: 'primary',
      placement: 'header',
      run: () => browser.picker.open(AUDIO_ACCEPT, 'audio', true),
      enabled: () => true,
    };

    const browser = createSongBrowser(scope, app, {
      className: 'studio-home',
      title: 'Studio',
      layout: 'table',
      search: false,
      hints: [
        [['ArrowUp', 'ArrowDown'], 'Song'],
        [['ArrowLeft', 'ArrowRight'], 'Chart'],
        ['Enter', 'Edit'],
        ['T', 'Playtest'],
        ['N', 'New chart'],
        ['I', 'Import audio'],
        ['Escape', 'Back'],
      ],
      dropText: {
        title: 'Drop to import',
        detail: 'Audio, chart .json, song .zip, or a picture for the cover',
      },
      empty: {
        title: 'No songs of your own yet',
        text: 'Import an MP3, OGG, WAV or FLAC file, or drop one anywhere on this screen. Songs are saved in this browser.',
        action: importAudio,
      },
      noChartsText: (song) =>
        song.builtIn ? '' : 'No charts yet. Press N for a blank chart or C to import one.',
      activate: openEditor,
      drop: (files) => void importFiles(files, 'auto'),
      pick: (files, purpose) => {
        const [file] = files;
        if (purpose !== 'cover') void importFiles(files, purpose as ImportKind);
        else if (file) void changeCover(file, file.name);
      },
      key: (e) => {
        if (e.ctrlKey || e.metaKey || e.repeat) return false;
        const k = e.key.toLowerCase();
        if (k === 'p') pickCover();
        else if (k === 'b') void editBackground();
        else return false;
        return true;
      },
      detailSection: {
        title: 'Background',
        render: (song) => [
          el('p', {
            className: 'detail-background-summary',
            text: song.builtIn
              ? 'Built in: the Neon look with particles.'
              : backgroundSummary(song),
          }),
          ...(song.builtIn
            ? []
            : [
                button(scope, {
                  label: 'Edit background',
                  icon: 'display',
                  hint: 'B',
                  onClick: () => void editBackground(),
                }),
              ]),
        ],
      },
      coverTools: (song, coverSlot) => {
        coverSlot.classList.toggle('is-editable', !song.builtIn);
        coverSlot.title = song.builtIn
          ? ''
          : 'Drop a picture on this screen to use it as the cover';
        if (song.builtIn) return [];
        const tools = [
          iconButton(scope, {
            icon: 'import',
            label: song.cover ? 'Replace cover (P)' : 'Upload cover (P)',
            onClick: pickCover,
          }),
        ];
        const cover = song.cover;
        if (cover) {
          tools.push(
            iconButton(scope, {
              icon: 'crop',
              label: 'Crop cover',
              onClick: () => void changeCover(cover.full, 'The cover'),
            }),
            iconButton(scope, {
              icon: 'trash',
              label: 'Remove cover',
              onClick: () => void removeCover(),
            }),
          );
        }
        return [
          el('span', {
            className: 'detail-cover-label t-label',
            text: cover ? 'Cover' : 'No cover yet',
          }),
          ...tools,
        ];
      },
      back: () => void app.scenes.goTo('menu'),
    });

    const actions: BrowserAction[] = [
      importAudio,
      {
        key: 'O',
        label: 'Import package',
        icon: 'package',
        placement: 'header',
        run: () => browser.picker.open('.zip,application/zip', 'package', true),
        enabled: () => true,
      },
      {
        key: 'S',
        label: 'Settings',
        icon: 'settings',
        variant: 'ghost',
        placement: 'header',
        run: openSettings,
        enabled: () => true,
      },
      {
        key: 'E',
        label: 'Edit chart',
        icon: 'edit',
        variant: 'primary',
        run: openEditor,
        enabled: () => isUserSong() && hasChart(),
      },
      { key: 'T', label: 'Playtest', icon: 'play', run: playtest, enabled: hasChart },
      {
        key: 'N',
        label: 'New chart',
        icon: 'new-chart',
        run: () => void newChart(),
        enabled: isUserSong,
      },
      {
        key: 'U',
        label: 'Duplicate chart',
        icon: 'duplicate',
        run: () => void duplicateChart(),
        enabled: () => isUserSong() && hasChart(),
      },
      {
        key: 'C',
        label: 'Import chart',
        icon: 'import',
        run: () => {
          if (isUserSong()) browser.picker.open('.json,application/json', 'chart', true);
          else
            void browser.perform('Chart not imported', () =>
              Promise.resolve(void requireUserSong()),
            );
        },
        enabled: isUserSong,
      },
      {
        key: 'R',
        label: 'Edit info',
        icon: 'edit-info',
        run: () => void editInfo(),
        enabled: isUserSong,
      },
      {
        key: 'X',
        label: 'Export chart',
        icon: 'export',
        run: () => void exportChart(),
        enabled: hasChart,
      },
      {
        key: 'K',
        label: 'Export package',
        icon: 'export',
        run: () => void exportPackage(),
        enabled: isUserSong,
      },
      {
        key: 'Delete',
        label: 'Delete',
        icon: 'trash',
        variant: 'danger',
        run: () => void deleteSelected(),
        enabled: isUserSong,
      },
    ];
    browser.setActions(actions);
    loadBrowser(browser, params);
  }
}
