import { useEffect, useState, type CSSProperties, type RefObject } from "react";
import { createPortal } from "react-dom";
import { compareEvents, occursOn, type CalendarEvent } from "./events";

type Cell = { day: string; element: HTMLElement; width: number; height: number; heading: number };

// Keep the month grid fixed. Each date chooses titles or individual dots based
// on its actual available space, including six-week months and window resizing.
export default function CalendarDayEvents({ root, events, onHover, onOpen }: {
  root: RefObject<HTMLDivElement | null>; events: CalendarEvent[];
  onHover: (value: { event: CalendarEvent; anchor: DOMRect } | null) => void;
  onOpen: (event: CalendarEvent, day: string) => void;
}) {
  const [cells, setCells] = useState<Cell[]>([]);
  useEffect(() => {
    if (!root.current) return;
    let frame = 0;
    const observed = new Set<HTMLElement>();
    const measure = () => {
      const next = [...root.current!.querySelectorAll<HTMLElement>('.fc-daygrid-day[data-date]')].flatMap(cell => {
        const element = cell.querySelector<HTMLElement>('.fc-daygrid-day-frame');
        if (!element) return [];
        return [{ day: cell.dataset.date!, element, width: element.clientWidth, height: element.clientHeight,
          heading: cell.querySelector<HTMLElement>('.fc-daygrid-day-top')?.offsetHeight ?? 22 }];
      });
      for (const element of observed) {
        if (!next.some(cell => cell.element === element)) { resize.unobserve(element); observed.delete(element); }
      }
      for (const cell of next) {
        if (!observed.has(cell.element)) { resize.observe(cell.element); observed.add(cell.element); }
      }
      setCells(previous => previous.length === next.length && previous.every((cell, index) => {
        const other = next[index];
        return cell.element === other.element && cell.day === other.day && cell.width === other.width
          && cell.height === other.height && cell.heading === other.heading;
      }) ? previous : next);
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure); };
    const resize = new ResizeObserver(schedule);
    resize.observe(root.current);
    const changes = new MutationObserver(schedule);
    changes.observe(root.current, { childList: true, subtree: true });
    measure();
    return () => { resize.disconnect(); changes.disconnect(); cancelAnimationFrame(frame); };
  }, [root]);

  return cells.map(cell => {
    const items = events.filter(event => occursOn(event, cell.day)).sort(compareEvents);
    if (!items.length) return null;
    const available = Math.max(0, cell.height - cell.heading - 3);
    const compact = items.length * 20 > available;
    const besideDate = compact && available < 12;
    const width = Math.max(1, cell.width - (besideDate ? 30 : 6));
    const height = Math.max(6, besideDate ? cell.heading - 4 : available);
    const columns = Math.min(items.length, Math.max(1, Math.floor(width / 14)));
    const size = Math.min(14, height / Math.ceil(items.length / columns));
    return createPortal(<div className={`calendar-day-events${compact ? ' calendar-day-dots' : ''}`}
      style={{ top: besideDate ? 2 : cell.heading, left: besideDate ? 27 : 3,
        ...(compact ? { gridTemplateColumns: `repeat(${columns}, ${Math.min(14, width / columns)}px)`, gridAutoRows: `${size}px` } : {}) }}>
      {items.map(event => <button key={`${event.provider}:${event.id}`} type="button"
        className={`fc-event calendar-day-event${compact ? ' calendar-event-dot' : ''}`}
        style={{ '--event-color': event.color ?? `var(--${event.provider})`, '--dot-size': `${Math.max(2, Math.min(6, size - 2))}px` } as CSSProperties}
        aria-label={event.title}
        onMouseEnter={e => onHover({ event, anchor: e.currentTarget.getBoundingClientRect() })}
        onMouseLeave={() => onHover(null)}
        onFocus={e => onHover({ event, anchor: e.currentTarget.getBoundingClientRect() })}
        onBlur={() => onHover(null)}
        onKeyDown={e => { if (e.key === 'Escape') onHover(null); }}
        onClick={e => { e.stopPropagation(); onHover(null); onOpen(event, cell.day); }}>
        {compact ? <span aria-hidden="true" /> : <span className={event.all_day || event.start.slice(0, 10) !== event.end.slice(0, 10) ? 'chip chip-bar' : 'chip'}>{event.title}</span>}
      </button>)}
    </div>, cell.element, cell.day);
  });
}
