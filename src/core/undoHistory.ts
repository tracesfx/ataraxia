/**
 * Undo/redo with the command pattern. A command knows how to do and undo itself; the history
 * only orders them. Commands executed between beginGroup() and endGroup() become one composite
 * step (a drag, a paste, a whole live-recording session), so one undo reverts all of them.
 */

export interface Command {
  /** Short description, e.g. "Place note" (shown as "Undo Place note"). */
  readonly label: string;
  do(): void;
  undo(): void;
}

/** Several commands as one: done in order, undone in reverse. */
export class CompositeCommand implements Command {
  constructor(
    readonly label: string,
    readonly commands: readonly Command[],
  ) {}

  do(): void {
    for (const c of this.commands) c.do();
  }

  undo(): void {
    for (let i = this.commands.length - 1; i >= 0; i--) (this.commands[i] as Command).undo();
  }
}

export const UNDO_LIMIT = 200;

export class UndoHistory {
  private readonly done: Command[] = [];
  private readonly undone: Command[] = [];
  private group: { label: string; commands: Command[]; depth: number } | null = null;

  constructor(readonly limit = UNDO_LIMIT) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError(`Undo limit must be a whole number >= 1, got ${limit}`);
    }
  }

  get canUndo(): boolean {
    return this.done.length > 0 || (this.group?.commands.length ?? 0) > 0;
  }

  get canRedo(): boolean {
    return this.undone.length > 0;
  }

  /** Steps that can be undone (an open group counts once it has a command). */
  get undoCount(): number {
    return this.done.length + ((this.group?.commands.length ?? 0) > 0 ? 1 : 0);
  }

  get redoCount(): number {
    return this.undone.length;
  }

  get inGroup(): boolean {
    return this.group !== null;
  }

  /** Label of the step undo() would revert, or null. */
  get undoLabel(): string | null {
    if (this.group && this.group.commands.length > 0) return this.group.label;
    return this.done[this.done.length - 1]?.label ?? null;
  }

  get redoLabel(): string | null {
    return this.undone[this.undone.length - 1]?.label ?? null;
  }

  /** Do a command and record it (inside the open group, if any). Clears the redo stack. */
  execute(command: Command): void {
    command.do();
    this.undone.length = 0;
    if (this.group) {
      this.group.commands.push(command);
      return;
    }
    this.push(command);
  }

  /** Start grouping. Groups nest: only the outermost endGroup() closes the step. */
  beginGroup(label: string): void {
    if (this.group) {
      this.group.depth += 1;
      return;
    }
    this.group = { label, commands: [], depth: 1 };
  }

  /** Close the group. An empty group leaves no step behind. */
  endGroup(): void {
    const g = this.group;
    if (!g) return;
    g.depth -= 1;
    if (g.depth > 0) return;
    this.closeGroup();
  }

  /** Undo the last step (closing an open group first). Returns it, or null if none. */
  undo(): Command | null {
    this.closeGroup();
    const command = this.done.pop();
    if (!command) return null;
    command.undo();
    this.undone.push(command);
    return command;
  }

  redo(): Command | null {
    this.closeGroup();
    const command = this.undone.pop();
    if (!command) return null;
    command.do();
    this.done.push(command);
    return command;
  }

  clear(): void {
    this.done.length = 0;
    this.undone.length = 0;
    this.group = null;
  }

  private closeGroup(): void {
    const g = this.group;
    if (!g) return;
    this.group = null;
    if (g.commands.length === 0) return;
    this.push(new CompositeCommand(g.label, g.commands));
  }

  private push(command: Command): void {
    this.done.push(command);
    if (this.done.length > this.limit) this.done.shift();
  }
}
