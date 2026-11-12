import { FormEvent, memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { TeamsChannel } from "./teams";
import { conversationTarget } from "./teamsData";

export type Mention = { start: number; end: number; userId: string; displayName: string };
export type ComposerDraft = { text: string; mentions: Mention[] };
type Member = { userId: string; displayName: string; email: string };
type Query = { start: number; end: number; text: string };
export type PastedImage = { id: number; contentType: string; data: string; url: string };
const MAX_IMAGES = 5;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
let imageId = 0;
const readImage = (file: File) => new Promise<PastedImage>((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve({ id: ++imageId, contentType: file.type,
    data: String(reader.result).split(",")[1] ?? "", url: URL.createObjectURL(file) });
  reader.onerror = () => reject(reader.error);
  reader.readAsDataURL(file);
});
export const emptyDraft =(): ComposerDraft => ({ text: "", mentions: [] });

// Preserve mention identities only when their exact text survives an edit.
export function editMentions(previous: ComposerDraft, text: string): Mention[] {
  let start = 0;
  while (start < previous.text.length && start < text.length && previous.text[start] === text[start]) start++;
  let suffix = 0;
  while (suffix < previous.text.length - start && suffix < text.length - start
    && previous.text[previous.text.length - suffix - 1] === text[text.length - suffix - 1]) suffix++;
  const end = previous.text.length - suffix;
  const delta = text.length - previous.text.length;
  return previous.mentions.flatMap((mention) => {
    if (mention.end <= start) return [mention];
    if (mention.start >= end) return [{ ...mention, start: mention.start + delta, end: mention.end + delta }];
    return [];
  }).filter((mention) => text.slice(mention.start, mention.end) === `@${mention.displayName}`);
}

export default memo(function TeamsComposer({ channel, reply, initialDraft, sending, error, onDraftChange, onSend, onReconnect }: {
  channel: TeamsChannel; reply: boolean; initialDraft: ComposerDraft; sending: boolean; error: string;
  onDraftChange: (draft: ComposerDraft) => void;
  onSend: (draft: ComposerDraft, images: PastedImage[]) => Promise<boolean>;
  onReconnect: () => void;
}) {
  const [images, setImages] = useState<PastedImage[]>([]);
  const imagesRef = useRef<PastedImage[]>([]);
  const [imageError, setImageError] = useState("");
  imagesRef.current = images;
  useEffect(() => () => imagesRef.current.forEach((image) => URL.revokeObjectURL(image.url)), []);

  async function paste(event: React.ClipboardEvent<HTMLTextAreaElement>) {
    const files = [...event.clipboardData.files].filter((file) => file.type.startsWith("image/"));
    if (!files.length) return;
    event.preventDefault();
    const allowed = files.filter((file) => ["image/png", "image/jpeg", "image/gif"].includes(file.type) && file.size <= MAX_IMAGE_BYTES);
    const room = MAX_IMAGES - imagesRef.current.length;
    setImageError(allowed.length < files.length ? "PNG·JPEG·GIF 4MB 이하 이미지만 붙여넣을 수 있습니다."
      : allowed.length > room ? `이미지는 최대 ${MAX_IMAGES}장까지 첨부할 수 있습니다.` : "");
    try {
      const read = await Promise.all(allowed.slice(0, Math.max(0, room)).map(readImage));
      if (mounted.current) setImages((old) => [...old, ...read].slice(0, MAX_IMAGES));
    } catch { setImageError("이미지를 읽을 수 없습니다."); }
  }
  function removeImage(id: number) {
    setImages((old) => old.filter((image) => { if (image.id === id) URL.revokeObjectURL(image.url); return image.id !== id; }));
  }
  const input = useRef<HTMLTextAreaElement>(null);
  const startingText = useRef(initialDraft.text);
  const current = useRef(initialDraft);
  const composing = useRef(false);
  const compositionEnded = useRef(-Infinity);
  const submitting = useRef(false);
  const mounted = useRef(true);
  const [hasText, setHasText] = useState(Boolean(initialDraft.text.trim()));
  const [mentions, setMentions] = useState(initialDraft.mentions);
  const [query, setQuery] = useState<Query | null>(null);
  const [members, setMembers] = useState<Member[] | null>(null);
  const [memberError, setMemberError] = useState("");
  const [memberAttempt, setMemberAttempt] = useState(0);
  const [selected, setSelected] = useState(0);
  const [menuHeight, setMenuHeight] = useState(180);
  const popup = useRef<HTMLDivElement>(null);
  const memberPending = useRef(false);

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const showing = query !== null;
  useLayoutEffect(() => {
    if (!showing) return;
    const form = input.current?.form;
    const conversation = form?.closest(".teams-conversation");
    if (!form || !conversation) return;
    const measure = () => setMenuHeight(Math.max(80, Math.min(230,
      form.getBoundingClientRect().top - conversation.getBoundingClientRect().top - 6)));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(form); observer.observe(conversation);
    return () => observer.disconnect();
  }, [showing]);
  useEffect(() => {
    if (!showing || members !== null || memberError || memberPending.current) return;
    memberPending.current = true;
    void invoke<Member[]>("teams_members", conversationTarget(channel))
      .then((value) => { if (mounted.current) setMembers(value); })
      .catch((reason) => { if (mounted.current) setMemberError(String(reason)); })
      .finally(() => { memberPending.current = false; });
  }, [showing, members, memberError, memberAttempt, channel.teamId, channel.channelId, channel.chatId]);

  function updateQuery(field: HTMLTextAreaElement) {
    if (composing.current || field.selectionStart !== field.selectionEnd) { setQuery(null); return; }
    const caret = field.selectionStart;
    if (current.current.mentions.some((mention) => caret > mention.start && caret <= mention.end)) { setQuery(null); return; }
    const match = /(?:^|\s)@([^@\n]{0,80})$/.exec(field.value.slice(0, caret));
    const next = match ? { start: caret - match[1].length - 1, end: caret, text: match[1] } : null;
    if (next && current.current.mentions.some((mention) => mention.start === next.start)) { setQuery(null); return; }
    setQuery((old) => old?.start === next?.start && old?.end === next?.end && old?.text === next?.text ? old : next);
    if (query?.text !== next?.text || query?.start !== next?.start) setSelected(0);
  }

  function remember(text: string, nextMentions = editMentions(current.current, text)) {
    current.current = { text, mentions: nextMentions };
    onDraftChange(current.current);
    setHasText(Boolean(text.trim()));
    setMentions((old) => JSON.stringify(old) === JSON.stringify(nextMentions) ? old : nextMentions);
  }

  const search = query?.text.trim().toLocaleLowerCase() ?? "";
  const matches = (members ?? []).filter((member) => `${member.displayName} ${member.email}`.toLocaleLowerCase().includes(search)).slice(0, 20);
  const selectedIndex = Math.min(selected, Math.max(0, matches.length - 1));
  useEffect(() => {
    popup.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex, query?.text, members]);

  function choose(member: Member) {
    const field = input.current;
    if (!query || !field || composing.current) return;
    const label = `@${member.displayName}`;
    const nextText = field.value.slice(0, query.start) + label + " " + field.value.slice(query.end);
    if (nextText.length > 10000 || current.current.mentions.length >= 50) return;
    const nextMentions = editMentions(current.current, nextText);
    nextMentions.push({ start: query.start, end: query.start + label.length, userId: member.userId, displayName: member.displayName });
    field.value = nextText;
    remember(nextText, nextMentions.sort((a, b) => a.start - b.start));
    setQuery(null);
    field.focus({ preventScroll: true });
    field.setSelectionRange(query.start + label.length + 1, query.start + label.length + 1);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (composing.current || sending || submitting.current || (!current.current.text.trim() && !imagesRef.current.length)) return;
    const snapshot = current.current;
    const sentImages = imagesRef.current;
    submitting.current = true;
    setQuery(null);
    try {
      if (await onSend(snapshot, sentImages) && mounted.current && current.current === snapshot) {
        if (input.current) input.current.value = "";
        remember("", []);
        sentImages.forEach((image) => URL.revokeObjectURL(image.url));
        setImages((old) => old.filter((image) => !sentImages.includes(image)));
        input.current?.focus({ preventScroll: true });
      }
    } finally { submitting.current = false; }
  }

  return <form className="teams-composer" onSubmit={submit}>
    {query && <div className="teams-mention-popup" ref={popup} style={{ maxHeight: menuHeight }} onPointerDown={(event) => {
      if ((event.target as Element).closest("button")) event.preventDefault();
    }}>
      <div className="teams-mention-heading">멘션할 사람 선택 <span>↑↓ 선택 · Enter 확인 · Esc 닫기</span></div>
      {memberError ? <div className="teams-mention-status" role="alert"><p>{memberError}</p>
        <button type="button" onClick={() => { setMemberError(""); setMemberAttempt((attempt) => attempt + 1); }}>다시 시도</button>
        <button type="button" onClick={onReconnect}>Teams 다시 연결</button></div>
        : members === null ? <p className="teams-mention-status" role="status">채널 멤버를 불러오는 중…</p>
        : matches.length === 0 ? <p className="teams-mention-status">일치하는 멤버가 없습니다.</p>
        : <div role="listbox" id="teams-mention-list" aria-label="멘션 대상">
          {matches.map((member, index) => <button type="button" role="option" id={`teams-mention-${index}`}
            aria-selected={selectedIndex === index} key={member.userId} tabIndex={-1}
            onPointerDown={(event) => event.preventDefault()} onClick={() => choose(member)}>
            <strong>{member.displayName}</strong><span>{member.email}</span>
          </button>)}
        </div>}
    </div>}
    <textarea ref={input} defaultValue={startingText.current} maxLength={10000} rows={1} spellCheck={false}
      aria-label={reply ? "답글 입력" : `${channel.name} 메시지 입력`} aria-autocomplete="list"
      aria-controls={query ? "teams-mention-list" : undefined}
      aria-activedescendant={query && matches.length ? `teams-mention-${selectedIndex}` : undefined}
      onPaste={paste}
      disabled={sending} placeholder={reply ? "답글을 입력하세요 (@ 멘션 · 이미지 붙여넣기)" : `${channel.name}에 메시지 보내기 (@ 멘션 · 이미지 붙여넣기)`}
      data-tooltip="Enter로 전송 · Shift+Enter로 줄바꿈"
      onChange={(event) => { remember(event.currentTarget.value); if (!composing.current) updateQuery(event.currentTarget); }}
      onSelect={(event) => updateQuery(event.currentTarget)}
      onBlur={() => setQuery(null)}
      onCompositionStart={() => { composing.current = true; setQuery(null); }}
      onCompositionEnd={(event) => { composing.current = false; compositionEnded.current = performance.now(); remember(event.currentTarget.value); updateQuery(event.currentTarget); }}
      onKeyDown={(event) => {
        if (composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
        if (event.key === "Enter" && performance.now() - compositionEnded.current < 30) { event.preventDefault(); return; }
        if (query && event.key === "Escape") { event.preventDefault(); setQuery(null); return; }
        if (query && matches.length && ["ArrowDown", "ArrowUp"].includes(event.key)) {
          event.preventDefault(); setSelected((selectedIndex + (event.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length); return;
        }
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          if (event.repeat) return;
          if (query) { if (matches.length) choose(matches[selectedIndex]); return; }
          event.currentTarget.form?.requestSubmit();
        }
      }} />
    {images.length > 0 && <div className="teams-compose-images">{images.map((image) => <span key={image.id}>
      <img src={image.url} alt="첨부 이미지 미리보기" />
      <button type="button" aria-label="이미지 제거" disabled={sending} onClick={() => removeImage(image.id)}>×</button></span>)}</div>}
    {(error || imageError) && <p className="error" role="alert">{error || imageError}</p>}
    <div className="teams-compose-footer"><button className="primary" type="submit"
      data-tooltip="Enter로 전송 · Shift+Enter로 줄바꿈" disabled={sending || (!hasText && !images.length)}>{sending ? "전송 중…" : "보내기"}</button></div>
    {mentions.length > 0 && <div className="teams-selected-mentions" aria-label="선택된 멘션">멘션: {mentions.map((mention, index) =>
      <span key={`${mention.start}:${mention.userId}`}>{index > 0 && ", "}{mention.displayName}</span>)}</div>}
  </form>;
});
