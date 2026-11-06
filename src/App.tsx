import {
  CSSProperties,
  MouseEvent,
  WheelEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
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
  describeDay,
  eventPhase,
  formatEventTime,
  formatFetchedAt,
  holidayName,
  minuteOfDay,
  minutesOnDay,
  occursOn,
  roomColorSlots,
  roomHourRange,
  toDayKey,
  toMinuteKey,
} from "./events";
import { Icon } from "./icons";
import "./App.css";

const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const NOW_TICK_MS = 30 * 1000;
const WHEEL_THROTTLE_MS = 350;
const TRANSPARENCY_STORAGE_KEY = "background-transparency";
const DEFAULT_TRANSPARENCY = 20;
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
  rooms: string[];
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
  const [holidays, setHolidays] = useState<RemoteEvent[]>([]);
  const [roomBookings, setRoomBookings] = useState<RemoteEvent[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [syncedAt, setSyncedAt] = useState<Date | null>(null);
  const latestRequest = useRef(0);
  const shownRange = useRef("");

  const refresh = useCallback(async () => {
    const request = ++latestRequest.current;
    setRefreshing(true);
    try {
      const current = await invoke<ProviderStatus[]>("provider_status");
      if (request !== latestRequest.current) return;
      setStatuses(current);
      if (!range) return;

      invoke<RemoteEvent[]>("holidays", { ...range }).then((items) => {
        if (request === latestRequest.current) setHolidays(items);
      });
      invoke<RemoteEvent[]>("rooms", { ...range }).then((items) => {
        if (request === latestRequest.current) setRoomBookings(items);
      });

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
            setSyncedAt(new Date());
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
    } finally {
      if (request === latestRequest.current) setRefreshing(false);
    }
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

  return { statuses, events, holidays, roomBookings, errors, staleSince, refreshing, syncedAt, setErrors, refresh };
}

// 시간이 지나도 진행 중 표시와 오늘 날짜가 맞도록 현재 시각을 주기적으로 갱신합니다.
function useNow() {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), NOW_TICK_MS);
    return () => window.clearInterval(timer);
  }, []);

  return now;
}

function eventColorStyle(event: CalendarEvent): CSSProperties {
  return { "--event-color": event.color ?? `var(--${event.provider})` } as CSSProperties;
}

// 메뉴를 닫아도 보이도록 오류와 오프라인 안내는 상세 패널에 표시합니다.
function Notices({
  statuses,
  errors,
  staleSince,
  shortcutError,
  onConnect,
}: {
  statuses: ProviderStatus[];
  errors: Partial<Record<Provider, string>>;
  staleSince: Partial<Record<Provider, string>>;
  shortcutError: string | null;
  onConnect: (provider: Provider) => void;
}) {
  // 쓰다가 끊긴 계정만 알립니다. 아직 쓰지 않는 계정은 아무것도 연결되지 않았을 때만 안내합니다.
  const nothingConnected = !statuses.some(({ connected }) => connected);
  const providers = statuses.filter(
    ({ provider, configured }) =>
      errors[provider] || staleSince[provider] || (configured && nothingConnected),
  );
  if (providers.length === 0 && !shortcutError) return null;

  return (
    <div className="notices">
      {providers.map(({ provider, configured, connected }) => {
        const needsLogin = configured && !connected;
        const message = errors[provider] ?? (needsLogin ? "로그인이 필요합니다." : null);
        return (
          <div className="notice" key={provider}>
            <div className="notice-text">
              {message && (
                <p className={errors[provider] ? "error" : undefined} title={message}>
                  {PROVIDER_LABELS[provider]}: {message}
                </p>
              )}
              {staleSince[provider] && (
                <p className="muted">{formatFetchedAt(staleSince[provider])} 기준 일정 표시 중</p>
              )}
            </div>
            {needsLogin && (
              <button className="notice-action" onClick={() => onConnect(provider)}>
                로그인
              </button>
            )}
          </div>
        );
      })}
      {shortcutError && (
        <div className="notice">
          <p className="error" title={shortcutError}>단축키 등록 실패: {shortcutError}</p>
        </div>
      )}
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
  onConnect,
}: {
  statuses: ProviderStatus[];
  theme: Theme;
  onThemeChange: (theme: Theme) => void;
  transparency: number;
  onTransparencyChange: (transparency: number) => void;
  onConnect: (provider: Provider) => void;
}) {
  return (
    <div className="menu">
      <section className="menu-group">
        <h3>계정</h3>
        {statuses.map((status) => (
          <button
            key={status.provider}
            className="menu-item"
            disabled={!status.configured || status.connected}
            onClick={() => onConnect(status.provider)}
          >
            <span className={`dot ${status.provider}`} />
            <span className="menu-label">{PROVIDER_LABELS[status.provider]}</span>
            <span className={status.configured && !status.connected ? "menu-state action" : "menu-state"}>
              {providerStateLabel(status)}
            </span>
          </button>
        ))}
      </section>
      <section className="menu-group">
        <h3>표시</h3>
        <div className="segmented" role="group" aria-label="테마">
          {THEME_OPTIONS.map(({ value, label }) => (
            <button key={value} aria-pressed={theme === value} onClick={() => onThemeChange(value)}>
              {label}
            </button>
          ))}
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
            style={{ "--slider-fill": `${transparency}%` } as CSSProperties}
            onChange={(event) => onTransparencyChange(Number(event.target.value))}
          />
        </label>
      </section>
      <section className="menu-group">
        <AutostartToggle />
        <button className="menu-item" onClick={() => invoke("quit")}>위젯 종료</button>
      </section>
    </div>
  );
}

