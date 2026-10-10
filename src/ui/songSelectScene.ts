import { PRACTICE_RATE_MAX, PRACTICE_RATE_MIN, stepPracticeRate } from '../core/practice';
import { forgetSongCovers } from './coverImages';
import { extensionOf } from '../library/fileNames';
import type { App } from './app';
import { iconButton, toggle } from './components';
import { el } from './dom';
import { openModal } from './modal';
import type { Scene, SceneScope } from './sceneManager';
import type { SceneParams } from './scenes';
import { createSongBrowser, errorsOf, loadBrowser, type BrowserAction } from './songBrowser';

const PACKAGE_ACCEPT = '.zip,application/zip';

/** Practice mode choice, kept while the page is open (not saved: practice is per session). */
const practiceChoice = { on: false, rate: PRACTICE_RATE_MAX };

/**
 * Song select (the Play flow, in both builds): pick a song and chart, play or practise it, see
 * best scores, import song packages (.zip) and delete songs. Typing searches the list, so the
 * other shortcuts use Ctrl (Ctrl+P practice, Ctrl+O import, Ctrl+, settings) or keys that type
 * nothing (Delete). There are no editing actions here; that is Studio's job (src/studio).
 */
export class SongSelectScene implements Scene<SceneParams['songSelect']> {
  constructor(private readonly app: App) {}

