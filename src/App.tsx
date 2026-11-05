import { MouseEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import FullCalendar from "@fullcalendar/react";
import dayGridPlugin from "@fullcalendar/daygrid";
import interactionPlugin from "@fullcalendar/interaction";
import koLocale from "@fullcalendar/core/locales/ko";
import "pretendard/dist/web/variable/pretendardvariable.css";
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
const TRANSPARENCY_STORAGE_KEY = "background-transparency";
const DEFAULT_TRANSPARENCY = 0;
const THEME_STORAGE_KEY = "theme";

type Theme = "system" | "light" | "dark";

const THEME_OPTIONS: { value: Theme; label: string }[] = [
  { value: "system", label: "시스템" },
  { value: "light", label: "라이트" },
  { value: "dark", label: "다크" },
];

function readSavedTheme(): Theme {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    return saved === "light" || saved === "dark" ? saved : "system";
  } catch {
    return "system";
  }
}

function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
}

// 일정 추가 창에도 적용되도록 첫 렌더링 전에 테마를 정하고, 다른 창에서 바꾸면 따라갑니다.
applyTheme(readSavedTheme());
window.addEventListener("storage", (event) => {
  if (event.key === THEME_STORAGE_KEY) applyTheme(readSavedTheme());
});

function useTheme() {
  const [theme, setTheme] = useState(readSavedTheme);

  function change(next: Theme) {
    setTheme(next);
    applyTheme(next);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // 저장하지 못해도 이번 실행에서는 적용됩니다.
    }
  }

  return [theme, change] as const;
}

function readSavedTransparency(): number {
  try {
    const saved = Number(localStorage.getItem(TRANSPARENCY_STORAGE_KEY) ?? DEFAULT_TRANSPARENCY);
    return saved >= 0 && saved <= 100 ? saved : DEFAULT_TRANSPARENCY;
  } catch {
    return DEFAULT_TRANSPARENCY;
  }
}

function useBackgroundTransparency() {
  const [transparency, setTransparency] = useState(readSavedTransparency);

  useEffect(() => {
    document.documentElement.style.setProperty("--background-opacity", String(1 - transparency / 100));
  }, [transparency]);

  function change(next: number) {
    setTransparency(next);
    try {
      localStorage.setItem(TRANSPARENCY_STORAGE_KEY, String(next));
    } catch {
      // 저장하지 못해도 이번 실행에서는 적용됩니다.
    }
  }

  return [transparency, change] as const;
}

