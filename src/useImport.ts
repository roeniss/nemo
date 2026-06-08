import { type Memo, type MemoMeta, api, byRecent, titleFrom, CONTENT_CACHE } from "./lib";
import { kv } from "./idb";

// text file extensions — used alongside the MIME type and a NUL-byte sniff to keep binaries out
const TEXT_EXT =
  /\.(txt|text|md|markdown|mdown|csv|tsv|json|jsonc|log|ya?ml|toml|ini|conf|env|xml|html?|css|scss|js|mjs|cjs|jsx|ts|tsx|py|rb|go|rs|c|h|cc|cpp|hpp|java|kt|swift|php|sh|bash|zsh|sql|svg|diff|patch|gitignore)$/i;

type ImportDeps = {
  content: string;
  currentIdRef: { current: number | null };
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

// File import (picker + drag-drop) and folder upload both register each file as
// its own memo (filename → "# name" title heading), plus .md export.
export function useImport({ content, currentIdRef, flash, setMemos }: ImportDeps) {
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
  // unreadable / failed files are skipped and counted
  async function importFiles(files: File[], emptyMsg: string) {
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
    }
    if (created.length === 0) {
      flash(skipped ? "등록할 텍스트 파일이 없어요." : emptyMsg);
    } else {
      flash(`${created.length}개 문서를 등록했어요${skipped ? ` (${skipped}개 건너뜀)` : ""}.`);
    }
  }

  // file picker / drag-drop: each selected file becomes its own memo
  function importFile(files: FileList | File[] | null | undefined) {
    if (!files || files.length === 0) return;
    return importFiles(Array.from(files), "파일이 비어 있어요.");
  }

  // folder picker: each file directly inside the folder becomes its own memo.
  // Non-recursive — files in subfolders are skipped via webkitRelativePath depth.
  function importFolder(files: FileList | null | undefined) {
    if (!files || files.length === 0) return;
    // a webkitdirectory pick yields the whole tree; webkitRelativePath is
    // "folder/file" for direct children and "folder/sub/file" deeper — keep depth 2
    const direct = Array.from(files).filter((f) => {
      const rel = f.webkitRelativePath;
      return !rel || rel.split("/").length === 2;
    });
    return importFiles(direct, "폴더가 비어 있어요.");
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

  return { importFile, importFolder, downloadMemo };
}
