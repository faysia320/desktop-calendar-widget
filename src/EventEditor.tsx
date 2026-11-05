import { FormEvent, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

function EventEditor({ date }: { date: string }) {
  const [title, setTitle] = useState("");
  const [allDay, setAllDay] = useState(false);
  const [startDate, setStartDate] = useState(date);
  const [endDate, setEndDate] = useState(date);
  const [startTime, setStartTime] = useState("09:00");
  const [endTime, setEndTime] = useState("10:00");
  const [location, setLocation] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      await invoke("create_google_event", {
        event: {
          title,
          start_date: startDate,
          end_date: endDate,
          start_time: allDay ? null : startTime,
          end_time: allDay ? null : endTime,
          location,
        },
      });
      await getCurrentWindow().close();
    } catch (reason) {
      setError(String(reason));
      setSaving(false);
    }
  }

  return (
    <form className="editor" onSubmit={submit}>
      <h1>Google 캘린더에 일정 추가</h1>

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
        <button type="button" onClick={() => getCurrentWindow().close()}>취소</button>
        <button type="submit" className="primary" disabled={saving}>
          {saving ? "저장 중" : "저장"}
        </button>
      </div>
    </form>
  );
}

export default EventEditor;
