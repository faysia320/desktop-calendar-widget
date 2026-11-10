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
  meeting?: MeetingDetails;
  meeting_notice?: string;
};

// 내 일정 또는 공유된 회의실 캘린더에서 읽은 상세입니다.
export type MeetingDetails = {
  subject: string;
  summary: string | null;
  attendees: string[];
  organizer?: string | null;
  participants?: { name: string; kind: string | null; response: string | null }[];
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

const MINUTES_PER_DAY = 24 * 60;
const ROOM_DEFAULT_HOURS = { from: 9, to: 18 };
const ROOM_COLOR_COUNT = 8;

// "YYYY-MM-DD HH:mm"에서 그날 자정부터 지난 분을 구합니다.
export function minuteOfDay(time: string): number {
  return Number(time.slice(11, 13)) * 60 + Number(time.slice(14, 16));
}

// 여러 날에 걸친 일정은 해당 날짜 안으로 잘라서 돌려줍니다.
export function minutesOnDay(event: RemoteEvent, day: string): { start: number; end: number } {
  return {
    start: event.start.slice(0, 10) < day ? 0 : minuteOfDay(event.start),
    end: event.end.slice(0, 10) > day ? MINUTES_PER_DAY : minuteOfDay(event.end),
  };
}

// 기본 시간대를 벗어난 예약이 있으면 잘리지 않도록 시간축을 넓힙니다.
export function roomHourRange(bookings: RemoteEvent[], day: string): { from: number; to: number } {
  return bookings.reduce(({ from, to }, booking) => {
    const { start, end } = minutesOnDay(booking, day);
    return {
      from: Math.min(from, Math.floor(start / 60)),
      to: Math.max(to, Math.ceil(end / 60)),
    };
  }, ROOM_DEFAULT_HOURS);
}

// 회의실 예약의 제목이 예약자 이름입니다. 같은 사람은 어느 날이든 같은 색을 받되,
// 그날 먼저 차지한 색과 겹치면 다음 색을 씁니다. 색보다 예약자가 많으면 같은 색을 나눠 씁니다.
export function roomColorSlots(bookings: RemoteEvent[]): Map<string, number> {
  const slots = new Map<string, number>();
  const owners = [...new Set(bookings.map((booking) => booking.title.trim()))].sort();
  for (const owner of owners) {
    let slot = [...owner].reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) >>> 0, 0) % ROOM_COLOR_COUNT;
    const taken = new Set(slots.values());
    while (taken.has(slot) && taken.size < ROOM_COLOR_COUNT) slot = (slot + 1) % ROOM_COLOR_COUNT;
    slots.set(owner, slot);
  }
  return slots;
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

// "YYYY-MM-DD"를 "11/5"로 줄입니다.
function formatShortDay(day: string): string {
  const [, month, date] = day.split("-").map(Number);
  return `${month}/${date}`;
}

export function formatEventTime(event: RemoteEvent): string {
  const startDay = event.start.slice(0, 10);
  const endDay = event.end.slice(0, 10);
  if (event.all_day) {
    const lastDay = previousDay(endDay);
    return lastDay > startDay ? `종일 · ${formatShortDay(startDay)} – ${formatShortDay(lastDay)}` : "종일";
  }
  const startTime = event.start.slice(11);
  const endTime = event.end.slice(11);
  if (startDay === endDay) return `${startTime} – ${endTime}`;
  return `${formatShortDay(startDay)} ${startTime} – ${formatShortDay(endDay)} ${endTime}`;
}

function parseDay(day: string): Date {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(year, month - 1, date);
}

// 상세 패널 제목에 쓰는 날짜 표현입니다.
export function describeDay(day: string, today: string) {
  const date = parseDay(day);
  const offset = Math.round((date.getTime() - parseDay(today).getTime()) / 86_400_000);
  return {
    heading: `${date.getMonth() + 1}월 ${date.getDate()}일`,
    weekday: date.toLocaleDateString("ko-KR", { weekday: "long" }),
    relative: { [-1]: "어제", 0: "오늘", 1: "내일" }[offset] ?? null,
  };
}

function formatClock(date: Date): string {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

// 일정의 시작, 종료와 같은 "YYYY-MM-DD HH:mm" 형식이라 문자열로 비교할 수 있습니다.
export function toMinuteKey(date: Date): string {
  return `${toDayKey(date)} ${formatClock(date)}`;
}

export type EventPhase = "past" | "ongoing" | "upcoming";

export function eventPhase(event: RemoteEvent, now: string): EventPhase {
  if (event.end <= now) return "past";
  return !event.all_day && event.start <= now ? "ongoing" : "upcoming";
}

// 오늘은 다음 정시, 다른 날은 오전 9시를 새 일정의 시작으로 제안합니다.
export function suggestedStartTime(day: string, now: Date): string {
  if (day !== toDayKey(now) || now.getHours() >= 23) return "09:00";
  return `${String(now.getHours() + 1).padStart(2, "0")}:00`;
}

export type DayTime = { day: string; time: string };

function toDate({ day, time }: DayTime): Date {
  const [hours, minutes] = time.split(":").map(Number);
  const date = parseDay(day);
  date.setHours(hours, minutes);
  return date;
}

function addMilliseconds(moment: DayTime, milliseconds: number): DayTime {
  const moved = new Date(toDate(moment).getTime() + milliseconds);
  return { day: toDayKey(moved), time: formatClock(moved) };
}

export function oneHourAfter(start: DayTime): DayTime {
  return addMilliseconds(start, 3_600_000);
}

// 시작을 옮기면 일정 길이가 유지되도록 종료도 같은 만큼 옮깁니다.
export function moveEndWithStart(previousStart: DayTime, nextStart: DayTime, end: DayTime): DayTime {
  return addMilliseconds(end, toDate(nextStart).getTime() - toDate(previousStart).getTime());
}
