import { useState } from "react";
import { type Memo, type MemoMeta, api, byRecent, isBlank, titleFrom, CONTENT_CACHE } from "./lib";
import { kv } from "./idb";

// text file extensions — used alongside the MIME type and a NUL-byte sniff to keep binaries out
const TEXT_EXT =
  /\.(txt|text|md|markdown|mdown|csv|tsv|json|jsonc|log|ya?ml|toml|ini|conf|env|xml|html?|css|scss|js|mjs|cjs|jsx|ts|tsx|py|rb|go|rs|c|h|cc|cpp|hpp|java|kt|swift|php|sh|bash|zsh|sql|svg|diff|patch|gitignore)$/i;
const IMPORT_CONFIRM_BYTES = 100 * 1024; // ask before loading a file this big into the body

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

// Text-file import (picker + drag-drop, with a large-file confirmation) and .md export.
export function useImport({ content, currentIdRef, editorRef, onEdit, flash, setMemos }: ImportDeps) {
  const [pendingImport, setPendingImport] = useState<{ text: string; name: string; size: number } | null>(null);

  // load imported text: into a blank memo it becomes the body with the file name as the
  // title heading ("# tmp.txt"); otherwise it's inserted at the cursor
  function applyImport(text: string, name: string) {
    const el = editorRef.current;
    const blank = isBlank(content);
    let next: string;
    let caret: number;
    if (blank) {
      next = `# ${name}\n\n${text}`;
      caret = next.length;
    } else {
      const start = el ? el.selectionStart : content.length;
      const end = el ? el.selectionEnd : content.length;
      next = content.slice(0, start) + text + content.slice(end);
      caret = start + text.length;
    }
    onEdit(next); // same path as typing → autosave + local persistence
    requestAnimationFrame(() => {
      const e2 = editorRef.current;
      if (e2) {
        e2.focus();
        e2.setSelectionRange(caret, caret);
      }
    });
    const size = text.length < 1024 ? `${text.length} B` : `${Math.round(text.length / 1024)} KB`;
    flash(`Imported "${name}" (${size})`);
  }

  // files over IMPORT_CONFIRM_BYTES are held behind a confirmation (pendingImport → confirmImport)
  async function importFile(file: File | null | undefined) {
    if (!file) return;
    let text: string;
    try {
      text = await file.text();
    } catch {
      flash("파일을 읽지 못했어요.");
      return;
    }
    if (!looksImportable(file, text)) {
      flash("텍스트 파일만 업로드할 수 있어요.");
      return;
    }
    if (currentIdRef.current == null) return; // a memo is always open (new-doc default)
    if (file.size > IMPORT_CONFIRM_BYTES) {
      setPendingImport({ text, name: file.name, size: file.size });
      return;
    }
    applyImport(text, file.name);
  }

  // upload a whole folder: register each file directly inside it as its own memo
  // (filename → "# name" title heading). Non-recursive — files in subfolders are
  // skipped via webkitRelativePath depth; binaries / unreadable files are skipped
  // too, and the totals are surfaced in a summary toast.
  async function importFolder(files: FileList | null | undefined) {
    if (!files || files.length === 0) return;
    // a webkitdirectory pick yields the whole tree; webkitRelativePath is
    // "folder/file" for direct children and "folder/sub/file" deeper — keep depth 2
    const direct = Array.from(files).filter((f) => {
      const rel = f.webkitRelativePath;
      return !rel || rel.split("/").length === 2;
    });
    let added = 0;
    let skipped = 0;
    const created: MemoMeta[] = [];
    for (const file of direct) {
      let text: string;
      try {
        text = await file.text();
      } catch {
        skipped++;
        continue;
      }
      if (!looksImportable(file, text)) {
        skipped++;
        continue;
      }
      const body = `# ${file.name}\n\n${text}`;
      try {
        const memo = (await (await api("/memos", { method: "POST" })).json()) as Memo;
        const r = await api(`/memos/${memo.id}`, { method: "PUT", body: JSON.stringify({ content: body }) });
        const { title, updated_at } = (await r.json()) as { title: string; updated_at: number };
        kv.set(CONTENT_CACHE + memo.id, body); // cache for offline read
        created.push({ id: memo.id, title, updated_at });
        added++;
      } catch {
        skipped++; // offline / server error — count it and keep going
      }
    }
    if (created.length) {
      setMemos((m) =>
        [...created, ...m.filter((x) => !created.some((c) => c.id === x.id))].sort(byRecent)
      );
    }
    if (added === 0) {
      flash(skipped ? "등록할 텍스트 파일이 없어요." : "폴더가 비어 있어요.");
    } else {
      flash(`${added}개 문서를 등록했어요${skipped ? ` (${skipped}개 건너뜀)` : ""}.`);
    }
  }

  function confirmImport() {
    if (!pendingImport) return;
    const { text, name } = pendingImport;
    setPendingImport(null);
    applyImport(text, name);
  }

  function cancelImport() {
    setPendingImport(null);
    flash("가져오기 취소됨");
  }

  // download the current memo as a .md file (named after its title)
  function downloadMemo() {
    if (currentIdRef.current == null) return;
    const name = (titleFrom(content) || "memo").replace(/[\/\\:*?"<>|]/g, "_").slice(0, 80);
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

  return {
    pendingImport,
    importFile,
    importFolder,
    confirmImport,
    cancelImport,
    downloadMemo,
    resetImport: () => setPendingImport(null),
  };
}
