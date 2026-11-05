export type Provider = "google" | "microsoft";

export type RemoteEvent = {
  id: string;
  title: string;
  start: string;
  end: string;
  all_day: boolean;
  location: string | null;
  calendar_id: string | null;
  color: string | null;
  text_color: string | null;
  editable: boolean;
};

export type CalendarEvent = RemoteEvent & { provider: Provider };

export const PROVIDER_LABELS: Record<Provider, string> = {
  google: "Google",
  microsoft: "Outlook",
};

export function toDayKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

// Google 종일 일정의 종료일은 마지막 날의 다음 날이라 입력 칸에는 하루 전 날짜를 보여 줍니다.
export function previousDay(day: string): string {
  const [year, month, date] = day.split("-").map(Number);
  return toDayKey(new Date(year, month - 1, date - 1));
}

// 시작과 종료는 "YYYY-MM-DD" 또는 "YYYY-MM-DD HH:mm" 형식의 현지 시각입니다.
export function occursOn(event: RemoteEvent, day: string): boolean {
  const startDay = event.start.slice(0, 10);
  const endDay = event.end.slice(0, 10);
  if (day < startDay || day > endDay) return false;
  if (day < endDay) return true;
  // 종일 일정의 종료일과 자정에 끝나는 일정의 종료일은 해당 날짜에 포함되지 않습니다.
  if (event.all_day) return startDay === endDay;
  return startDay === endDay || event.end.slice(11) !== "00:00";
}

export function holidayName(holidays: RemoteEvent[], day: string): string {
  return holidays
    .filter((holiday) => occursOn(holiday, day))
    .map((holiday) => holiday.title)
    .join(", ");
}

export function compareEvents(a: RemoteEvent, b: RemoteEvent): number {
  if (a.all_day !== b.all_day) return a.all_day ? -1 : 1;
  return a.start.localeCompare(b.start);
}

// "YYYY-MM-DD HH:mm:ss"를 "MM/DD HH:mm"으로 줄입니다.
export function formatFetchedAt(fetchedAt: string): string {
  return fetchedAt.slice(5, 16).replace("-", "/");
}

export function formatEventTime(event: RemoteEvent): string {
  if (event.all_day) return "종일";
  const startDay = event.start.slice(0, 10);
  const endDay = event.end.slice(0, 10);
  if (startDay === endDay) return `${event.start.slice(11)} ~ ${event.end.slice(11)}`;
  return `${event.start.slice(5).replace("-", "/")} ~ ${event.end.slice(5).replace("-", "/")}`;
}
