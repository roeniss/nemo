import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { EditorState, Annotation } from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  dropCursor,
  rectangularSelection,
  crosshairCursor,
  keymap,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { syntaxHighlighting, defaultHighlightStyle } from "@codemirror/language";

// imperative surface App.tsx drives the editor through — the CM replacement for
// the old textarea's .value / .selectionStart / focus()+setSelectionRange.
export interface EditorHandle {
  // insert text at the primary caret (replacing any selection), then drop the
  // caret just after it — routes through onChange so it autosaves like typing
  insertAtCursor(snippet: string): void;
  // 0-based source line of the primary caret, for the preview centering (#32)
  getCaretLine(): number;
  // focus the editor and put the caret at the very end (new-memo open)
  focusEnd(): void;
}

interface EditorProps {
  value: string;
  onChange: (value: string) => void;
  onCaret?: () => void; // primary selection moved — re-center the preview
  // paste/drop handled on the host wrapper in the capture phase, so they run
  // before CM; calling preventDefault makes CM skip its own default handling.
  onPaste?: (e: ClipboardEvent) => void;
  onDrop?: (e: DragEvent) => void;
  className?: string;
}

// marks doc replacements we push in to mirror an external `value` change (memo
// switch, setContent) so the update listener doesn't echo them back as edits.
const External = Annotation.define<boolean>();

const Editor = forwardRef<EditorHandle, EditorProps>(function Editor(props, ref) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  // latest props, read by the once-built CM extensions to dodge stale closures
  const cb = useRef(props);
  cb.current = props;

  // mount the EditorView once; rebuilding it would lose history and selection
  useEffect(() => {
    const view = new EditorView({
      doc: cb.current.value,
      parent: hostRef.current!,
      extensions: [
        history(),
        drawSelection(), // renders every caret/selection (the browser draws one)
        dropCursor(),
        rectangularSelection(), // alt-drag → a cursor per line
        crosshairCursor(),
        EditorState.allowMultipleSelections.of(true),
        EditorView.lineWrapping, // prose wraps, like the old textarea
        markdown(),
        syntaxHighlighting(defaultHighlightStyle),
        // defaultKeymap brings alt-click and Mod-Alt-Arrow add-cursor gestures
        keymap.of([...defaultKeymap, ...historyKeymap]),
        EditorView.updateListener.of((u) => {
          const external = u.transactions.some((t) => t.annotation(External));
          if (u.docChanged && !external) cb.current.onChange(u.state.doc.toString());
          if (u.selectionSet || u.docChanged) cb.current.onCaret?.();
        }),
      ],
    });
    viewRef.current = view;
    // expose the view on its root element so e2e (and debugging) can drive the
    // editor directly — e.g. place the caret in a long, virtualized document
    // where the target line isn't rendered in the DOM. No behavioral effect.
    (view.dom as unknown as { cmView: EditorView }).cmView = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  // mirror an external value change into the doc without echoing it back as an
  // edit; our own edits arrive here with value already equal, so they no-op
  useEffect(() => {
    const view = viewRef.current;
    /* v8 ignore next */
    if (!view) return;
    const cur = view.state.doc.toString();
    if (cur !== props.value) {
      view.dispatch({
        changes: { from: 0, to: cur.length, insert: props.value },
        annotations: External.of(true),
      });
    }
  }, [props.value]);

  useImperativeHandle(
    ref,
    (): EditorHandle => ({
      insertAtCursor(snippet) {
        const view = viewRef.current;
        /* v8 ignore next */
        if (!view) return;
        const sel = view.state.selection.main;
        view.dispatch({
          changes: { from: sel.from, to: sel.to, insert: snippet },
          selection: { anchor: sel.from + snippet.length },
        });
        view.focus();
      },
      getCaretLine() {
        const view = viewRef.current;
        /* v8 ignore next */
        if (!view) return 0;
        return view.state.doc.lineAt(view.state.selection.main.head).number - 1;
      },
      focusEnd() {
        const view = viewRef.current;
        /* v8 ignore next */
        if (!view) return;
        view.dispatch({ selection: { anchor: view.state.doc.length } });
        view.focus();
      },
    }),
    []
  );

  // paste/drop ride the host's capture phase so they fire before CM's own
  // handlers on the inner contentDOM; the handlers preventDefault to suppress
  // CM's default text-paste / drop when they take over.
  return (
    <div
      ref={hostRef}
      className={props.className}
      onPasteCapture={(e) => props.onPaste?.(e as unknown as ClipboardEvent)}
      onDropCapture={(e) => props.onDrop?.(e as unknown as DragEvent)}
      onDragOverCapture={(e) => {
        const dt = (e as unknown as DragEvent).dataTransfer;
        if (dt?.types?.includes("Files")) e.preventDefault(); // allow the drop
      }}
    />
  );
});

export default Editor;