  enter(scope: SceneScope, params: SceneParams['songSelect']): void {
    const { app } = this;
    const library = app.library;

    const importPackages = (files: File[]): Promise<void> =>
      browser.perform('Import failed', async () => {
        let select: SceneParams['songSelect'] | null = null;
        const done: string[] = [];
        const warnings: string[] = [];
        for (const file of files) {
          if (extensionOf(file.name) !== 'zip') {
            done.push(
              `"${file.name}" is not a song package. Only .zip song packages can be imported here.`,
            );
            continue;
          }
          browser.setStatus(`Importing "${file.name}"…`);
          try {
            const { song, warnings: notes } = await library.importPackage(file);
            select = { songId: song.id };
            done.push(`Imported the song package "${song.title}".`);
            warnings.push(...notes);
          } catch (err) {
            if (scope.disposed) return;
            await openModal(scope, app.ui, {
              title: `Package not imported: ${file.name}`,
              body: ['Nothing was imported because of these problems:'],
              errors: errorsOf(err),
              buttons: [{ label: 'OK', value: undefined, primary: true }],
              cancelValue: undefined,
            });
          }
        }
        if (scope.disposed) return;
        await browser.refresh(select ?? undefined);
        browser.setStatus(done.join(' '), 'success');
        if (warnings.length > 0) browser.setStatus(warnings.join(' '), 'warning');
      });

    const deleteSong = (): Promise<void> =>
      browser.perform('Not deleted', async () => {
        const song = browser.selectedSong();
        if (!song) return;
        if (song.builtIn) {
          browser.setStatus('The demo song is built in and cannot be deleted.', 'danger');
          return;
        }
        const chartCount = browser.chartsOf(song.id).length;
        const confirmed = await openModal(scope, app.ui, {
          title: 'Delete song?',
          body: [
            `Delete "${song.title}" with its audio, ${chartCount} chart${chartCount === 1 ? '' : 's'} and best scores? This cannot be undone.`,
          ],
          buttons: [
            { label: 'Cancel', value: false, primary: true },
            { label: 'Delete song', value: true, danger: true },
          ],
          cancelValue: false,
        });
        if (!confirmed) return;
        await library.deleteSong(song.id);
        forgetSongCovers(song.id);
        const next = browser.neighbourSong();
        await browser.refresh(next ? { songId: next.id } : {});
        browser.setStatus(`Deleted "${song.title}".`);
      });

    const play = (): void => {
      const song = browser.selectedSong();
      const chart = browser.selectedChart();
      if (!song || !browser.loaded) return;
      if (!chart) {
        browser.setStatus('This song has no charts to play.', 'danger');
        return;
      }
      void app.scenes.goTo(
        'game',
        practiceChoice.on
          ? {
              mode: 'practice',
              songId: song.id,
              chartId: chart.id,
              practice: { rate: practiceChoice.rate },
            }
          : { mode: 'play', songId: song.id, chartId: chart.id },
      );
    };

    const openSettings = (): void => {
      const song = browser.selectedSong();
      const chart = browser.selectedChart();
      void app.scenes.goTo('settings', {
        returnTo: {
          scene: 'songSelect',
          select: song ? { songId: song.id, ...(chart ? { chartId: chart.id } : {}) } : {},
        },
      });
    };

    // --- Practice ----------------------------------------------------------------------------

    const practiceToggle = toggle(scope, {
      label: 'Practice mode',
      checked: practiceChoice.on,
      onChange: (on) => {
        practiceChoice.on = on;
        renderPractice();
      },
    });
    const rateValue = el('output', { className: 'practice-rate t-label tabular' });
    const slower = iconButton(scope, {
      icon: 'minus',
      label: 'Slower (Ctrl+[)',
      onClick: () => stepRate(-1),
    });
    const faster = iconButton(scope, {
      icon: 'plus',
      label: 'Faster (Ctrl+])',
      onClick: () => stepRate(1),
    });
    const practiceBox = el('div', { className: 'practice-box' }, [
      el('div', { className: 'practice-label' }, [
        practiceToggle.root,
        el('span', { className: 'practice-text' }, [
          el('span', { className: 't-label', text: 'Practice' }),
          el('span', { className: 'practice-sub', text: 'Slower, with loops. No score.' }),
        ]),
      ]),
      el('div', { className: 'practice-rate-row' }, [slower, rateValue, faster]),
    ]);
    const renderPractice = (): void => {
      practiceToggle.set(practiceChoice.on);
      practiceBox.classList.toggle('is-on', practiceChoice.on);
      rateValue.textContent = `${Math.round(practiceChoice.rate * 100)}%`;
      slower.disabled = !practiceChoice.on || practiceChoice.rate <= PRACTICE_RATE_MIN;
      faster.disabled = !practiceChoice.on || practiceChoice.rate >= PRACTICE_RATE_MAX;
    };
    const togglePractice = (): void => {
      practiceChoice.on = !practiceChoice.on;
      renderPractice();
      browser.setStatus(
        practiceChoice.on
          ? 'Practice on: in a song, [ and ] set a loop, \\ clears it, - and + change the speed. No score is saved.'
          : 'Practice off.',
      );
    };
    function stepRate(dir: 1 | -1): void {
      practiceChoice.rate = stepPracticeRate(practiceChoice.rate, dir);
      renderPractice();
    }
    renderPractice();

    // --- Browser -----------------------------------------------------------------------------

    const importAction: BrowserAction = {
      key: 'Ctrl+O',
      label: 'Import song package',
      icon: 'package',
      placement: 'header',
      run: () => browser.picker.open(PACKAGE_ACCEPT, 'package', true),
      enabled: () => true,
    };

    const browser = createSongBrowser(scope, app, {
      className: 'song-select',
      title: 'Song select',
      layout: 'list',
      search: true,
      hints: [
        [['ArrowUp', 'ArrowDown'], 'Song'],
        [['ArrowLeft', 'ArrowRight'], 'Chart'],
        ['Enter', 'Play'],
        ['Ctrl+P', 'Practice'],
        ['Ctrl+,', 'Settings'],
        ['Escape', 'Back'],
      ],
      dropText: { title: 'Drop to import', detail: 'Song packages (.zip)' },
      empty: {
        title: 'No songs of your own yet',
        text: 'Import a song package (.zip), or drop one anywhere on this screen. Songs are saved in this browser.',
        action: importAction,
      },
      noChartsText: () => 'This song has no charts to play.',
      panelExtras: [practiceBox],
      activate: play,
      drop: (files) => void importPackages(files),
      pick: (files) => void importPackages(files),
      key: (e) => {
        if (!(e.ctrlKey || e.metaKey)) return false;
        if (e.key === 'p' || e.key === 'P') {
          if (!e.repeat) togglePractice();
          return true;
        }
        if ((e.key === '[' || e.key === ']') && practiceChoice.on) {
          stepRate(e.key === '[' ? -1 : 1);
          return true;
        }
        return false;
      },
      back: () => void app.scenes.goTo('menu'),
    });

    const isUserSong = (): boolean => browser.selectedSong()?.builtIn === false;
    const actions: BrowserAction[] = [
      importAction,
      {
        key: 'Ctrl+,',
        label: 'Settings',
        icon: 'settings',
        variant: 'ghost',
        placement: 'header',
        run: openSettings,
        enabled: () => true,
      },
      {
        key: 'Enter',
        label: 'Play',
        icon: 'play',
        variant: 'primary',
        run: play,
        enabled: () => browser.selectedChart() !== null,
      },
      {
        key: 'Delete',
        label: 'Delete song',
        icon: 'trash',
        variant: 'ghost',
        run: () => void deleteSong(),
        enabled: isUserSong,
      },
    ];
    browser.setActions(actions);
    loadBrowser(browser, params);
  }
}
