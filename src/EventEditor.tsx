import { FormEvent, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { RemoteEvent, moveEndWithStart, oneHourAfter, previousDay, suggestedStartTime } from "./events";

type GoogleCalendar = { id: string; name: string; primary: boolean };

export type EditTarget = { calendarId: string; eventId: string };

function EventEditor({ date, target }: { date: string; target?: EditTarget }) {
  const [calendars, setCalendars] = useState<GoogleCalendar[]>([]);
  const [calendarId, setCalendarId] = useState(target?.calendarId ?? "");
  const [loaded, setLoaded] = useState(!target);
  const [title, setTitle] = useState("");
  const [allDay, setAllDay] = useState(false);
  const [start, setStart] = useState(() => ({ day: date, time: suggestedStartTime(date, new Date()) }));
  const [end, setEnd] = useState(() => oneHourAfter({ day: date, time: suggestedStartTime(date, new Date()) }));
  const [location, setLocation] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") getCurrentWindow().close();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, []);

  useEffect(() => {
    invoke<GoogleCalendar[]>("google_calendars").then(
      (items) => {
        setCalendars(items);
        if (!target) setCalendarId(items[0]?.id ?? "");
      },
      (reason) => setError(String(reason)),
    );
  }, [target?.calendarId]);

  useEffect(() => {
    if (!target) return;
    invoke<RemoteEvent>("google_event", { ...target }).then(
      (event) => {
        setTitle(event.title);
        setAllDay(event.all_day);
        const startDay = event.start.slice(0, 10);
        const endDay = event.end.slice(0, 10);
        if (event.all_day) {
          setStart((current) => ({ ...current, day: startDay }));
          setEnd((current) => ({ ...current, day: previousDay(endDay) }));
        } else {
          setStart({ day: startDay, time: event.start.slice(11) });
          setEnd({ day: endDay, time: event.end.slice(11) });
        }
        setLocation(event.location ?? "");
        setLoaded(true);
      },
      (reason) => setError(String(reason)),
    );
  }, [target?.calendarId, target?.eventId]);

  // 입력 중 값을 지우면 빈 문자열이 오므로, 그때는 종료를 옮기지 않습니다.
  function changeStart(next: { day: string; time: string }) {
    if (next.day && next.time && start.day && start.time && end.day && end.time) {
      setEnd(moveEndWithStart(start, next, end));
    }
    setStart(next);
  }

  const endTooEarly = allDay ? end.day < start.day : `${end.day} ${end.time}` <= `${start.day} ${start.time}`;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError("");
    const fields = {
      calendar_id: calendarId,
      title,
      start_date: start.day,
      end_date: end.day,
      start_time: allDay ? null : start.time,
      end_time: allDay ? null : end.time,
      location,
    };
    try {
      if (target) {
        await invoke("update_google_event", { eventId: target.eventId, event: fields });
      } else {
        await invoke("create_google_event", { event: fields });
      }
      await getCurrentWindow().close();
    } catch (reason) {
      setError(String(reason));
      setSaving(false);
    }
  }

  // 되돌릴 수 없으므로 버튼을 한 번 더 눌러야 삭제합니다.
  async function deleteEvent() {
    if (!confirmingDelete) {
      setConfirmingDelete(true);
      return;
    }
    setSaving(true);
    setError("");
    try {
      await invoke("delete_google_event", { ...target });
      await getCurrentWindow().close();
    } catch (reason) {
      setError(String(reason));
      setSaving(false);
      setConfirmingDelete(false);
    }
  }

  return (
    <form className="editor" onSubmit={submit}>
      <header
        className="editor-bar"
        onMouseDown={(event) => {
          if (event.button === 0 && !(event.target as Element).closest("button")) {
            getCurrentWindow().startDragging();
          }
        }}
      >
        <button type="button" className="text-button" onClick={() => getCurrentWindow().close()}>취소</button>
        <h1>{target ? "일정 편집" : "새 일정"}</h1>
        <button
          type="submit"
          className="primary"
          disabled={saving || !calendarId || !loaded || endTooEarly}
        >
          {saving ? "저장 중" : "저장"}
        </button>
      </header>

      <div className="editor-group">
        <input
          className="editor-title-input"
          aria-label="제목"
          placeholder="제목"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          autoFocus
          required
        />
        <input
          aria-label="장소"
          placeholder="장소"
          value={location}
          onChange={(e) => setLocation(e.target.value)}
        />
      </div>

      <div className="editor-group">
        <label className="editor-row">
          <span>종일</span>
          <input className="switch" type="checkbox" role="switch" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} />
        </label>
        <div className="editor-row">
          <span>시작</span>
          <div className="editor-when">
            <input
              type="date"
              aria-label="시작일"
              value={start.day}
              onChange={(e) => changeStart({ ...start, day: e.target.value })}
              required
            />
            {!allDay && (
              <input
                type="time"
                aria-label="시작 시각"
                value={start.time}
                onChange={(e) => changeStart({ ...start, time: e.target.value })}
                required
              />
            )}
          </div>
        </div>
        <div className={endTooEarly ? "editor-row invalid" : "editor-row"}>
          <span>종료</span>
          <div className="editor-when">
            <input
              type="date"
              aria-label="종료일"
              value={end.day}
              onChange={(e) => setEnd({ ...end, day: e.target.value })}
              required
            />
            {!allDay && (
              <input
                type="time"
                aria-label="종료 시각"
                value={end.time}
                onChange={(e) => setEnd({ ...end, time: e.target.value })}
                required
              />
            )}
          </div>
        </div>
      </div>
      {endTooEarly && <p className="error editor-hint">종료는 시작보다 늦어야 합니다.</p>}

      <div className="editor-group">
        <label className="editor-row">
          <span>캘린더</span>
          <select
            value={calendarId}
            disabled={!!target}
            onChange={(e) => setCalendarId(e.target.value)}
            required
          >
            {calendars.map((calendar) => (
              <option key={calendar.id} value={calendar.id}>
                {calendar.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {error && <p className="error editor-hint">{error}</p>}

      {target && (
        <div className="editor-group">
          <button
            type="button"
            className={confirmingDelete ? "editor-delete confirming" : "editor-delete"}
            disabled={saving || !loaded}
            onClick={deleteEvent}
          >
            {confirmingDelete ? "한 번 더 누르면 삭제됩니다" : "일정 삭제"}
          </button>
        </div>
      )}
    </form>
  );
}

export default EventEditor;