type WidgetStatus = {
  maximized: boolean;
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

// 메뉴를 닫아도 보이도록 오류와 오프라인 안내는 상세 패널에 표시합니다.
function Notices({
  statuses,
  errors,
  staleSince,
  shortcutError,
}: {
  statuses: ProviderStatus[];
  errors: Partial<Record<Provider, string>>;
  staleSince: Partial<Record<Provider, string>>;
  shortcutError: string | null;
}) {
  const providers = statuses.filter(({ provider }) => errors[provider] || staleSince[provider]);
  if (providers.length === 0 && !shortcutError) return null;

  return (
    <div className="notices">
      {providers.map(({ provider }) => (
        <div key={provider}>
          {staleSince[provider] && (
            <p className="muted">
              {PROVIDER_LABELS[provider]}: {formatFetchedAt(staleSince[provider])} 기준 일정 표시 중
            </p>
          )}
          {errors[provider] && (
            <p className="error">
              {PROVIDER_LABELS[provider]}: {errors[provider]}
            </p>
          )}
        </div>
      ))}
      {shortcutError && <p className="error">단축키 등록 실패: {shortcutError}</p>}
    </div>
  );
}

function providerStateLabel({ configured, connected }: ProviderStatus): string {
  if (!configured) return "설정 필요";
  return connected ? "연결됨" : "로그인";
}

function WidgetMenu({
  statuses,
  theme,
  onThemeChange,
  transparency,
  onTransparencyChange,
  onRefresh,
  onConnect,
}: {
  statuses: ProviderStatus[];
  theme: Theme;
  onThemeChange: (theme: Theme) => void;
  transparency: number;
  onTransparencyChange: (transparency: number) => void;
  onRefresh: () => void;
  onConnect: (provider: Provider) => void;
}) {
  return (
    <div className="menu">
      {statuses.map((status) => (
        <button
          key={status.provider}
          className="menu-item"
          disabled={!status.configured || status.connected}
          onClick={() => onConnect(status.provider)}
        >
          <span className={`dot ${status.provider}`} />
          <span className="menu-label">{PROVIDER_LABELS[status.provider]} 연동</span>
          <span className="muted">{providerStateLabel(status)}</span>
        </button>
      ))}
      <hr className="menu-divider" />
      <AutostartToggle />
      <div className="menu-theme">
        테마
        <div className="theme-options">
          {THEME_OPTIONS.map(({ value, label }) => (
            <button key={value} aria-pressed={theme === value} onClick={() => onThemeChange(value)}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <label className="menu-slider">
        <span className="menu-slider-label">
          배경 투명도
          <span className="muted">{transparency}%</span>
        </span>
        <input
          type="range"
          min={0}
          max={100}
          step={5}
          value={transparency}
          onChange={(event) => onTransparencyChange(Number(event.target.value))}
        />
      </label>
      <hr className="menu-divider" />
      <button className="menu-item" onClick={onRefresh}>새로고침</button>
      <button className="menu-item" onClick={() => invoke("quit")}>종료</button>
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
        윈도우 시작 시 실행
      </label>
      {error && <p className="error">{error}</p>}
    </div>
  );
}

function Widget() {
  const [status, setStatus] = useState<WidgetStatus | null>(null);
  const [selectedDay, setSelectedDay] = useState(() => toDayKey(new Date()));
  const [range, setRange] = useState<DayRange | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [theme, setTheme] = useTheme();
  const [transparency, setTransparency] = useBackgroundTransparency();
  const calendarRef = useRef<FullCalendar>(null);
  const { statuses, events, errors, staleSince, setErrors, refresh } = useCalendarEvents(range);

  useEffect(() => {
    invoke<WidgetStatus>("widget_status").then(setStatus);
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const closeOnOutsideClick = (event: globalThis.MouseEvent) => {
      if (!(event.target as Element).closest(".menu, .fc-menu-button")) setMenuOpen(false);
    };
    document.addEventListener("mousedown", closeOnOutsideClick);
    return () => document.removeEventListener("mousedown", closeOnOutsideClick);
  }, [menuOpen]);

  // 달력 상단 툴바의 빈 공간으로 창을 옮깁니다.
  // data-tauri-drag-region의 더블클릭 최대화는 바탕화면 자식 창을 주 모니터로 보내므로 직접 처리합니다.
  async function handleToolbarMouseDown(event: MouseEvent<HTMLElement>) {
    const target = event.target as Element;
    if (event.button !== 0 || !target.closest(".fc-header-toolbar") || target.closest("button")) return;
    if (event.detail === 2) {
      const maximized = await invoke<boolean>("toggle_maximized");
      setStatus((current) => current && { ...current, maximized });
    } else if (event.detail === 1 && !status?.maximized) {
      await getCurrentWindow().startDragging();
    }
  }

  async function connect(provider: Provider) {
    setMenuOpen(false);
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
      <div className="layout">
        <section className="calendar" onMouseDown={handleToolbarMouseDown}>
          {menuOpen && (
            <WidgetMenu
              statuses={statuses}
              theme={theme}
              onThemeChange={setTheme}
              transparency={transparency}
              onTransparencyChange={setTransparency}
              onRefresh={() => {
                setMenuOpen(false);
                refresh();
              }}
              onConnect={connect}
            />
          )}
          <FullCalendar
            ref={calendarRef}
            plugins={[dayGridPlugin, interactionPlugin]}
            initialView="dayGridMonth"
            locale={koLocale}
            height="100%"
            headerToolbar={{ left: "menu", center: "title", right: "prev,goToday,next" }}
            customButtons={{
              menu: {
                text: "☰",
                hint: "메뉴",
                click: () => setMenuOpen((open) => !open),
              },
              goToday: {
                text: "",
                hint: "오늘",
                click: () => calendarRef.current?.getApi().today(),
              },
            }}
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

          <Notices
            statuses={statuses}
            errors={errors}
            staleSince={staleSince}
            shortcutError={status?.shortcut_error ?? null}
          />
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
