import { FormEvent, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { RemoteEvent, previousDay } from "./events";

type GoogleCalendar = { id: string; name: string; primary: boolean };

export type EditTarget = { calendarId: string; eventId: string };

function EventEditor({ date, target }: { date: string; target?: EditTarget }) {
  const [calendars, setCalendars] = useState<GoogleCalendar[]>([]);
  const [calendarId, setCalendarId] = useState(target?.calendarId ?? "");
  const [loaded, setLoaded] = useState(!target);
  const [title, setTitle] = useState("");
  const [allDay, setAllDay] = useState(false);
  const [startDate, setStartDate] = useState(date);
  const [endDate, setEndDate] = useState(date);
  const [startTime, setStartTime] = useState("09:00");
  const [endTime, setEndTime] = useState("10:00");
  const [location, setLocation] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [confirmingDelete, setConfirmingDelete] = useState(false);

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
        setStartDate(event.start.slice(0, 10));
        setEndDate(event.all_day ? previousDay(event.end.slice(0, 10)) : event.end.slice(0, 10));
        if (!event.all_day) {
          setStartTime(event.start.slice(11));
          setEndTime(event.end.slice(11));
        }
        setLocation(event.location ?? "");
        setLoaded(true);
      },
      (reason) => setError(String(reason)),
    );
  }, [target?.calendarId, target?.eventId]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError("");
    const fields = {
      calendar_id: calendarId,
      title,
      start_date: startDate,
      end_date: endDate,
      start_time: allDay ? null : startTime,
      end_time: allDay ? null : endTime,
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
      <h1>{target ? "Google 캘린더 일정 편집" : "Google 캘린더에 일정 추가"}</h1>

      <label>
        캘린더
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

      <label>
        제목
        <input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus required />
      </label>

      <label className="checkbox">
        <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} />
        종일
      </label>

      <div className="editor-row">
        <label>
          시작일
          <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} required />
        </label>
        {!allDay && (
          <label>
            시작 시각
            <input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} required />
          </label>
        )}
      </div>

      <div className="editor-row">
        <label>
          종료일
          <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} required />
        </label>
        {!allDay && (
          <label>
            종료 시각
            <input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} required />
          </label>
        )}
      </div>

      <label>
        장소
        <input value={location} onChange={(e) => setLocation(e.target.value)} />
      </label>

      {error && <p className="error">{error}</p>}

      <div className="editor-actions">
        {target && (
          <button
            type="button"
            className={confirmingDelete ? "editor-delete confirming" : "editor-delete"}
            disabled={saving || !loaded}
            onClick={deleteEvent}
          >
            {confirmingDelete ? "정말 삭제" : "삭제"}
          </button>
        )}
        <button type="button" onClick={() => getCurrentWindow().close()}>취소</button>
        <button type="submit" className="primary" disabled={saving || !calendarId || !loaded}>
          {saving ? "저장 중" : "저장"}
        </button>
      </div>
    </form>
  );
}

export default EventEditor;
