import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import type { TeamsChannel } from "./teams";

export const NEWS_TAB_ID = "builtin:geeknews";
type Drag = { id: string; pointer: number; startX: number; startY: number; x: number; y: number; moving: boolean };
type Menu = { id: string; name: string; x: number; y: number };

export default function ChannelTabs({ channels, activeId, disabled, unread, onSelect, onReorder, onClose }: {
  channels: TeamsChannel[]; activeId: string; disabled: boolean;
  unread: (id: string) => boolean;
  onSelect: (id: string) => void;
  onReorder: (channels: TeamsChannel[]) => void;
  onClose: (id: string) => Promise<void>;
}) {
  const bar = useRef<HTMLDivElement>(null);
  const menuElement = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const suppressClick = useRef(false);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);

  function tab(id: string) {
    return [...bar.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? []]
      .find(element => element.dataset.channelId === id);
  }
  function cancelDrag() { drag.current = null; setDraggedId(null); setDropIndex(null); }
  function destination(current: Drag) {
    const bounds = bar.current!.getBoundingClientRect();
    if (current.y < bounds.top - 20 || current.y > bounds.bottom + 20 || current.x < bounds.left - 24 || current.x > bounds.right + 24) return null;
    const remaining = channels.filter(channel => channel.id !== current.id);
    const index = remaining.findIndex(channel => {
      const rect = tab(channel.id)?.getBoundingClientRect();
      return rect && current.x < rect.left + rect.width / 2;
    });
    return index < 0 ? remaining.length : index;
  }

  useEffect(() => {
    if (!draggedId) return;
    let frame: number;
    const scroll = () => {
      const current = drag.current, element = bar.current;
      if (current && element) {
        const bounds = element.getBoundingClientRect();
        if (current.y >= bounds.top - 20 && current.y <= bounds.bottom + 20) {
          const speed = current.x < bounds.left + 32 ? -8 : current.x > bounds.right - 32 ? 8 : 0;
          if (speed) { element.scrollLeft += speed; setDropIndex(destination(current)); }
        }
      }
      frame = requestAnimationFrame(scroll);
    };
    frame = requestAnimationFrame(scroll);
    const escape = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape") cancelDrag(); };
    window.addEventListener("keydown", escape);
    window.addEventListener("blur", cancelDrag);
    return () => { cancelAnimationFrame(frame); window.removeEventListener("keydown", escape); window.removeEventListener("blur", cancelDrag); };
  }, [draggedId, channels]);

  useLayoutEffect(() => {
    if (!menu || !menuElement.current) return;
    const element = menuElement.current;
    const rect = element.getBoundingClientRect();
    element.style.left = `${Math.max(8, Math.min(menu.x, window.innerWidth - rect.width - 8))}px`;
    element.style.top = `${Math.max(8, Math.min(menu.y, window.innerHeight - rect.height - 8))}px`;
    element.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
  }, [menu]);
  useEffect(() => {
    if (!menu) return;
    const dismiss = () => setMenu(null);
    const outside = (event: globalThis.PointerEvent) => { if (!menuElement.current?.contains(event.target as Node)) dismiss(); };
    const key = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); dismiss(); tab(menu.id)?.focus({ preventScroll: true }); }
      if (event.key === "Tab") dismiss();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", key);
    window.addEventListener("blur", dismiss);
    window.addEventListener("resize", dismiss);
    document.addEventListener("scroll", dismiss, true);
    return () => {
      document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", key);
      window.removeEventListener("blur", dismiss); window.removeEventListener("resize", dismiss);
      document.removeEventListener("scroll", dismiss, true);
    };
  }, [menu]);

  function start(event: PointerEvent<HTMLButtonElement>, id: string) {
    if (disabled || event.button !== 0 || !event.isPrimary) return;
    setMenu(null); suppressClick.current = false;
    drag.current = { id, pointer: event.pointerId, startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY, moving: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function move(event: PointerEvent<HTMLButtonElement>) {
    const current = drag.current;
    if (!current || current.pointer !== event.pointerId) return;
    current.x = event.clientX; current.y = event.clientY;
    if (!current.moving && Math.hypot(current.x - current.startX, current.y - current.startY) < 6) return;
    current.moving = true; suppressClick.current = true;
    event.preventDefault(); setDraggedId(current.id); setDropIndex(destination(current));
  }
  function finish(event: PointerEvent<HTMLButtonElement>) {
    const current = drag.current;
    if (!current || current.pointer !== event.pointerId) return;
    current.x = event.clientX; current.y = event.clientY;
    const index = current.moving ? destination(current) : null;
    cancelDrag();
    if (index === null || disabled) return;
    const source = channels.find(channel => channel.id === current.id);
    if (!source) return;
    const next = channels.filter(channel => channel.id !== current.id);
    next.splice(index, 0, source);
    if (next.some((channel, i) => channel.id !== channels[i].id)) onReorder(next);
  }
  function keyboard(event: KeyboardEvent<HTMLButtonElement>, index: number, channel?: TeamsChannel) {
    if (channel && (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))) {
      event.preventDefault(); const rect = event.currentTarget.getBoundingClientRect();
      setMenu({ id: channel.id, name: channel.name, x: rect.left, y: rect.bottom }); return;
    }
    const ids = [NEWS_TAB_ID, ...channels.map(channel => channel.id)];
    let next = index;
    if (event.key === "ArrowRight") next = (index + 1) % ids.length;
    else if (event.key === "ArrowLeft") next = (index + ids.length - 1) % ids.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = ids.length - 1;
    else return;
    event.preventDefault(); onSelect(ids[next]); tab(ids[next])?.focus();
  }
  const remaining = channels.filter(channel => channel.id !== draggedId);
  const before = dropIndex === null ? null : remaining[dropIndex]?.id;
  const after = dropIndex === remaining.length ? remaining[remaining.length - 1]?.id : null;

  return <>
    <div className="teams-tabs" role="tablist" aria-label="Teams 채널" ref={bar}>
      <div className={`teams-tab teams-tab-fixed${activeId === NEWS_TAB_ID ? " active" : ""}`}>
        <button role="tab" id="geeknews-tab" data-channel-id={NEWS_TAB_ID} aria-selected={activeId === NEWS_TAB_ID} aria-controls="teams-news-view"
          tabIndex={activeId === NEWS_TAB_ID ? 0 : -1} title="GeekNews · 고정 채널" disabled={disabled}
          onClick={() => onSelect(NEWS_TAB_ID)} onKeyDown={event => keyboard(event, 0)}>
          <span aria-hidden="true">N</span> GeekNews <span className="teams-fixed-label">고정</span>
        </button>
      </div>
      {channels.map((channel, index) => <div key={channel.id}
        className={`teams-tab${activeId === channel.id ? " active" : ""}${draggedId === channel.id ? " dragging" : ""}${before === channel.id ? " drop-before" : ""}${after === channel.id ? " drop-after" : ""}`}>
        <button role="tab" data-channel-id={channel.id} aria-selected={activeId === channel.id} aria-controls="teams-conversation"
          tabIndex={activeId === channel.id ? 0 : -1} disabled={disabled}
          title={`${channel.name}${unread(channel.id) ? " · 위젯에서 미확인 메시지 있음" : ""} · 드래그로 순서 이동 · 우클릭으로 닫기`}
          aria-label={`${channel.name}${unread(channel.id) ? ", 미확인 메시지 있음" : ""}`} aria-haspopup="menu"
          onClick={event => { if (suppressClick.current && event.detail !== 0) { suppressClick.current = false; return; } onSelect(channel.id); }}
          onKeyDown={event => keyboard(event, index + 1, channel)}
          onPointerDown={event => start(event, channel.id)} onPointerMove={move} onPointerUp={finish}
          onPointerCancel={cancelDrag} onLostPointerCapture={cancelDrag} onDragStart={event => event.preventDefault()}
          onContextMenu={event => { event.preventDefault(); cancelDrag(); if (!disabled) setMenu({ id: channel.id, name: channel.name, x: event.clientX, y: event.clientY }); }}>
          <span>#</span> {channel.name}{unread(channel.id) && <span className="teams-unread-dot" aria-hidden="true" />}
        </button>
      </div>)}
    </div>
    {menu && createPortal(<div ref={menuElement} className="teams-tab-menu" role="menu" aria-label={`${menu.name} 채널 메뉴`}
      style={{ left: menu.x, top: menu.y }} onContextMenu={event => event.preventDefault()}>
      <button type="button" role="menuitem" disabled={disabled} onClick={async () => {
        const id = menu.id; setMenu(null); await onClose(id);
        bar.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus({ preventScroll: true });
      }}>채널 닫기</button>
    </div>, document.body)}
  </>;
}
