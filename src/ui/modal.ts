import { button, icon } from './components';
import { el } from './dom';
import type { SceneScope } from './sceneManager';

export interface ModalButton<T> {
  label: string;
  value: T;
  /** Focused when the dialog opens; drawn as the primary (accent) button. */
  primary?: boolean;
  danger?: boolean;
}

export interface ModalOptions<T> {
  title: string;
  /** Extra class on the dialog (e.g. a wider layout). */
  className?: string;
  /** Paragraphs or nodes (e.g. form fields) shown under the title. */
  body?: (string | Node)[];
  /** Shown as a list of problems. */
  errors?: readonly string[];
  buttons: ModalButton<T>[];
  /** Result when the dialog is dismissed with Esc (or the scene exits). */
  cancelValue: T;
  /**
   * Called when a non-cancel button is chosen. Returning problems keeps the dialog open and
   * shows them; an empty list closes it.
   */
  validate?: (value: T) => readonly string[] | Promise<readonly string[]>;
}

/**
 * Modal dialog on a glass frame over a dimmed backdrop (native <dialog>: focus is trapped
 * inside, Esc cancels). Key presses inside it never reach the scene's window listeners.
 * Resolves with the chosen button's value; closed automatically, resolving `cancelValue`, if
 * the scene exits first.
 */
export function openModal<T>(scope: SceneScope, host: HTMLElement, o: ModalOptions<T>): Promise<T> {
  return new Promise<T>((resolve) => {
    const errorList = el('ul', { className: 'modal-errors', attrs: { role: 'alert' } });
    const showErrors = (errors: readonly string[]): void => {
      errorList.replaceChildren(
        ...errors.map((e) => el('li', {}, [icon('alert'), el('span', { text: e })])),
      );
      errorList.hidden = errors.length === 0;
    };
    showErrors(o.errors ?? []);

    let done = false;
    const finish = (value: T): void => {
      if (done) return;
      done = true;
      if (dialog.open) dialog.close();
      dialog.remove();
      resolve(value);
    };

    let busy = false;
    const choose = (b: ModalButton<T>): void => {
      if (busy) return;
      if (b.value === o.cancelValue || !o.validate) {
        finish(b.value);
        return;
      }
      busy = true;
      void Promise.resolve(o.validate(b.value)).then(
        (errors) => {
          busy = false;
          if (errors.length === 0) finish(b.value);
          else showErrors(errors);
        },
        (err: unknown) => {
          busy = false;
          showErrors([err instanceof Error ? err.message : String(err)]);
        },
      );
    };
    const buttons = o.buttons.map((b) =>
      button(scope, {
        label: b.label,
        variant: b.danger ? 'danger' : b.primary ? 'primary' : 'secondary',
        onClick: () => choose(b),
      }),
    );

    const dialog = el(
      'dialog',
      { className: `modal ${o.className ?? ''}`.trim(), attrs: { 'aria-label': o.title } },
      [
        el('h2', { className: 'modal-title t-title', text: o.title }),
        el(
          'div',
          { className: 'modal-body' },
          (o.body ?? []).map((part) =>
            typeof part === 'string' ? el('p', { className: 'modal-text', text: part }) : part,
          ),
        ),
        errorList,
        el('div', { className: 'modal-buttons' }, buttons),
      ],
    );

    scope.listen(dialog, 'cancel', (e) => {
      e.preventDefault();
      finish(o.cancelValue);
    });
    scope.listen(dialog, 'keydown', (e) => {
      e.stopPropagation();
      // Left/Right moves between the buttons.
      if (
        (e.key === 'ArrowLeft' || e.key === 'ArrowRight') &&
        buttons.includes(e.target as HTMLButtonElement)
      ) {
        e.preventDefault();
        const i = buttons.indexOf(e.target as HTMLButtonElement);
        const step = e.key === 'ArrowRight' ? 1 : -1;
        buttons[(i + step + buttons.length) % buttons.length]?.focus();
      }
    });
    scope.listen(dialog, 'keyup', (e) => e.stopPropagation());
    scope.onDispose(() => finish(o.cancelValue));

    host.appendChild(dialog);
    dialog.showModal();
    const first = dialog.querySelector<HTMLElement>('input, select');
    (first ?? buttons[o.buttons.findIndex((b) => b.primary)] ?? buttons[0])?.focus();
  });
}

/** Show a list of problems with a single OK button. */
export function showErrors(
  scope: SceneScope,
  host: HTMLElement,
  title: string,
  errors: readonly string[],
): Promise<void> {
  return openModal(scope, host, {
    title,
    errors,
    buttons: [{ label: 'OK', value: undefined, primary: true }],
    cancelValue: undefined,
  });
}

/** A labelled text input for forms inside a modal. */
export function modalField(
  label: string,
  value: string,
  attrs: Record<string, string> = {},
): { row: HTMLElement; input: HTMLInputElement } {
  const input = el('input', { className: 'field-input', attrs: { type: 'text', ...attrs } });
  input.value = value;
  return {
    row: el('label', { className: 'modal-field' }, [
      el('span', { className: 'modal-field-label t-label', text: label }),
      el('span', { className: 'field field--text' }, [input]),
    ]),
    input,
  };
}
