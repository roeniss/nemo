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

// live markdown preview, debounced so marked+DOMPurify don't run on every keystroke.
// Returns sanitized html.
export function usePreview(content: string) {
  const [src, setSrc] = useState(content);
  useEffect(() => {
    const t = setTimeout(() => setSrc(content), PREVIEW_DEBOUNCE);
    return () => clearTimeout(t);
  }, [content]);
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(src) as string), [src]);
  return { html };
}
