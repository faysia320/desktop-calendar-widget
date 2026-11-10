import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { TeamsChannel, TeamsMember, TeamsReaction } from "./teams";
import { teamsData } from "./teamsData";

export default function ReactionButton({ reaction, channel, account, disabled, onClick }: {
  reaction: TeamsReaction; channel: TeamsChannel; account: string | null; disabled: boolean; onClick: () => void;
}) {
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const tooltip = useRef<HTMLDivElement>(null);
  const dismissTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [members, setMembers] = useState<TeamsMember[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const users = reaction.users ?? [];
  const missingNames = users.some(user => !user.name && user.id && !user.mine);
  function show() { clearTimeout(dismissTimer.current); setOpen(true); }
  function hideSoon() { clearTimeout(dismissTimer.current); dismissTimer.current = setTimeout(() => setOpen(false), 150); }
  useEffect(() => () => clearTimeout(dismissTimer.current), []);
  useEffect(() => {
    if (!open || !missingNames) return;
    let cancelled = false;
    setLoading(true); setError("");
    void teamsData.members(channel, account).then(value => { if (!cancelled) setMembers(value); })
      .catch(() => { if (!cancelled) setError("일부 이름을 불러오지 못했습니다. Teams에서 확인해 주세요."); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, missingNames, channel.id, account]);
  useLayoutEffect(() => {
    if (!open || !button.current || !tooltip.current) return;
    const anchor = button.current.getBoundingClientRect();
    const rect = tooltip.current.getBoundingClientRect();
    const above = anchor.top - rect.height - 6;
    setPosition({
      left: Math.max(8, Math.min(anchor.left, window.innerWidth - rect.width - 8)),
      top: Math.max(8, Math.min(above >= 8 ? above : anchor.bottom + 6, window.innerHeight - rect.height - 8)),
    });
  }, [open, members, loading, error, reaction]);
  useEffect(() => {
    if (!open) return;
    const dismiss = () => setOpen(false);
    const scroll = (event: Event) => { if (!tooltip.current?.contains(event.target as Node)) dismiss(); };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") dismiss(); };
    window.addEventListener("resize", dismiss); window.addEventListener("blur", dismiss);
    document.addEventListener("scroll", scroll, true); document.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("resize", dismiss); window.removeEventListener("blur", dismiss);
      document.removeEventListener("scroll", scroll, true); document.removeEventListener("keydown", key);
    };
  }, [open]);
  const action = reaction.reaction_type == null ? "Teams에서 보기" : reaction.mine ? "내 반응 취소" : "반응 추가";
  return <>
    <button ref={button} type="button" className="teams-reaction" disabled={disabled}
      aria-pressed={reaction.mine} aria-describedby={open ? id : undefined}
      aria-label={`${reaction.label} ${reaction.count}명${reaction.mine ? ", 내 반응" : ""} · ${action}`}
      onMouseEnter={show} onMouseLeave={hideSoon} onFocus={show} onBlur={() => setOpen(false)}
      onClick={() => { setOpen(false); onClick(); }}>
      <span aria-hidden="true">{reaction.emoji}</span><span aria-hidden="true">{reaction.count}</span>
    </button>
    {open && createPortal(<div ref={tooltip} id={id} role="tooltip" className="teams-reaction-tooltip"
      style={position} onMouseEnter={show} onMouseLeave={hideSoon}>
      <strong>{reaction.emoji} {reaction.label} · {reaction.count}명</strong>
      <ul>{users.map((user, index) => {
        const name = user.name || members.find(member => member.userId === user.id)?.displayName;
        return <li key={`${user.id ?? "unknown"}-${index}`}>{name ? `${name}${user.mine ? " (나)" : ""}`
          : user.mine ? "나" : loading && user.id ? "이름 확인 중…" : "이름 정보 없음"}</li>;
      })}</ul>
      {!users.length && <p>반응자 정보가 없습니다.</p>}
      {error && <p>{error}</p>}
      <small>{action}</small>
    </div>, document.body)}
  </>;
}
