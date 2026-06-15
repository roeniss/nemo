import { useEffect, useMemo, useRef, useState } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { PREVIEW_DEBOUNCE } from "./lib";

marked.setOptions({ gfm: true, breaks: true });

// transient bottom toast (import status, etc.)
export function useToast() {
  const [notice, setNotice] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function flash(msg: string) {
    setNotice(msg);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setNotice(null), 3000);
  }
  return { notice, flash };
}

// Render markdown, tagging each top-level block with its 0-based source line
// (data-source-line) so the preview can be scrolled to follow the editor caret.
// We render block-by-block to know each block's line, threading the shared link
// definitions through so reference-style links still resolve.
function renderWithLines(src: string): string {
  const tokens = marked.lexer(src);
  let line = 0;
  let out = "";
  for (const tok of tokens) {
    const one = [tok] as ReturnType<typeof marked.lexer>;
    one.links = tokens.links;
    // tag the block's opening tag; "space"/empty tokens render to "" and just
    // advance the line counter.
    out += marked.parser(one).replace(/^(\s*)<([a-zA-Z][\w-]*)/, `$1<$2 data-source-line="${line}"`);
    line += (tok.raw.match(/\n/g) || []).length;
  }
  return out;
}

// live markdown preview, debounced so marked+DOMPurify don't run on every keystroke.
// Returns sanitized html.
export function usePreview(content: string) {
  const [src, setSrc] = useState(content);
  useEffect(() => {
    const t = setTimeout(() => setSrc(content), PREVIEW_DEBOUNCE);
    return () => clearTimeout(t);
  }, [content]);
  const html = useMemo(
    () => DOMPurify.sanitize(renderWithLines(src), { ADD_TAGS: ["input"], ADD_ATTR: ["type", "checked", "disabled"] }),
    [src]
  );
  return { html };
}
