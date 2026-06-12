import { monaco } from './monaco-setup';
import {
  conflictChoiceLines,
  findConflictBlocks,
  type ConflictBlock,
  type ConflictChoice,
} from './merge-conflicts';
import { getMessage } from '../../i18n/messages';
import { currentLocale } from '../../i18n/locale-storage';

/**
 * In-editor merge-conflict aid for the single Monaco instance (MonacoView):
 *   - whole-line background decorations on the current/incoming sections of
 *     every conflict block (token-based classes in editor-git.css), via the
 *     same decorations-collection pattern as git-decorations.ts;
 *   - a CodeLens row above each block — "Accept current / Accept incoming /
 *     Accept both" — that edits the buffer through executeEdits, so undo and
 *     dirty-tracking behave like a hand edit.
 *
 * The marker parsing + choice math lives in merge-conflicts.ts (pure, unit
 * tested); this class only owns the Monaco wiring. MonacoView drives the
 * lifecycle: refresh on model bind and (debounced) on content changes.
 */

const REFRESH_DEBOUNCE_MS = 200;

export class ConflictEditorAid {
  private readonly editor: monaco.editor.IStandaloneCodeEditor;
  private readonly decorations: monaco.editor.IEditorDecorationsCollection;
  // Monaco's CodeLensProvider.onDidChange event carries the provider itself.
  private readonly lensChanged = new monaco.Emitter<monaco.languages.CodeLensProvider>();
  private readonly provider: monaco.languages.CodeLensProvider;
  private readonly providerDisposable: monaco.IDisposable;
  private readonly commandId: string | null;
  private blocks: ConflictBlock[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(editor: monaco.editor.IStandaloneCodeEditor) {
    this.editor = editor;
    this.decorations = editor.createDecorationsCollection();
    // An editor-scoped command the lenses invoke (keybinding 0 = none). The
    // returned id is what CodeLens `command.id` must reference.
    this.commandId = editor.addCommand(
      0,
      (_accessor: unknown, payload: { startLine: number; choice: ConflictChoice }) => {
        this.applyChoice(payload.startLine, payload.choice);
      },
    );
    // One global provider for every language; it only answers for the model
    // currently bound to OUR editor (there is a single editor instance).
    this.provider = {
      onDidChange: this.lensChanged.event,
      provideCodeLenses: (model) => ({
        lenses: this.lensesFor(model),
        dispose: () => {},
      }),
    };
    this.providerDisposable = monaco.languages.registerCodeLensProvider(
      '*',
      this.provider,
    );
  }

  /** Re-scan after a content change, debounced so typing stays cheap. */
  refreshSoon(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.refresh();
    }, REFRESH_DEBOUNCE_MS);
  }

  /** Re-scan the bound model for conflict blocks and repaint immediately. */
  refresh(): void {
    if (this.disposed) return;
    const model = this.editor.getModel();
    if (!model || model.isDisposed()) {
      this.blocks = [];
      this.decorations.clear();
      return;
    }
    this.blocks = findConflictBlocks(model.getValue());
    const decos: monaco.editor.IModelDeltaDecoration[] = [];
    const wholeLines = (
      from: number,
      to: number,
      className: string,
    ): void => {
      if (to < from) return;
      decos.push({
        range: new monaco.Range(from, 1, to, 1),
        options: {
          isWholeLine: true,
          className,
          stickiness:
            monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        },
      });
    };
    for (const b of this.blocks) {
      // Marker lines themselves (and any diff3 base section) get the dim wash;
      // the two sides get their respective fills.
      wholeLines(b.start, b.start, 'marudesk-conflict-marker');
      wholeLines(b.start + 1, (b.base ?? b.sep) - 1, 'marudesk-conflict-current');
      // The diff3 base section (when present) and the ======= separator both
      // read as "neither side".
      wholeLines(b.base ?? b.sep, b.sep, 'marudesk-conflict-marker');
      wholeLines(b.sep + 1, b.end - 1, 'marudesk-conflict-incoming');
      wholeLines(b.end, b.end, 'marudesk-conflict-marker');
    }
    this.decorations.set(decos);
    this.lensChanged.fire(this.provider);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.decorations.clear();
    this.providerDisposable.dispose();
    this.lensChanged.dispose();
  }

  private lensesFor(model: monaco.editor.ITextModel): monaco.languages.CodeLens[] {
    if (
      this.disposed ||
      this.commandId === null ||
      model !== this.editor.getModel()
    ) {
      return [];
    }
    const locale = currentLocale();
    const actions: { choice: ConflictChoice; title: string }[] = [
      { choice: 'current', title: getMessage(locale, 'editor.conflict.acceptCurrent') },
      { choice: 'incoming', title: getMessage(locale, 'editor.conflict.acceptIncoming') },
      { choice: 'both', title: getMessage(locale, 'editor.conflict.acceptBoth') },
    ];
    const lenses: monaco.languages.CodeLens[] = [];
    for (const b of this.blocks) {
      for (const { choice, title } of actions) {
        lenses.push({
          range: new monaco.Range(b.start, 1, b.start, 1),
          command: {
            id: this.commandId,
            title,
            arguments: [{ startLine: b.start, choice }],
          },
        });
      }
    }
    return lenses;
  }

  /**
   * Apply a choice to the block whose `<<<<<<<` marker sits at `startLine`.
   * Blocks are re-scanned from the live text first, so a lens that survived an
   * edit can never splice the wrong lines.
   */
  private applyChoice(startLine: number, choice: ConflictChoice): void {
    const model = this.editor.getModel();
    if (!model || model.isDisposed()) return;
    const value = model.getValue();
    const block = findConflictBlocks(value).find((b) => b.start === startLine);
    if (!block) return;
    const lines = value.split('\n');
    const replacement = conflictChoiceLines(lines, block, choice).map((l) =>
      l.endsWith('\r') ? l.slice(0, -1) : l,
    );
    let range: monaco.Range;
    let text: string;
    if (replacement.length > 0) {
      // Replace the block's lines in place; surrounding newlines stay put.
      range = new monaco.Range(
        block.start,
        1,
        block.end,
        model.getLineMaxColumn(block.end),
      );
      text = replacement.join(model.getEOL());
    } else if (block.end < model.getLineCount()) {
      // Both sides empty: remove the block's lines including the trailing EOL.
      range = new monaco.Range(block.start, 1, block.end + 1, 1);
      text = '';
    } else if (block.start > 1) {
      // Block reaches EOF: consume the preceding EOL instead.
      range = new monaco.Range(
        block.start - 1,
        model.getLineMaxColumn(block.start - 1),
        block.end,
        model.getLineMaxColumn(block.end),
      );
      text = '';
    } else {
      range = new monaco.Range(1, 1, block.end, model.getLineMaxColumn(block.end));
      text = '';
    }
    this.editor.executeEdits('marudesk-conflict-aid', [
      { range, text, forceMoveMarkers: true },
    ]);
    this.refresh();
  }
}
