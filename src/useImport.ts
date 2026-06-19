import { type Memo, type MemoMeta, api, byRecent, titleFrom, CONTENT_CACHE } from "./lib";
import { kv } from "./idb";

// text file extensions — used alongside the MIME type and a NUL-byte sniff to keep binaries out
const TEXT_EXT =
  /\.(txt|text|md|markdown|mdown|csv|tsv|json|jsonc|log|ya?ml|toml|ini|conf|env|xml|html?|css|scss|js|mjs|cjs|jsx|ts|tsx|py|rb|go|rs|c|h|cc|cpp|hpp|java|kt|swift|php|sh|bash|zsh|sql|svg|diff|patch|gitignore)$/i;
const IMAGE_MAX_BYTES = 1024 * 1024; // 1 MB — paste a larger image and we reject it (base64 bloats it ~33%)

type ImportDeps = {
  content: string;
  currentIdRef: { current: number | null };
  editorRef: { current: HTMLTextAreaElement | null };
  onEdit: (value: string) => void;
  flash: (msg: string) => void;
  setMemos: (updater: (m: MemoMeta[]) => MemoMeta[]) => void;
};

// does this file look like text we can turn into a memo? (MIME + extension hint,
// confirmed by a NUL-byte sniff on the decoded contents)
function looksImportable(file: File, text: string): boolean {
  const looksText =
    file.type.startsWith("text/") ||
    file.type === "application/json" ||
    file.type === "image/svg+xml" ||
    file.type === "" || // many text files report no MIME
    TEXT_EXT.test(file.name);
  return looksText && !text.includes("\u0000");
}

// File import (picker + drag-drop) registers each file as its own memo
// (filename → "# name" title heading); cmd+v embeds a pasted image inline as
// base64; plus .md export.
export function useImport({ content, currentIdRef, editorRef, onEdit, flash, setMemos }: ImportDeps) {
  // turn one text file into a new memo on the server; returns its meta, or null
  // if the file is a binary / unreadable / the request failed (caller tallies it)
  async function createMemo(file: File): Promise<MemoMeta | null> {
    let text: string;
    try {
      text = await file.text();
    } catch {
      return null;
    }
    if (!looksImportable(file, text)) return null;
    const body = `# ${file.name}\n\n${text}`;
    try {
      const memo = (await (await api("/memos", { method: "POST" })).json()) as Memo;
      const r = await api(`/memos/${memo.id}`, { method: "PUT", body: JSON.stringify({ content: body }) });
      const { title, updated_at } = (await r.json()) as { title: string; updated_at: number };
      kv.set(CONTENT_CACHE + memo.id, body); // cache for offline read
      return { id: memo.id, title, updated_at };
    } catch {
      return null; // offline / server error
    }
  }

  // register a batch of files as new memos and surface a summary toast; binaries /
  // unreadable / failed files are skipped and counted. Callers guard against an
  // empty list, so an empty `created` here always means everything was skipped.
  async function importFiles(files: File[]) {
    const created: MemoMeta[] = [];
    let skipped = 0;
    for (const file of files) {
      const meta = await createMemo(file);
      if (meta) created.push(meta);
      else skipped++;
    }
    if (created.length) {
      setMemos((m) =>
        [...created, ...m.filter((x) => !created.some((c) => c.id === x.id))].sort(byRecent)
      );
      flash(`${created.length}개 문서를 등록했어요${skipped ? ` (${skipped}개 건너뜀)` : ""}.`);
    } else {
      flash("등록할 텍스트 파일이 없어요.");
    }
  }

  // file picker / drag-drop: each selected file becomes its own memo
  function importFile(files: FileList | File[] | null | undefined) {
    if (!files || files.length === 0) return;
    return importFiles(Array.from(files));
  }

  // pull the first image out of a clipboard payload — covers both files
  // (Finder-copied images, most screenshot pastes) and the items fallback
  function firstImage(data: DataTransfer): File | null {
    for (const f of Array.from(data.files)) if (f.type.startsWith("image/")) return f;
    for (const it of Array.from(data.items)) {
      if (it.kind === "file" && it.type.startsWith("image/")) {
        const f = it.getAsFile();
        if (f) return f;
      }
    }
    return null;
  }

  // insert a snippet at the editor caret, routed through onEdit so it autosaves
  // exactly like typing; restore the caret just after the inserted text. Reads
  // the live textarea value (source of truth) so a stale closure can't clobber edits.
  function insertAtCursor(snippet: string) {
    const el = editorRef.current;
    const base = el ? el.value : content;
    const start = el ? el.selectionStart : base.length;
    const end = el ? el.selectionEnd : base.length;
    const next = base.slice(0, start) + snippet + base.slice(end);
    const caret = start + snippet.length;
    onEdit(next);
    requestAnimationFrame(() => {
      const e2 = editorRef.current;
      if (e2) {
        e2.focus();
        e2.setSelectionRange(caret, caret);
      }
    });
  }

  // cmd+v of an image: size-check, then base64-encode and embed it at the caret
  // as a markdown image (![name](data:...)). Returns true when it handled the
  // paste (so the caller can preventDefault); false lets normal text paste run.
  function pasteImage(data: DataTransfer | null | undefined): boolean {
    if (!data) return false;
    const file = firstImage(data);
    if (!file) return false; // not an image paste — leave it to the browser
    if (file.size > IMAGE_MAX_BYTES) {
      flash(`이미지가 너무 커요 (${Math.round(file.size / 1024)} KB) — 1MB 이하만 첨부할 수 있어요.`);
      return true;
    }
    const reader = new FileReader();
    reader.onload = () => {
      insertAtCursor(`![${file.name || "image"}](${reader.result as string})`);
      flash(`이미지를 첨부했어요 (${Math.round(file.size / 1024)} KB).`);
    };
    reader.onerror = () => flash("이미지를 읽지 못했어요.");
    reader.readAsDataURL(file);
    return true;
  }

  // download the current memo as a .md file (named after its title)
  function downloadMemo() {
    if (currentIdRef.current == null) return;
    const name = titleFrom(content).replace(/[\/\\:*?"<>|]/g, "_").slice(0, 80);
    const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${name}.md`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  return { importFile, pasteImage, downloadMemo };
}
