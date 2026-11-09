import { memo, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type Preview = { url: string; title: string; description: string; site: string; image: string | null };
const cache = new Map<string, { value: Preview; until: number }>();
const pending = new Map<string, Promise<Preview>>();

function preview(url: string) {
  const hit = cache.get(url);
  if (hit && hit.until > Date.now()) { cache.delete(url); cache.set(url, hit); return Promise.resolve(hit.value); }
  const request = pending.get(url);
  if (request) return request;
  const promise = invoke<Preview>("teams_link_preview", { url }).then(value => {
    cache.delete(url); cache.set(url, { value, until: Date.now() + (value.title ? 3600_000 : 300_000) });
    let bytes = [...cache.values()].reduce((sum, item) => sum + (item.value.image?.length ?? 0), 0);
    while (cache.size > 48 || bytes > 8 * 1024 * 1024) {
      const key = cache.keys().next().value!;
      bytes -= cache.get(key)!.value.image?.length ?? 0; cache.delete(key);
    }
    return value;
  }).finally(() => pending.delete(url));
  pending.set(url, promise);
  return promise;
}

export default memo(function LinkPreview({ url, label, onOpen }: { url: string; label: string; onOpen: (url: string) => void }) {
  const container = useRef<HTMLAnchorElement>(null);
  const [visible, setVisible] = useState(false);
  const [data, setData] = useState<Preview | null>(null);
  const [imageFailed, setImageFailed] = useState(false);
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); }
    }, { root: element.closest('.teams-messages'), rootMargin: "100px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    void preview(url).then(value => { if (!cancelled) setData(value); }).catch(() => { /* Keep the original link card. */ });
    return () => { cancelled = true; };
  }, [url, visible]);
  const host = new URL(url).hostname;
  const image = data?.image && /^data:image\/(png|jpeg|gif|webp);base64,/.test(data.image) && !imageFailed ? data.image : null;
  return <a ref={container} className={`teams-link-preview${image ? " has-image" : ""}`} href={url} title={url}
    target="_blank" rel="noopener noreferrer" onDragStart={event => event.preventDefault()}
    onClick={event => { event.preventDefault(); onOpen(url); }}
    onAuxClick={event => { event.preventDefault(); if (event.button === 1) onOpen(url); }}>
    {image && <img src={image} alt="" onError={() => setImageFailed(true)} />}
    <span className="teams-preview-copy">
      <strong>{data?.title || label || host}</strong>
      {data?.description && <span className="teams-preview-description">{data.description}</span>}
      <span className="teams-preview-domain">{data?.site || host}</span>
    </span>
  </a>;
});
