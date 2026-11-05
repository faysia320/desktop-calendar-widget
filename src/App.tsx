import { MouseEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import FullCalendar from "@fullcalendar/react";
import dayGridPlugin from "@fullcalendar/daygrid";
import interactionPlugin from "@fullcalendar/interaction";
import koLocale from "@fullcalendar/core/locales/ko";
import EventEditor from "./EventEditor";
import {
  CalendarEvent,
  PROVIDER_LABELS,
  Provider,
  RemoteEvent,
  compareEvents,
  formatEventTime,
  formatFetchedAt,
  occursOn,
  toDayKey,
} from "./events";
import "./App.css";

const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

type WidgetStatus = {
  summoned: boolean;
  maximized: boolean;
  shortcut: string;
  shortcut_error: string | null;
};

type ProviderStatus = {
  provider: Provider;
  configured: boolean;
  connected: boolean;
};

type DayRange = { from: string; to: string };

type CachedEvents = { events: RemoteEvent[]; fetched_at: string };

function useCalendarEvents(range: DayRange | null) {
  const [statuses, setStatuses] = useState<ProviderStatus[]>([]);
  const [eventsByProvider, setEventsByProvider] = useState<Partial<Record<Provider, RemoteEvent[]>>>({});
  const [errors, setErrors] = useState<Partial<Record<Provider, string>>>({});
  // 저장된 일정을 보여 주는 동안 그 일정을 가져온 시각입니다.
  const [staleSince, setStaleSince] = useState<Partial<Record<Provider, string>>>({});
  const latestRequest = useRef(0);
  const shownRange = useRef("");

  const refresh = useCallback(async () => {
    const request = ++latestRequest.current;
    const current = await invoke<ProviderStatus[]>("provider_status");
    if (request !== latestRequest.current) return;
    setStatuses(current);
    if (!range) return;

    const rangeKey = `${range.from}|${range.to}`;
    const isNewRange = shownRange.current !== rangeKey;
    shownRange.current = rangeKey;

    await Promise.all(
      current.map(async ({ provider, configured, connected }) => {
        const cached = await invoke<CachedEvents | null>("cached_events", { provider, ...range });
        if (request !== latestRequest.current) return;
        // 네트워크를 기다리지 않고 저장된 일정을 먼저 보여 줍니다.
        if (isNewRange && cached) {
          setEventsByProvider((previous) => ({ ...previous, [provider]: cached.events }));
        }
        const showCached = () =>
          setStaleSince((previous) => ({ ...previous, [provider]: cached?.fetched_at }));

        if (!configured || !connected) {
          showCached();
          return;
        }
        try {
          const events = await invoke<RemoteEvent[]>("fetch_events", { provider, ...range });
          if (request !== latestRequest.current) return;
          setEventsByProvider((previous) => ({ ...previous, [provider]: events }));
          setErrors((previous) => ({ ...previous, [provider]: undefined }));
          setStaleSince((previous) => ({ ...previous, [provider]: undefined }));
        } catch (error) {
          if (request !== latestRequest.current) return;
          setErrors((previous) => ({ ...previous, [provider]: String(error) }));
          showCached();
        }
      }),
    );

    // 조회 중 로그인이 만료되면 연결 상태가 바뀌므로 다시 읽습니다.
    const updated = await invoke<ProviderStatus[]>("provider_status");
    if (request === latestRequest.current) setStatuses(updated);
  }, [range]);

  useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, REFRESH_INTERVAL_MS);
    const unlisten = listen("events-changed", refresh);
    return () => {
      window.clearInterval(timer);
      unlisten.then((stop) => stop());
    };
  }, [refresh]);

  const events = useMemo<CalendarEvent[]>(
    () =>
      (Object.entries(eventsByProvider) as [Provider, RemoteEvent[]][]).flatMap(([provider, items]) =>
        items.map((event) => ({ ...event, provider })),
      ),
    [eventsByProvider],
  );

  return { statuses, events, errors, staleSince, setErrors, refresh };
}

function ProviderBar({
  statuses,
  errors,
  staleSince,
  onConnect,
}: {
  statuses: ProviderStatus[];
  errors: Partial<Record<Provider, string>>;
  staleSince: Partial<Record<Provider, string>>;
  onConnect: (provider: Provider) => void;
}) {
  return (
    <div className="providers">
      {statuses.map(({ provider, configured, connected }) => (
        <div key={provider} className="provider">
          <span className={`dot ${provider}`} />
          <span className="provider-name">{PROVIDER_LABELS[provider]}</span>
          {!configured && <span className="muted">설정 필요</span>}
          {configured && connected && <span className="muted">연결됨</span>}
          {configured && !connected && <button onClick={() => onConnect(provider)}>로그인</button>}
          {staleSince[provider] && (
            <p className="muted stale">{formatFetchedAt(staleSince[provider])} 기준 일정 표시 중</p>
          )}
          {errors[provider] && <p className="error">{errors[provider]}</p>}
        </div>
      ))}
    </div>
  );
}

