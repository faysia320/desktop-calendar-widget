import { memo, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";

const cache = new Map<string, string>();
const pending = new Map<string, Promise<string>>();
const queue: (() => void)[] = [];
let running = 0;

function next() {
  while (running < 2 && queue.length) { running++; queue.shift()!(); }
}

function load(teamId: string, channelId: string, chatId: string | null, url: string) {
  const hit = cache.get(url);
  if (hit) { cache.delete(url); cache.set(url, hit); return Promise.resolve(hit); }
  const request = pending.get(url);
  if (request) return request;
  const promise = new Promise<string>((resolve, reject) => {
    queue.push(() => invoke<string>("teams_hosted_image", { teamId, channelId, chatId, url }).then(resolve, reject)
      .finally(() => { running--; next(); }));
    next();
  }).then(value => {
    cache.set(url, value);
    let bytes = [...cache.values()].reduce((sum, item) => sum + item.length, 0);
    while (cache.size > 64 || bytes > 32 * 1024 * 1024) {
      const key = cache.keys().next().value!;
      bytes -= cache.get(key)!.length; cache.delete(key);
    }
    return value;
  }).finally(() => pending.delete(url));
  pending.set(url, promise);
  return promise;
}

function ImageViewer({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  const [actual, setActual] = useState(false);
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    close.current?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return createPortal(<div className={`teams-image-viewer${actual ? " actual" : ""}`} role="dialog" aria-modal="true" aria-label={alt || "이미지"}
    onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <button ref={close} className="teams-image-viewer-close" aria-label="닫기" data-tooltip="닫기 (Esc)" onClick={onClose}>×</button>
    <img src={src} alt={alt} draggable={false} data-tooltip={actual ? "화면에 맞추기" : "원본 크기"} onClick={() => setActual(value => !value)} />
  </div>, document.body);
}

// Teams inline images need the Graph token, so the native side fetches them as data URLs.
export default memo(function HostedImage({ teamId, channelId, chatId, url, alt, width, height }:
  { teamId: string; channelId: string; chatId: string | null; url: string; alt: string; width?: number; height?: number }) {
  const container = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  const [src, setSrc] = useState(() => cache.get(url) ?? null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const element = container.current;
    if (!element || src) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); }
    }, { root: element.closest(".teams-messages"), rootMargin: "200px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, [src]);
  useEffect(() => {
    if (!visible || src) return;
    let cancelled = false;
    void load(teamId, channelId, chatId, url).then(value => { if (!cancelled) setSrc(value); }).catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [teamId, channelId, chatId, url, visible, src]);
  const label = alt || "이미지";
  const valid = src && /^data:image\/(png|jpeg|gif|webp);base64,/.test(src);
  if (failed) return <span className="teams-inline-image-missing">[{label}]</span>;
  // Reserve the final size so loading images don't move the reading position.
  const style = width && height ? { width: `min(${width}px, 100%)`, aspectRatio: `${width} / ${height}` } : undefined;
  return <span ref={container} className={`teams-inline-image${valid ? "" : " loading"}`} style={style}>
    {valid ? <button className="teams-inline-image-open" aria-label={`${label} 크게 보기`} onClick={() => setOpen(true)}>
      <img src={src} alt={alt} draggable={false} onError={() => setFailed(true)} /></button>
      : <span aria-label={`${label} 불러오는 중`} />}
    {open && valid && <ImageViewer src={src} alt={alt} onClose={() => setOpen(false)} />}
  </span>;
});
