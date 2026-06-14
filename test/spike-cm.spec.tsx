// @vitest-environment happy-dom
// THROWAWAY SPIKE — delete after evaluating. Probes whether CodeMirror 6 can
// run inside happy-dom well enough to drive the unit tests. Each `it` isolates
// one capability so a failure on one doesn't hide the others.
import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";

function mount(doc: string) {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({ doc, parent, extensions: [markdown()] });
  return { view, parent };
}

describe("CM6 in happy-dom spike", () => {
  it("1. mounts an EditorView without throwing", () => {
    const { view } = mount("# hello");
    expect(view).toBeTruthy();
    expect(view.state.doc.toString()).toBe("# hello");
  });

  it("2. renders .cm-content / .cm-line DOM", () => {
    const { parent } = mount("# hello\n\nworld");
    expect(parent.querySelector(".cm-editor")).toBeTruthy();
    expect(parent.querySelector(".cm-content")).toBeTruthy();
    expect(parent.querySelectorAll(".cm-line").length).toBeGreaterThan(0);
  });

  it("3. fires an update listener on programmatic dispatch (the onChange seam)", () => {
    let seen = "";
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const view = new EditorView({
      doc: "start",
      parent,
      extensions: [
        EditorView.updateListener.of((u) => {
          if (u.docChanged) seen = u.state.doc.toString();
        }),
      ],
    });
    view.dispatch({ changes: { from: 0, insert: "X" } });
    expect(seen).toBe("Xstart");
    expect(view.state.doc.toString()).toBe("Xstart");
  });

  it("4. maps a caret offset to a source line (the #32 scroll-sync dependency)", () => {
    const { view } = mount("L0\nL1\nL2");
    // put the caret on the 3rd line
    const head = view.state.doc.toString().indexOf("L2") + 1;
    view.dispatch({ selection: { anchor: head } });
    const line = view.state.doc.lineAt(view.state.selection.main.head).number - 1;
    expect(line).toBe(2);
  });

  it("5. reflects a contenteditable input event back into state (simulated typing)", () => {
    const { view, parent } = mount("hi");
    const content = parent.querySelector(".cm-content") as HTMLElement;
    expect(content?.getAttribute("contenteditable")).toBeTruthy();
    // try the path real keystrokes take: mutate the DOM + fire beforeinput/input
    const before = view.state.doc.toString();
    content.dispatchEvent(
      new InputEvent("beforeinput", { inputType: "insertText", data: "!", bubbles: true })
    );
    // record whether CM observed it; don't assert — we want to SEE the result
    console.log("[spike] doc before:", JSON.stringify(before), "after:", JSON.stringify(view.state.doc.toString()));
  });
});