function EventRow({ event, now, onEdit }: { event: CalendarEvent; now: string; onEdit: () => void }) {
  const phase = eventPhase(event, now);
  const content = (
    <>
      <span className="event-bar" />
      <span className="event-body">
        <span className="event-title">{event.title}</span>
        <span className="event-meta">
          {formatEventTime(event)}
          {phase === "ongoing" && <span className="event-live">진행 중</span>}
        </span>
        {event.location && (
          <span className="event-meta event-location">
            <Icon name="pin" size={12} />
            <span>{event.location}</span>
          </span>
        )}
      </span>
    </>
  );

  return (
    <li className={`event-${phase}`} style={eventColorStyle(event)}>
      {event.editable ? (
        <button className="event-row editable" title="일정 편집" onClick={onEdit}>
          {content}
          <span className="event-chevron"><Icon name="chevronRight" size={14} /></span>
        </button>
      ) : (
        <div className="event-row" title={`${PROVIDER_LABELS[event.provider]} 일정은 읽기 전용입니다.`}>
          {content}
        </div>
      )}
    </li>
  );
}

const ROOM_TOOLTIP_GAP = 6;
const ROOM_TOOLTIP_MARGIN = 8;
const ROOM_TOOLTIP_MAX_ATTENDEES = 12;

// 시간표는 넘치는 부분을 잘라 내므로 패널 밖으로 띄워 블록 위에 표시합니다. 위에 자리가 없으면 아래에 둡니다.
function RoomTooltip({ booking, anchor, color }: { booking: RemoteEvent; anchor: DOMRect; color: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const meeting = booking.meeting;
  const organizer = booking.title.trim();
  const hiddenAttendees = (meeting?.attendees.length ?? 0) - ROOM_TOOLTIP_MAX_ATTENDEES;

  useLayoutEffect(() => {
    const { offsetWidth, offsetHeight } = ref.current!;
    const above = anchor.top - offsetHeight - ROOM_TOOLTIP_GAP;
    setPosition({
      left: Math.max(ROOM_TOOLTIP_MARGIN, Math.min(anchor.left, window.innerWidth - offsetWidth - ROOM_TOOLTIP_MARGIN)),
      top: above >= ROOM_TOOLTIP_MARGIN ? above : anchor.bottom + ROOM_TOOLTIP_GAP,
    });
  }, [anchor]);

  return createPortal(
    <div
      className="room-tooltip"
      ref={ref}
      role="tooltip"
      style={{ ...position, visibility: position ? "visible" : "hidden", "--room-color": color } as CSSProperties}
    >
      <strong className="room-tooltip-title">{meeting?.subject ?? organizer}</strong>
      <span className="room-tooltip-meta">
        {booking.calendar_id} · {formatEventTime(booking)}
      </span>
      {meeting ? (
        <>
          <span className="room-tooltip-meta">예약자 {organizer}</span>
          {meeting.summary && <p className="room-tooltip-summary">{meeting.summary}</p>}
          {meeting.attendees.length > 0 && (
            <div className="room-tooltip-attendees">
              <h4>참여자 {meeting.attendees.length}명</h4>
              <ul>
                {meeting.attendees.slice(0, ROOM_TOOLTIP_MAX_ATTENDEES).map((attendee, index) => (
                  <li key={`${attendee}-${index}`}>{attendee}</li>
                ))}
                {hiddenAttendees > 0 && <li className="more">외 {hiddenAttendees}명</li>}
              </ul>
            </div>
          )}
        </>
      ) : (
        <p className="room-tooltip-note">내가 참석하지 않는 회의는 내용과 참여자를 볼 수 없습니다.</p>
      )}
    </div>,
    document.body,
  );
}

// 내 일정과 섞이지 않도록 고른 날의 회의실 예약을 상세 패널 아래에 가로 시간표로 보여 줍니다.
function RoomSchedules({
  names,
  bookings,
  day,
  now,
}: {
  names: string[];
  bookings: RemoteEvent[];
  day: string;
  now: string;
}) {
  const [hovered, setHovered] = useState<{ booking: RemoteEvent; anchor: DOMRect; color: string } | null>(null);
  const dayBookings = bookings.filter((booking) => occursOn(booking, day));
  const { from, to } = roomHourRange(dayBookings, day);
  const colorSlots = roomColorSlots(dayBookings);
  const hours = Array.from({ length: to - from + 1 }, (_, index) => from + index);
  const percent = (minutes: number) => (minutes / ((to - from) * 60)) * 100;
  const nowOffset = minuteOfDay(now) - from * 60;
  const showNow = now.startsWith(day) && nowOffset >= 0 && nowOffset <= (to - from) * 60;

  return (
    <section
      className="rooms"
      aria-label="회의실 예약"
      style={{ "--room-hours": to - from } as CSSProperties}
    >
      <div className="room-row">
        <span />
        <div className="room-axis">
          {hours.map((hour) => (
            <span
              className={hour % 2 === 0 ? "room-hour" : "room-hour odd"}
              key={hour}
              style={{ left: `${percent((hour - from) * 60)}%` }}
            >
              {hour}
            </span>
          ))}
        </div>
      </div>
      <div className="room-rows">
        {names.map((name) => (
          <div className="room-row" key={name}>
            <h3 className="room-name">{name}</h3>
            <ul className="room-track">
              {dayBookings
                .filter((booking) => booking.calendar_id === name)
                .map((booking) => {
                  const { start, end } = minutesOnDay(booking, day);
                  const color = `var(--room-color-${colorSlots.get(booking.title.trim())})`;
                  return (
                    <li
                      className={`room-booking event-${eventPhase(booking, now)}`}
                      key={booking.id}
                      onMouseEnter={(event) =>
                        setHovered({ booking, anchor: event.currentTarget.getBoundingClientRect(), color })
                      }
                      onMouseLeave={() => setHovered(null)}
                      style={
                        {
                          "--room-color": color,
                          left: `${percent(start - from * 60)}%`,
                          width: `${percent(end - start)}%`,
                        } as CSSProperties
                      }
                    >
                      <span className="room-booking-title">{booking.title}</span>
                    </li>
                  );
                })}
            </ul>
          </div>
        ))}
        {showNow && (
          <div className="room-now-layer">
            <span className="room-now" style={{ left: `${percent(nowOffset)}%` }} />
          </div>
        )}
      </div>
      {hovered && <RoomTooltip key={hovered.booking.id} {...hovered} />}
    </section>
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
        윈도우 시작 시 실행
        <input
          className="switch"
          type="checkbox"
          role="switch"
          checked={enabled}
          onChange={(event) => toggle(event.target.checked)}
        />
      </label>
      {error && <p className="error">{error}</p>}
    </div>
  );
}

function Widget() {
  const [status, setStatus] = useState<WidgetStatus | null>(null);
  const now = useNow();
  const today = toDayKey(now);
  const [selectedDay, setSelectedDay] = useState(today);
  const [range, setRange] = useState<DayRange | null>(null);
  const [shownMonth, setShownMonth] = useState(now);
  const [menuOpen, setMenuOpen] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [theme, setTheme] = useTheme();
  const [transparency, setTransparency] = useBackgroundTransparency();
  const calendarRef = useRef<FullCalendar>(null);
  const shownToday = useRef(today);
  const lastWheel = useRef(0);
  const { statuses, events, holidays, roomBookings, errors, staleSince, refreshing, syncedAt, setErrors, refresh } =
    useCalendarEvents(range);

  useEffect(() => {
    invoke<WidgetStatus>("widget_status").then(setStatus);
  }, []);

  // 켜 둔 채 날짜가 바뀌면, 오늘을 보고 있던 경우에만 새 오늘로 따라갑니다.
  useEffect(() => {
    if (selectedDay === shownToday.current) goToDay(today);
    shownToday.current = today;
  }, [today]);

  useEffect(() => {
    const unlisten = listen<boolean>("event-editor-open", (event) => setEditorOpen(event.payload));
    return () => {
      unlisten.then((stop) => stop());
    };
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const closeOnOutsideClick = (event: globalThis.MouseEvent) => {
      if (!(event.target as Element).closest(".menu, .menu-toggle")) setMenuOpen(false);
    };
    document.addEventListener("mousedown", closeOnOutsideClick);
    return () => document.removeEventListener("mousedown", closeOnOutsideClick);
  }, [menuOpen]);

  function goToDay(day: string) {
    setSelectedDay(day);
    calendarRef.current?.getApi().gotoDate(day);
  }

  function openNewEvent(date: string) {
    if (googleConnected) invoke("open_event_editor", { date });
  }

  // 빈 날짜 칸을 두 번 누르면 그 날짜로 일정을 추가합니다.
  function handleCalendarDoubleClick(event: MouseEvent<HTMLElement>) {
    const target = event.target as Element;
    if (target.closest(".fc-event, .fc-daygrid-more-link")) return;
    const date = target.closest<HTMLElement>(".fc-daygrid-day")?.dataset.date;
    if (date) openNewEvent(date);
  }

  // 위젯은 키보드 입력을 받지 않으므로 휠로도 달을 넘길 수 있게 합니다.
  function handleCalendarWheel(event: WheelEvent<HTMLElement>) {
    if (menuOpen || event.deltaY === 0 || event.timeStamp - lastWheel.current < WHEEL_THROTTLE_MS) return;
    lastWheel.current = event.timeStamp;
    const calendar = calendarRef.current?.getApi();
    if (event.deltaY > 0) calendar?.next();
    else calendar?.prev();
  }

  // 달력 상단 툴바의 빈 공간으로 창을 옮깁니다.
  // data-tauri-drag-region의 더블클릭 최대화는 바탕화면 자식 창을 주 모니터로 보내므로 직접 처리합니다.
  async function handleToolbarMouseDown(event: MouseEvent<HTMLElement>) {
    const target = event.target as Element;
    if (event.button !== 0 || target.closest("button")) return;
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
        extendedProps: { style: eventColorStyle(event) },
      })),
    [events],
  );

  const dayEvents = useMemo(
    () => events.filter((event) => occursOn(event, selectedDay)).sort(compareEvents),
    [events, selectedDay],
  );

  const selectedHoliday = holidayName(holidays, selectedDay);
  const selected = describeDay(selectedDay, today);
  const minuteNow = toMinuteKey(now);

  const googleConnected = statuses.some(
    (item) => item.provider === "google" && item.configured && item.connected,
  );

  const syncedAtLabel = syncedAt && toMinuteKey(syncedAt).slice(11);

  return (
    <main className={status?.maximized ? "widget maximized" : "widget"}>
      <div className="sheet">
        <div className="layout">
          <section className="calendar">
            <header className="toolbar" onMouseDown={handleToolbarMouseDown}>
              <h1 className="month-title">
                <span className="month-year">{shownMonth.getFullYear()}년</span> {shownMonth.getMonth() + 1}월
              </h1>
              <div className="toolbar-actions">
                <div className="nav-group">
                  <button
                    className="icon-button"
                    title="이전 달"
                    aria-label="이전 달"
                    onClick={() => calendarRef.current?.getApi().prev()}
                  >
                    <Icon name="chevronLeft" size={16} />
                  </button>
                  <button className="today-button" onClick={() => goToDay(today)}>오늘</button>
                  <button
                    className="icon-button"
                    title="다음 달"
                    aria-label="다음 달"
                    onClick={() => calendarRef.current?.getApi().next()}
                  >
                    <Icon name="chevronRight" size={16} />
                  </button>
                </div>
                <button
                  className={refreshing ? "icon-button spinning" : "icon-button"}
                  title={syncedAtLabel ? `새로고침 (마지막 동기화 ${syncedAtLabel})` : "새로고침"}
                  aria-label="새로고침"
                  onClick={refresh}
                >
                  <Icon name="refresh" size={16} />
                </button>
                <button
                  className="icon-button menu-toggle"
                  title="설정"
                  aria-label="설정"
                  aria-expanded={menuOpen}
                  onClick={() => setMenuOpen((open) => !open)}
                >
                  <Icon name="settings" size={16} />
                </button>
              </div>
            </header>
            {menuOpen && (
              <WidgetMenu
                statuses={statuses}
                theme={theme}
                onThemeChange={setTheme}
                transparency={transparency}
                onTransparencyChange={setTransparency}
                onConnect={connect}
              />
            )}
            <div className="month" onDoubleClick={handleCalendarDoubleClick} onWheel={handleCalendarWheel}>
              <FullCalendar
                ref={calendarRef}
                plugins={[dayGridPlugin, interactionPlugin]}
                initialView="dayGridMonth"
                locale={koLocale}
                height="100%"
                expandRows
                headerToolbar={false}
                fixedWeekCount={false}
                dayMaxEvents
                displayEventTime={false}
                eventDisplay="block"
                moreLinkContent={(more) => `+${more.num}개`}
                // 팝오버 대신 상세 패널에서 그날의 일정을 보여 줍니다. 값을 돌려주지 않으면 팝오버가 열립니다.
                moreLinkClick={(more) => {
                  setSelectedDay(toDayKey(more.date));
                  return "dayGridMonth";
                }}
                dayCellContent={(cell) => {
                  const holiday = holidayName(holidays, toDayKey(cell.date));
                  return (
                    <>
                      <span className="day-number">{cell.dayNumberText.replace("일", "")}</span>
                      {holiday && <span className="holiday-name" title={holiday}>{holiday}</span>}
                    </>
                  );
                }}
                dayCellClassNames={(cell) => {
                  const day = toDayKey(cell.date);
                  return [
                    ...(day === selectedDay ? ["day-selected"] : []),
                    ...(holidayName(holidays, day) ? ["day-holiday"] : []),
                  ];
                }}
                eventContent={(arg) => {
                  // 하루를 차지하는 일정은 막대로, 시간이 정해진 일정은 점으로 구분합니다.
                  const spansDay = arg.event.allDay || !arg.isStart || !arg.isEnd;
                  return (
                    <span
                      className={spansDay ? "chip chip-bar" : "chip"}
                      style={arg.event.extendedProps.style}
                      title={arg.event.title}
                    >
                      {arg.event.title}
                    </span>
                  );
                }}
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
                  setShownMonth(dates.view.currentStart);
                }}
              />
            </div>
          </section>

          <aside className="details">
            <div className="details-header">
              <div className="details-heading">
                <p className={selected.relative === "오늘" ? "details-eyebrow today" : "details-eyebrow"}>
                  {selected.relative && `${selected.relative} · `}
                  {selected.weekday}
                </p>
                <h2>{selected.heading}</h2>
                {selectedHoliday && <p className="details-holiday">{selectedHoliday}</p>}
              </div>
              <button
                className="add-button"
                disabled={!googleConnected}
                title={googleConnected ? "일정 추가" : "Google에 로그인하면 일정을 추가할 수 있습니다."}
                aria-label="일정 추가"
                onClick={() => openNewEvent(selectedDay)}
              >
                <Icon name="plus" size={18} />
              </button>
            </div>

            {dayEvents.length === 0 ? (
              <div className="empty">
                <p>일정이 없습니다</p>
                {googleConnected && <p className="muted">날짜를 두 번 누르면 일정을 추가할 수 있습니다.</p>}
              </div>
            ) : (
              <ul className="events">
                {dayEvents.map((event) => (
                  <EventRow
                    key={`${event.provider}:${event.id}`}
                    event={event}
                    now={minuteNow}
                    onEdit={() =>
                      invoke("open_event_editor", {
                        date: selectedDay,
                        target: { calendarId: event.calendar_id, eventId: event.id },
                      })
                    }
                  />
                ))}
              </ul>
            )}

            {status && status.rooms.length > 0 && (
              <RoomSchedules names={status.rooms} bookings={roomBookings} day={selectedDay} now={minuteNow} />
            )}

            <Notices
              statuses={statuses}
              errors={errors}
              staleSince={staleSince}
              shortcutError={status?.shortcut_error ?? null}
              onConnect={connect}
            />
          </aside>
        </div>
        {editorOpen && <div className="modal-backdrop" onMouseDown={() => invoke("focus_event_editor")} />}
      </div>
    </main>
  );
}

function App() {
  const params = new URLSearchParams(window.location.search);
  const date = params.get("date") ?? toDayKey(new Date());
  const view = params.get("view");
  if (view === "new-event") {
    return <EventEditor date={date} />;
  }
  if (view === "edit-event") {
    const target = { calendarId: params.get("calendarId") ?? "", eventId: params.get("eventId") ?? "" };
    return <EventEditor date={date} target={target} />;
  }
  return <Widget />;
}

export default App;
