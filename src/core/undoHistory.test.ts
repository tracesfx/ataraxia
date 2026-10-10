import { describe, expect, it } from 'vitest';
import { UndoHistory, type Command } from './undoHistory';

/** Commands that append/remove a value on a shared list. */
function pushCommand(list: number[], value: number): Command {
  return {
    label: `push ${value}`,
    do: () => list.push(value),
    undo: () => {
      list.pop();
    },
  };
}

describe('UndoHistory', () => {
  it('undoes and redoes in order', () => {
    const list: number[] = [];
    const h = new UndoHistory();
    h.execute(pushCommand(list, 1));
    h.execute(pushCommand(list, 2));
    expect(list).toEqual([1, 2]);
    expect(h.undo()?.label).toBe('push 2');
    expect(list).toEqual([1]);
    expect(h.redo()?.label).toBe('push 2');
    expect(list).toEqual([1, 2]);
    expect(h.redo()).toBeNull();
  });

  it('clears the redo stack on a new command', () => {
    const list: number[] = [];
    const h = new UndoHistory();
    h.execute(pushCommand(list, 1));
    h.undo();
    h.execute(pushCommand(list, 3));
    expect(h.canRedo).toBe(false);
    expect(list).toEqual([3]);
  });

  it('groups commands into one step', () => {
    const list: number[] = [];
    const h = new UndoHistory();
    h.execute(pushCommand(list, 1));
    h.beginGroup('drag');
    h.execute(pushCommand(list, 2));
    h.execute(pushCommand(list, 3));
    h.endGroup();
    expect(h.undoCount).toBe(2);
    expect(h.undoLabel).toBe('drag');
    h.undo();
    expect(list).toEqual([1]);
    h.redo();
    expect(list).toEqual([1, 2, 3]);
  });

  it('nests groups and drops empty ones', () => {
    const list: number[] = [];
    const h = new UndoHistory();
    h.beginGroup('outer');
    h.beginGroup('inner');
    h.execute(pushCommand(list, 1));
    h.endGroup();
    expect(h.inGroup).toBe(true);
    h.execute(pushCommand(list, 2));
    h.endGroup();
    expect(h.undoCount).toBe(1);
    h.beginGroup('empty');
    h.endGroup();
    expect(h.undoCount).toBe(1);
  });

  it('closes an open group when undoing', () => {
    const list: number[] = [];
    const h = new UndoHistory();
    h.beginGroup('recording');
    h.execute(pushCommand(list, 1));
    h.execute(pushCommand(list, 2));
    expect(h.undoLabel).toBe('recording');
    h.undo();
    expect(list).toEqual([]);
    expect(h.inGroup).toBe(false);
  });

  it('keeps at most `limit` steps, dropping the oldest', () => {
    const list: number[] = [];
    const h = new UndoHistory(200);
    for (let i = 0; i < 250; i++) h.execute(pushCommand(list, i));
    expect(h.undoCount).toBe(200);
    while (h.undo());
    expect(list).toHaveLength(50);
  });
});
