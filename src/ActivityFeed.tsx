import { useEffect, useRef, useState } from "react";
import type { ActivityItem } from "./teams";
import { ACTIVITY_ID, plainText, teamsData } from "./teamsData";

function activityTime(value: number) {
  const date = new Date(value);
  return date.toDateString() === new Date().toDateString()
    ? date.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString("ko-KR", { month: "numeric", day: "numeric" });
}

function title(item: ActivityItem, names: Map<string, string>) {
  const [first] = item.actors;
  const actor = first?.name ?? (first?.id && names.get(first.id)) ?? "알 수 없는 사용자";
  if (item.kind === "reaction") {
    const others = item.actors.length > 1 ? ` 외 ${item.actors.length - 1}명` : "";
    return `${actor} 님${others}이 내 메시지에 반응했습니다.`;
  }
  if (item.kind === "reply") return `${actor} 님이 스레드의 메시지에 회신함`;
  if (item.conversation.chatId) return `${actor} 님이 채팅에서 나를 멘션함`;
  return item.parent_id ? `${actor} 님이 스레드에서 나를 멘션함` : `${actor} 님이 회원님을 멘션했습니다.`;
}

function location(item: ActivityItem) {
  return item.conversation.chatId ? `채팅 › ${item.conversation.name}` : item.conversation.name.replace(" · ", " › ");
}

export default function ActivityFeed({ onOpen }: { onOpen: (item: ActivityItem) => void }) {
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [mentionsOnly, setMentionsOnly] = useState(false);
  const [opened, setOpened] = useState<Set<string>>(() => new Set());
  const [names, setNames] = useState<Map<string, string>>(() => new Map());
  // Items newer than the mark when the feed opened stay bold for this visit, like Teams.
  const [seenBefore, setSeenBefore] = useState(() => teamsData.activityMark());
  const requested = useRef(new Set<string>());
  const items = teamsData.activities();
  const account = teamsData.activityAccount();
  const latest = items[0]?.time ?? 0;

  useEffect(() => { if (seenBefore === undefined) setSeenBefore(teamsData.activityMark()); });

  useEffect(() => {
    if (!latest || document.hidden) return;
    const timer = window.setTimeout(() => void teamsData.markRead(ACTIVITY_ID, account, latest), 900);
    return () => window.clearTimeout(timer);
  }, [latest, account]);

  // Graph often omits reactor names; resolve them from the conversation's members.
  useEffect(() => {
    for (const item of items) {
      if (!item.actors.some(actor => !actor.name && actor.id && !names.has(actor.id))) continue;
      const key = JSON.stringify([account, item.conversation.id]);
      if (requested.current.has(key)) continue;
      requested.current.add(key);
      void teamsData.members(item.conversation, account).then(members => setNames(previous => {
        const next = new Map(previous);
        members.forEach(member => next.set(member.userId, member.displayName));
        return next;
      })).catch(() => { /* Keep the generic name. */ });
    }
  });

  const unread = (item: ActivityItem) => seenBefore !== undefined && item.time > seenBefore && !opened.has(item.key);
  const visible = items.filter(item => (!unreadOnly || unread(item)) && (!mentionsOnly || item.kind === "mention"));
  return <div className="teams-conversation" role="tabpanel" id="teams-activity-view" aria-labelledby="activity-tab">
    <div className="teams-conversation-bar teams-activity-filters" role="group" aria-label="활동 필터">
      <button className="teams-filter-chip" aria-pressed={unreadOnly} onClick={() => setUnreadOnly(value => !value)}>읽지 않음</button>
      <button className="teams-filter-chip" aria-pressed={mentionsOnly} onClick={() => setMentionsOnly(value => !value)}>@멘션</button>
    </div>
    {teamsData.scanError && <p className="teams-scan-note">일부 채널의 활동을 확인하지 못했습니다. {teamsData.scanError}</p>}
    <div className="teams-messages teams-activity-list">
      {visible.length === 0 ? <p className="teams-placeholder">{items.length === 0
        ? "아직 확인한 활동이 없습니다. 채널과 채팅을 순서대로 확인하는 중입니다."
        : "조건에 맞는 활동이 없습니다."}</p>
        : visible.map(item => {
          const label = title(item, names);
          const text = plainText(item.body, item.body_type);
          const first = item.actors[0];
          const avatar = (first?.name ?? (first?.id && names.get(first.id)) ?? "?").slice(0, 1);
          const badge = item.kind === "mention" ? "@" : item.kind === "reply" ? "↩" : item.emojis[0] ?? "☺";
          return <button key={item.key} className={`teams-activity-item${unread(item) ? " unread" : ""}`}
            aria-label={`${label}${unread(item) ? ", 읽지 않음" : ""}, ${location(item)}`}
            onClick={() => { setOpened(previous => new Set(previous).add(item.key)); onOpen(item); }}>
            <span className="teams-avatar" aria-hidden="true">{avatar}<span className={`teams-activity-badge ${item.kind}`}>{badge}</span></span>
            <span className="teams-chat-copy">
              <span className="teams-chat-title"><strong>{label}</strong><time dateTime={new Date(item.time).toISOString()}>{activityTime(item.time)}</time></span>
              {item.kind === "reaction" && item.emojis.length > 1 && <span className="teams-activity-emojis" aria-hidden="true">{item.emojis.join(" ")}</span>}
              {text && <span className="teams-activity-text">{text}</span>}
              <span className="teams-activity-location">{location(item)}</span>
            </span>
          </button>;
        })}
    </div>
  </div>;
}
