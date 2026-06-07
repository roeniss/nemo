import { useEffect, useMemo, useRef, useState } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { PREVIEW_DEBOUNCE, PREVIEW_MAX } from "./lib";

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

// live markdown preview, debounced so marked+DOMPurify don't run on every keystroke,
// and skipped entirely for very large documents (rendering a 600KB+ blob per edit janks
// typing). Returns sanitized html plus a too-big flag for the placeholder.
export function usePreview(content: string) {
  const [src, setSrc] = useState(content);
  useEffect(() => {
    const t = setTimeout(() => setSrc(content), PREVIEW_DEBOUNCE);
    return () => clearTimeout(t);
  }, [content]);
  const tooBig = src.length > PREVIEW_MAX;
  const html = useMemo(
    () => (tooBig ? "" : DOMPurify.sanitize(marked.parse(src) as string)),
    [src, tooBig]
  );
  return { html, tooBig, size: src.length };
}
