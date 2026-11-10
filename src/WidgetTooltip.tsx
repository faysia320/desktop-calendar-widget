import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "./WidgetTooltip.css";

// Browser title tooltips live in a separate native window. Keep these hints in
// the WebView's CSS coordinates so desktop parenting / monitor DPI cannot move
// them onto a different display.
export default function WidgetTooltip() {
  const id = useId();
  const popup = useRef<HTMLDivElement>(null);
  const [hint, setHint] = useState<{ element: HTMLElement; text: string } | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let target: HTMLElement | null = null;
    const cancelTimer = () => { clearTimeout(timer); timer = undefined; };
    const dismiss = () => { cancelTimer(); target = null; setHint(null); setPosition(null); };
    const find = (node: EventTarget | null) => node instanceof Element ? node.closest<HTMLElement>("[data-tooltip]") : null;
    const show = (element: HTMLElement | null, delay: number) => {
      cancelTimer();
      if (!element?.dataset.tooltip) { dismiss(); return; }
      target = element; setHint(null); setPosition(null);
      timer = setTimeout(() => {
        if (element.isConnected && element.dataset.tooltip) setHint({ element, text: element.dataset.tooltip });
      }, delay);
    };
    const over = (event: PointerEvent) => {
      if (event.pointerType === "touch" || event.buttons) return;
      if (popup.current?.contains(event.target as Node)) { cancelTimer(); return; }
      const element = find(event.target);
      if (!element || (event.relatedTarget instanceof Node && element.contains(event.relatedTarget))) return;
      show(element, 450);
    };
    const out = (event: PointerEvent) => {
      if (event.relatedTarget instanceof Node && (target?.contains(event.relatedTarget) || popup.current?.contains(event.relatedTarget))) return;
      cancelTimer(); timer = setTimeout(dismiss, 120);
    };
    const focus = (event: FocusEvent) => {
      const element = find(event.target);
      if (element?.matches(":focus-visible")) show(element, 0);
    };
    const scroll = (event: Event) => { if (!popup.current?.contains(event.target as Node)) dismiss(); };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") dismiss(); };
    document.addEventListener("pointerover", over, true);
    document.addEventListener("pointerout", out, true);
    document.addEventListener("pointerdown", dismiss, true);
    document.addEventListener("focusin", focus, true);
    document.addEventListener("focusout", dismiss, true);
    document.addEventListener("keydown", key, true);
    document.addEventListener("scroll", scroll, true);
    window.addEventListener("blur", dismiss);
    window.addEventListener("resize", dismiss);
    return () => {
      cancelTimer();
      document.removeEventListener("pointerover", over, true);
      document.removeEventListener("pointerout", out, true);
      document.removeEventListener("pointerdown", dismiss, true);
      document.removeEventListener("focusin", focus, true);
      document.removeEventListener("focusout", dismiss, true);
      document.removeEventListener("keydown", key, true);
      document.removeEventListener("scroll", scroll, true);
      window.removeEventListener("blur", dismiss);
      window.removeEventListener("resize", dismiss);
    };
  }, []);

  useLayoutEffect(() => {
    if (!hint || !popup.current) return;
    const anchor = hint.element.getBoundingClientRect();
    const rect = popup.current.getBoundingClientRect();
    const below = anchor.bottom + 6;
    setPosition({
      left: Math.max(8, Math.min(anchor.left, window.innerWidth - rect.width - 8)),
      top: Math.max(8, Math.min(below + rect.height <= window.innerHeight - 8 ? below : anchor.top - rect.height - 6,
        window.innerHeight - rect.height - 8)),
    });
    const previous = hint.element.getAttribute("aria-describedby");
    hint.element.setAttribute("aria-describedby", [previous, id].filter(Boolean).join(" "));
    return () => {
      const remaining = hint.element.getAttribute("aria-describedby")?.split(/\s+/).filter(value => value !== id).join(" ");
      if (remaining) hint.element.setAttribute("aria-describedby", remaining);
      else hint.element.removeAttribute("aria-describedby");
    };
  }, [hint, id]);

  return hint && createPortal(<div id={id} ref={popup} className="widget-tooltip" role="tooltip"
    style={{ ...position, visibility: position ? "visible" : "hidden" }}>{hint.text}</div>, document.body);
}
