import { laneKeysLabel } from '../core/settings';
import { drawTestPattern } from '../render/testPattern';
import type { App } from './app';
import { useBackdrop } from './backdrop';
import { button, chip, hintBar, logo, moveFocus } from './components';
import { el } from './dom';
import type { Scene, SceneScope } from './sceneManager';

interface MenuItem {
  label: string;
  description: string;
  icon: string;
  /** Scene to open. */
  target: 'songSelect' | 'settings' | 'studio';
}

/**
 * Play and Settings in every build; the Studio build adds Studio, a separate menu for creating
 * and editing songs and charts (the Play flow never shows editing actions).
 */
function menuItems(laneKeys: string): MenuItem[] {
  return [
    {
      label: 'Play',
      description: `Pick a song and play it with ${laneKeys}. The built-in demo song is always there.`,
      icon: 'play',
      target: 'songSelect',
    },
    {
      label: 'Settings',
      description: 'Key bindings, scroll speed, volumes, display and your audio offset.',
      icon: 'settings',
      target: 'settings',
    },
    ...(__STUDIO__
      ? [
          {
            label: 'Studio',
            description: 'Import audio, write and edit charts, playtest them, and export packages.',
            icon: 'music',
            target: 'studio' as const,
          },
        ]
      : []),
  ];
}

/**
 * Main menu: the logo (with one shine on load), a short column of buttons and a line describing
 * the focused one, over the moving gradient. F2 shows the gameplay canvas test pattern.
 */
export class MainMenuScene implements Scene<undefined> {
  constructor(private readonly app: App) {}

  enter(scope: SceneScope): void {
    const { app } = this;
    const items = menuItems(laneKeysLabel(app.settings.value.laneKeys));
    const description = el('p', { className: 'main-menu-blurb', attrs: { 'aria-live': 'polite' } });

    const buttons = items.map((item, i) => {
      const b = button(scope, {
        label: item.label,
        icon: item.icon,
        variant: i === 0 ? 'primary' : 'secondary',
        size: 'lg',
        block: true,
        onClick: () => {
          if (item.target === 'settings') {
            void app.scenes.goTo('settings', { returnTo: { scene: 'menu' } });
          } else if (item.target === 'studio') {
            void app.scenes.goTo('studio', {});
          } else {
            void app.scenes.goTo('songSelect', {});
          }
        },
      });
      scope.listen(b, 'focus', () => {
        description.textContent = item.description;
      });
      scope.listen(b, 'mouseenter', () => {
        description.textContent = item.description;
      });
      return b;
    });

    const root = el('div', { className: 'screen main-menu' }, [
      el('main', { className: 'main-menu-center' }, [
        el('h1', { className: 'main-menu-logo' }, [
          logo('large', { shine: true }),
          ...(__STUDIO__ ? [chip({ label: 'studio', tone: 'accent' })] : []),
        ]),
        el('nav', { className: 'main-menu-list', attrs: { 'aria-label': 'Main menu' } }, buttons),
        description,
      ]),
      hintBar([
        [['ArrowUp', 'ArrowDown'], 'Move'],
        ['Enter', 'Select'],
      ]),
    ]);
    app.ui.appendChild(root);
    scope.onDispose(() => root.remove());
    const backdrop = useBackdrop(scope, app, { kind: 'gradient' });

    let testPattern = false;
    scope.listen(window, 'keydown', (e) => {
      if (e.key === 'F2') {
        e.preventDefault();
        testPattern = !testPattern;
        root.hidden = testPattern;
        if (testPattern) backdrop.hide();
        else backdrop.show({ kind: 'gradient' });
        return;
      }
      moveFocus(e, buttons);
    });
    description.textContent = items[0]?.description ?? '';
    buttons[0]?.focus();

    // Visual-only animation clock (rAF timestamp). Gameplay uses the audio clock instead.
    const start = performance.now();
    scope.everyFrame((ts) => {
      if (!testPattern) return;
      const dpr = window.devicePixelRatio || 1;
      drawTestPattern(app.pixel.ctx, app.skin, app.pixel.layout, (ts - start) / 1000, dpr);
      app.pixel.present();
    });
  }
}
