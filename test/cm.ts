// Helpers for driving the CodeMirror editor in unit tests. happy-dom can't
// process real keystrokes into a contenteditable (CM's DOM observer never sees
// them), so tests drive the editor the way the app does: by dispatching to the
// live EditorView, which fires the update listener → onChange, just like typing.
import { EditorView } from "@codemirror/view";

// the mounted editor element (null when no memo is open / the editor is hidden)
export function editorEl(scope: ParentNode): HTMLElement | null {
  return scope.querySelector<HTMLElement>(".cm-editor");
}

// the contenteditable surface — paste/drop events are fired here in tests
export function editorContent(scope: ParentNode): HTMLElement {
  const el = scope.querySelector<HTMLElement>(".cm-content");
  if (!el) throw new Error("CM editor not mounted");
  return el;
}

function view(scope: ParentNode): EditorView {
  const dom = editorEl(scope);
  const v = dom && EditorView.findFromDOM(dom);
  if (!v) throw new Error("CM editor not mounted");
  return v;
}

// current editor text. Throws when the editor isn't mounted — mirroring the old
// `(querySelector("textarea.editor") as HTMLTextAreaElement).value`, which threw
// on a null element. This keeps assertions honest: a `.toBe("")`/`.toBe(before)`
// can't pass vacuously because the editor failed to mount (it would throw), and
// inside waitFor a throw simply retries until the editor is up. An empty string
// is only ever returned for a genuinely-mounted, empty document.
export function editorValue(scope: ParentNode): string {
  return view(scope).state.doc.toString();
}

// replace the whole document (the unit-test stand-in for typing a new value)
export function setEditor(scope: ParentNode, text: string): void {
  const v = view(scope);
  v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text } });
}

// move the primary caret to an absolute offset (for the preview-centering tests)
export function caretAt(scope: ParentNode, pos: number): void {
  const v = view(scope);
  v.dispatch({ selection: { anchor: pos } });
}