function AutostartToggle() {
  const [enabled, setEnabled] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    invoke<boolean>("autostart_enabled").then(setEnabled, (reason) => setError(String(reason)));
  }, []);

  async function toggle(next: boolean) {
    setError("");
    try {
      await invoke("set_autostart", { enabled: next });
      setEnabled(next);
    } catch (reason) {
      setError(String(reason));
    }
  }

  return (
    <div className="autostart">
      <label>
        <input type="checkbox" checked={enabled} onChange={(event) => toggle(event.target.checked)} />
        Windows 시작 시 실행
      </label>
      {error && <p className="error">{error}</p>}
    </div>
  );
}

function Widget() {
  const [status, setStatus] = useState<WidgetStatus | null>(null);
  const [selectedDay, setSelectedDay] = useState(() => toDayKey(new Date()));
  const [range, setRange] = useState<DayRange | null>(null);
  const { statuses, events, errors, staleSince, setErrors, refresh } = useCalendarEvents(range);

  useEffect(() => {
    invoke<WidgetStatus>("widget_status").then(setStatus);
    const unlisten = listen<boolean>("summoned-changed", (event) => {
      setStatus((current) => current && { ...current, summoned: event.payload });
    });
    return () => {
      unlisten.then((stop) => stop());
    };
  }, []);

  // data-tauri-drag-region의 더블클릭 최대화는 바탕화면 자식 창을 주 모니터로 보내므로 직접 처리합니다.
  async function handleTitlebarMouseDown(event: MouseEvent<HTMLElement>) {
    if (event.button !== 0 || (event.target as Element).closest("button")) return;
    if (event.detail === 2) {
      const maximized = await invoke<boolean>("toggle_maximized");
      setStatus((current) => current && { ...current, maximized });
    } else if (event.detail === 1 && !status?.maximized) {
      await getCurrentWindow().startDragging();
    }
  }

  async function connect(provider: Provider) {
    try {
      await invoke("connect", { provider });
      await refresh();
    } catch (error) {
      setErrors((previous) => ({ ...previous, [provider]: String(error) }));
    }
  }

  const calendarEvents = useMemo(
    () =>
      events.map((event) => ({
        id: `${event.provider}:${event.id}`,
        title: event.title,
        start: event.start.replace(" ", "T"),
        end: event.end.replace(" ", "T"),
        allDay: event.all_day,
        classNames: [`event-${event.provider}`],
      })),
    [events],
  );

  const dayEvents = useMemo(
    () => events.filter((event) => occursOn(event, selectedDay)).sort(compareEvents),
    [events, selectedDay],
  );

  const googleConnected = statuses.some(
    (item) => item.provider === "google" && item.configured && item.connected,
  );

  return (
    <main className="widget">
      <header className="titlebar" onMouseDown={handleTitlebarMouseDown}>
        <h1>캘린더</h1>
        {status && (
          <span className="muted" title={status.shortcut_error ?? undefined}>
            {status.summoned ? "맨 앞" : "바탕화면 고정"} ·{" "}
            {status.shortcut_error ? "단축키 등록 실패" : status.shortcut}
          </span>
        )}
        <button onClick={() => refresh()}>새로고침</button>
        <button onClick={() => invoke("quit")}>종료</button>
      </header>

      <div className="layout">
        <section className="calendar">
          <FullCalendar
            plugins={[dayGridPlugin, interactionPlugin]}
            initialView="dayGridMonth"
            locale={koLocale}
            height="100%"
            headerToolbar={{ left: "prev,next today", center: "title", right: "" }}
            fixedWeekCount={false}
            dayMaxEvents
            displayEventTime={false}
            dayCellContent={(cell) => cell.dayNumberText.replace("일", "")}
            dayCellClassNames={(cell) => (toDayKey(cell.date) === selectedDay ? ["day-selected"] : [])}
            events={calendarEvents}
            dateClick={(click) => setSelectedDay(click.dateStr)}
            eventClick={(click) => {
              if (click.event.start) setSelectedDay(toDayKey(click.event.start));
            }}
            datesSet={(dates) => {
              const next = { from: toDayKey(dates.start), to: toDayKey(dates.end) };
              setRange((current) =>
                current?.from === next.from && current.to === next.to ? current : next,
              );
            }}
          />
        </section>

        <aside className="details">
          <div className="details-header">
            <h2>{selectedDay.replace(/-/g, ".")}</h2>
            <button
              className="primary"
              disabled={!googleConnected}
              title={googleConnected ? undefined : "Google에 로그인하면 일정을 추가할 수 있습니다."}
              onClick={() => invoke("open_event_editor", { date: selectedDay })}
            >
              일정 추가
            </button>
          </div>

          {dayEvents.length === 0 ? (
            <p className="muted empty">일정이 없습니다.</p>
          ) : (
            <ul className="events">
              {dayEvents.map((event) => (
                <li key={`${event.provider}:${event.id}`}>
                  <span className={`dot ${event.provider}`} />
                  <div>
                    <strong>{event.title}</strong>
                    <span>{formatEventTime(event)}</span>
                    {event.location && <span>{event.location}</span>}
                  </div>
                </li>
              ))}
            </ul>
          )}

          <ProviderBar statuses={statuses} errors={errors} staleSince={staleSince} onConnect={connect} />
          <AutostartToggle />
        </aside>
      </div>
    </main>
  );
}

function App() {
  const params = new URLSearchParams(window.location.search);
  if (params.get("view") === "new-event") {
    return <EventEditor date={params.get("date") ?? toDayKey(new Date())} />;
  }
  return <Widget />;
}

export default App;
