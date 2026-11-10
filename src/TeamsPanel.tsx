import { ReactNode, FormEvent, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Icon } from "./icons";
import { htmlToText } from "./news";
import {
  ACTIVE_CHANNEL_KEY, ChannelSettings, TeamsChannel, TeamsChat, TeamsMessage, TeamsReaction, TeamsStatus,
  chatChannel, decodeChannels, parseChannelLink, readChannels,
} from "./teams";
import "./TeamsPanel.css";
import TeamsComposer, { ComposerDraft, emptyDraft } from "./TeamsComposer";
import MessageBody from "./MessageBody";
import ChannelTabs, { CHATS_TAB_ID, NEWS_TAB_ID } from "./ChannelTabs";
import { conversationTarget, teamsData } from "./teamsData";
import ReactionButton from "./ReactionButton";

const POLL_INTERVAL = 60_000;
const CHAT_POLL_INTERVAL = 60_000;
// One untabbed channel per step keeps all-channel mention checks under Graph limits.
const SCAN_INTERVAL = 15_000;

const REACTION_CHOICES = [
  ["👍", "좋아요"], ["❤️", "하트"], ["😆", "웃음"], ["😮", "놀람"],
  ["😢", "슬픔"], ["😠", "화남"], ["🎉", "축하"], ["👏", "박수"],
  ["🙏", "감사"], ["✅", "확인"], ["👀", "확인 중"], ["🔥", "최고"],
];

function messageText(message: TeamsMessage) {
  if (message.deleted) return "삭제된 메시지입니다.";
  return message.body_type.toLowerCase() === "html"
    ? htmlToText(message.body.replace(/<br\s*\/?>/gi, "\n").replace(/<\/div>/gi, "</div>\n"))
    : message.body;
}

function messageTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString("ko-KR", {
    month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

async function focusInput(element?: HTMLElement) {
  // Select the DOM field immediately so WebView2 restores this field when it
  // receives native focus. Do not refocus after IPC: the user may have moved on.
  if (element && document.activeElement !== element) element.focus({ preventScroll: true });
  if (!document.hasFocus()) await invoke("focus_widget_input");
}

function chatTime(value: number) {
  const date = new Date(value);
  return date.toDateString() === new Date().toDateString()
    ? date.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString("ko-KR", { month: "numeric", day: "numeric" });
}

function ChatList({ onOpen, onReconnect }: { onOpen: (chat: TeamsChat) => void; onReconnect: () => void }) {
  const [refreshing, setRefreshing] = useState(false);
  const chats = teamsData.chats;
  async function refresh() {
    setRefreshing(true);
    try { await teamsData.refreshChats(); } finally { setRefreshing(false); }
  }
  return <div className="teams-conversation" role="tabpanel" id="teams-chats-view" aria-labelledby="chats-tab">
    <div className="teams-conversation-bar"><span className="muted">DM · 그룹 채팅 · 1분마다 갱신</span>
      <div className="teams-actions">
        <button className={refreshing ? "icon-button spinning" : "icon-button"} aria-label="채팅 목록 새로고침" data-tooltip="채팅 목록 새로고침"
          disabled={refreshing} onClick={() => void refresh()}><Icon name="refresh" size={14} /></button>
      </div>
    </div>
    {teamsData.chatsError && <div className="teams-error" role="alert"><p>{teamsData.chatsError}</p>
      <button onClick={() => void refresh()}>다시 시도</button><button onClick={onReconnect}>Teams 다시 연결</button></div>}
    {teamsData.scanError && <p className="teams-scan-note">다른 채널의 멘션 알림을 확인하지 못했습니다. {teamsData.scanError}</p>}
    <div className="teams-messages teams-chat-list">
      {chats === null ? !teamsData.chatsError && <p className="teams-placeholder">채팅을 불러오는 중…</p>
        : chats.length === 0 ? <p className="teams-placeholder">채팅이 없습니다.</p>
        : chats.map((chat) => {
          const unread = teamsData.unread(`chat:${chat.id}`);
          const preview = chat.last ? `${chat.last.mine ? "나" : chat.last.author}: ${teamsData.chatPreview(chat)}` : "";
          return <button key={chat.id} className={`teams-chat-item${unread ? " unread" : ""}`} onClick={() => onOpen(chat)}
            aria-label={`${chat.name}${unread ? ", 미확인 메시지 있음" : ""}${preview ? `, ${preview}` : ""}`}>
            <span className="teams-avatar" aria-hidden="true">{chat.name.slice(0, 1)}</span>
            <span className="teams-chat-copy">
              <span className="teams-chat-title"><strong>{chat.name}</strong>
                {chat.last && <time dateTime={new Date(chat.last.time).toISOString()}>{chatTime(chat.last.time)}</time>}</span>
              <span className="teams-chat-preview">{preview || (chat.chat_type === "meeting" ? "모임 채팅" : "메시지 없음")}</span>
            </span>
            {unread && <span className="teams-unread-dot" aria-hidden="true" />}
          </button>;
        })}
    </div>
  </div>;
}

function Conversation({ channel, draft, onDraftChange, onReconnect, onBack }: {
  channel: TeamsChannel;
  draft: ComposerDraft;
  onDraftChange: (value: ComposerDraft, expected?: string) => void;
  onReconnect: () => void;
  onBack?: () => void;
}) {
  const [messages, setMessages] = useState<TeamsMessage[]>([]);
  const [account, setAccount] = useState<string | null>(null);
  const [engaged, setEngaged] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const [parent, setParent] = useState<TeamsMessage | null>(null);
  const replyDrafts = useRef<Record<string, ComposerDraft>>({});
  const channelDraft = useRef(draft);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [sendError, setSendError] = useState("");
  const [synced, setSynced] = useState("");
  const [reactionPicker, setReactionPicker] = useState<string | null>(null);
  const [reacting, setReacting] = useState<string | null>(null);
  const reactionPending = useRef(false);
  const reactionVersion = useRef(0);
  const version = useRef(0);
  const pending = useRef(false);
  const pollingPaused = useRef(false);
  const pagesLoaded = useRef(1);
  const sendPending = useRef(false);
  const messageList = useRef<HTMLDivElement>(null);
  const messageItems = useRef<HTMLDivElement>(null);
  const followBottom = useRef(true);
  const loadedOnce = useRef(false);
  const scrollRestore = useRef<{ bottom: boolean; top: number; id?: string; offset?: number } | null>(null);
  const parentId = parent?.id ?? null;
  const currentDraft = parentId ? replyDrafts.current[parentId] ?? emptyDraft() : channelDraft.current;
  const changeDraft = (value: ComposerDraft, expected?: string) => {
    if (parentId) {
      if (expected === undefined || replyDrafts.current[parentId]?.text === expected) replyDrafts.current[parentId] = value;
    } else {
      if (expected === undefined || channelDraft.current.text === expected) channelDraft.current = value;
      onDraftChange(value, expected);
    }
  };

  function rememberScroll(forceBottom = false, keepPosition = false) {
    const list = messageList.current;
    if (!list) return;
    const bottom = forceBottom || (!keepPosition && list.scrollHeight - list.clientHeight - list.scrollTop < 48);
    followBottom.current = bottom;
    const bounds = list.getBoundingClientRect();
    const anchor = [...list.querySelectorAll<HTMLElement>('[data-message-id]')]
      .find((element) => element.getBoundingClientRect().bottom > bounds.top);
    scrollRestore.current = {
      bottom, top: list.scrollTop, id: anchor?.dataset.messageId,
      offset: anchor ? anchor.getBoundingClientRect().top - bounds.top : undefined,
    };
  }

  useLayoutEffect(() => {
    const list = messageList.current;
    const restore = scrollRestore.current;
    if (!list || !restore) return;
    if (restore.bottom) {
      list.scrollTop = list.scrollHeight;
    } else {
      const anchor = [...list.querySelectorAll<HTMLElement>('[data-message-id]')]
        .find((element) => element.dataset.messageId === restore.id);
      list.scrollTop = restore.top;
      if (anchor && restore.offset !== undefined) {
        list.scrollTop += anchor.getBoundingClientRect().top - list.getBoundingClientRect().top - restore.offset;
      }
    }
    scrollRestore.current = null;
  }, [messages, next, loaded]);

  useEffect(() => {
    const observer = new ResizeObserver(() => {
      const list = messageList.current;
      if (list && followBottom.current) list.scrollTop = list.scrollHeight;
    });
    if (messageList.current) observer.observe(messageList.current);
    if (messageItems.current) observer.observe(messageItems.current);
    return () => observer.disconnect();
  }, []);

  const refresh = useCallback(async (cursor: string | null = null, background = false, force = false) => {
    if (pending.current || reactionPending.current || sendPending.current || (background && pollingPaused.current)) return;
    pollingPaused.current = false;
    pending.current = true;
    const request = version.current;
    const reactionRequest = reactionVersion.current;
    if (!background) setLoading(true);
    try {
      let page = await teamsData.fetch(channel, parentId, cursor, force);
      const received = [...page.messages];
      // Roots are ordered by thread activity: refresh only the head. Replies need their loaded tail too.
      if (background && parentId) {
        for (let index = 1; index < pagesLoaded.current && page.next; index++) {
          if (request !== version.current) return;
          page = await teamsData.fetch(channel, parentId, page.next);
          received.push(...page.messages);
        }
      }
      if (request !== version.current || reactionRequest !== reactionVersion.current) return;
      rememberScroll(!loadedOnce.current, Boolean(cursor));
      loadedOnce.current = true;
      setMessages((previous) => {
        // Polling updates existing items without dropping pages the user has loaded.
        const combined = new Map((cursor || background ? previous : []).map((message) => [message.id, message]));
        received.forEach((message) => combined.set(message.id, message));
        return [...combined.values()].sort((a, b) => a.created_at.localeCompare(b.created_at));
      });
      if (!background) pagesLoaded.current = cursor ? pagesLoaded.current + 1 : 1;
      if (!background || parentId || pagesLoaded.current === 1) setNext(page.next);
      setAccount(page.account_id);
      setError("");
      setLoaded(true);
      setSynced(new Date().toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" }));
    } catch (reason) {
      if (request === version.current && reactionRequest === reactionVersion.current) {
        pollingPaused.current = true;
        setError(String(reason));
      }
    } finally {
      if (request === version.current) {
        pending.current = false;
        setLoading(false);
      }
    }
  }, [channel.id, channel.teamId, channel.channelId, channel.chatId, parentId]);

  useEffect(() => {
    version.current++;
    pending.current = false;
    pagesLoaded.current = 1;
    loadedOnce.current = false;
    followBottom.current = true;
    scrollRestore.current = null;
    const cached = teamsData.peek(channel, parentId);
    setMessages(cached?.page.messages.slice().sort((a, b) => a.created_at.localeCompare(b.created_at)) ?? []);
    setNext(cached?.page.next ?? null);
    setAccount(cached?.page.account_id ?? null);
    setLoaded(Boolean(cached));
    setAtBottom(true);
    if (cached) { loadedOnce.current = true; scrollRestore.current = { bottom: true, top: 0 }; }
    setSynced(cached ? new Date(cached.at).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" }) : "");
    setError("");
    setSendError("");
    setReactionPicker(null);
    void refresh();
    // The shared data layer applies backoff and a global Retry-After delay on errors.
    const timer = window.setInterval(() => {
      if (!document.hidden) { pollingPaused.current = false; void refresh(null, true); }
    }, POLL_INTERVAL);
    return () => { version.current++; window.clearInterval(timer); };
  }, [refresh]);

  useEffect(() => {
    if (parentId || !loaded || !engaged || !atBottom || document.hidden) return;
    const observed = Math.max(0, ...messages.map((message) => message.other_activity || 0));
    const timer = window.setTimeout(() => {
      if (!document.hidden && followBottom.current) void teamsData.markRead(channel.id, account, observed);
    }, 900);
    return () => window.clearTimeout(timer);
  }, [channel.id, account, messages, loaded, parentId, engaged, atBottom]);

  useEffect(() => {
    const disengage = () => setEngaged(false);
    window.addEventListener("blur", disengage);
    document.addEventListener("visibilitychange", disengage);
    return () => { window.removeEventListener("blur", disengage); document.removeEventListener("visibilitychange", disengage); };
  }, []);

  async function send(snapshot: ComposerDraft): Promise<boolean> {
    if (!snapshot.text.trim() || sendPending.current) return false;
    sendPending.current = true;
    reactionVersion.current++;
    teamsData.mutate(channel, parentId);
    setSending(true);
    setSendError("");
    const request = version.current;
    try {
      const sent = await invoke<TeamsMessage>("teams_send", {
        ...conversationTarget(channel), parentId, content: snapshot.text, mentions: snapshot.mentions,
      });
      teamsData.mutate(channel, parentId);
      if (parentId) teamsData.mutate(channel, null);
      changeDraft(emptyDraft(), snapshot.text);
      if (request !== version.current) return true;
      rememberScroll(true);
      setMessages((previous) => [sent, ...previous.filter((message) => message.id !== sent.id)]
        .sort((a, b) => a.created_at.localeCompare(b.created_at)));
      if (parentId) setParent((current) => current && ({ ...current,
        reply_count: current.reply_count == null ? null : current.reply_count + 1,
      }));
      return true;
    } catch (reason) {
      if (request === version.current) setSendError(String(reason));
      return false;
    } finally {
      sendPending.current = false;
      setSending(false);
    }
  }

  async function openInTeams(url: string) {
    try { await invoke("teams_open", { url }); } catch (reason) { setError(String(reason)); }
  }

  async function reactTo(message: TeamsMessage, emoji: string, remove: boolean) {
    if (reactionPending.current) return;
    reactionPending.current = true;
    reactionVersion.current++;
    teamsData.mutate(channel, parentId);
    setReacting(message.id);
    setReactionPicker(null);
    setError("");
    const request = version.current;
    try {
      const reactions = await invoke<TeamsReaction[]>("teams_react", {
        ...conversationTarget(channel), messageId: message.id, parentId, reactionType: emoji, remove,
      });
      teamsData.mutate(channel, parentId);
      if (request !== version.current) return;
      rememberScroll();
      setMessages((previous) => previous.map((item) => item.id === message.id ? { ...item, reactions } : item));
    } catch (reason) {
      if (request === version.current) setError(String(reason));
    } finally {
      reactionPending.current = false;
      setReacting(null);
    }
  }

  const loadMore = next && <button className="teams-load-more" disabled={loading} onClick={() => refresh(next)}>
    {loading ? "불러오는 중…" : parent ? "댓글 더 보기" : "이전 대화 더 보기"}
  </button>;

  return (
    <div className="teams-conversation" role="tabpanel" id="teams-conversation" aria-label={channel.name}
      onPointerEnter={() => setEngaged(true)} onPointerMove={() => setEngaged(true)}
      onPointerLeave={() => setEngaged(false)} onFocusCapture={() => setEngaged(true)}
      onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setEngaged(false); }}>
      <div className="teams-conversation-bar">
        {parent ? <button className="teams-back" onClick={() => setParent(null)} disabled={sending || reacting !== null}>
          <Icon name="chevronLeft" size={14} /> 채널
        </button> : <>{onBack && <button className="teams-back" onClick={onBack}><Icon name="chevronLeft" size={14} /> 채팅 목록</button>}
          <span className="muted">{synced ? `${synced} 갱신 · 1분마다` : channel.chatId ? "채팅" : "채널 대화"}</span></>}
        <div className="teams-actions">
          <button className="teams-link" onClick={() => openInTeams(parent?.web_url ?? channel.url)}>Teams에서 열기 ↗</button>
          <button className={loading ? "icon-button spinning" : "icon-button"} aria-label="대화 새로고침"
            disabled={loading || reacting !== null} onClick={() => refresh(null, false, true)}><Icon name="refresh" size={14} /></button>
        </div>
      </div>
      {parent && <div className="teams-thread-heading"><strong>{parent.author}님의 대화{parent.reply_count != null && ` · 댓글 ${parent.reply_count}개`}</strong>
        <p>{parent.subject || messageText(parent)}</p></div>}
      {error && <div className="teams-error" role="alert"><p>{error}</p>
        <button onClick={() => refresh(null, false, true)}>다시 시도</button><button onClick={onReconnect}>Teams 다시 연결</button></div>}
      <div className="teams-messages" aria-busy={loading} ref={messageList} onScroll={(event) => {
        const list = event.currentTarget;
        followBottom.current = list.scrollHeight - list.clientHeight - list.scrollTop < 48;
        setAtBottom(followBottom.current);
      }}>
        <div ref={messageItems}>
        {!parent && loadMore}
        {!loaded && loading && <p className="teams-placeholder">대화를 불러오는 중…</p>}
        {loaded && messages.length === 0 && <p className="teams-placeholder">{parent ? "아직 답글이 없습니다." : "아직 대화가 없습니다."}</p>}
        {messages.map((message) => <article className="teams-message" key={message.id} data-message-id={message.id}>
          <div className="teams-avatar" aria-hidden="true">{message.author.slice(0, 1)}</div>
          <div className="teams-message-content">
            <header><strong>{message.author}</strong><time dateTime={message.created_at}>{messageTime(message.created_at)}</time></header>
            <div className="teams-message-bubble">
            {!message.deleted && message.subject && <h3>{message.subject}</h3>}
            <MessageBody body={message.body} bodyType={message.body_type} deleted={message.deleted}
              teamId={channel.teamId} channelId={channel.channelId} chatId={channel.chatId ?? null} />
            {!message.deleted && message.has_attachments && <button className="teams-link" onClick={() => openInTeams(message.web_url ?? channel.url)}>첨부 파일 · Teams에서 보기 ↗</button>}
            </div>
            {!message.deleted && <div className="teams-reactions" aria-label="메시지 반응" aria-busy={reacting === message.id}>
              {(message.reactions ?? []).map((reaction) => <ReactionButton key={reaction.key}
                reaction={reaction} channel={channel} account={account} disabled={reacting !== null}
                onClick={() => reaction.reaction_type == null ? openInTeams(message.web_url ?? channel.url) : reactTo(message, reaction.reaction_type, reaction.mine)}>
              </ReactionButton>)}
              <button type="button" className="teams-reaction-add" aria-label="반응 추가" data-tooltip="반응 추가"
                aria-expanded={reactionPicker === message.id} disabled={reacting !== null}
                onClick={() => setReactionPicker((current) => current === message.id ? null : message.id)}>☺ +</button>
              {reacting === message.id && <span className="muted" role="status">반영 중…</span>}
              {reactionPicker === message.id && <div className="teams-reaction-picker" role="group" aria-label="이모지 선택"
                onKeyDown={(event) => { if (event.key === "Escape") setReactionPicker(null); }}>
                {REACTION_CHOICES.map(([emoji, label]) => {
                  const mine = message.reactions?.some((reaction) => reaction.reaction_type === emoji && reaction.mine) ?? false;
                  return <button key={emoji} type="button" data-tooltip={label} aria-label={label} aria-pressed={mine}
                    onClick={() => reactTo(message, emoji, mine)}>{emoji}</button>;
                })}
                <button type="button" className="teams-picker-close" aria-label="반응 선택 닫기" onClick={() => setReactionPicker(null)}>×</button>
              </div>}
            </div>}
            {!parent && !channel.chatId && !message.deleted && <button className="teams-reply" disabled={sending || reacting !== null} onClick={() => setParent(message)}>
              {message.reply_count == null ? "댓글 보기 / 작성" : `댓글 ${message.reply_count}개 · 보기 / 작성`}
            </button>}
          </div>
        </article>)}
        {parent && loadMore}
        </div>
      </div>
      <TeamsComposer key={parentId ?? "channel"} channel={channel} reply={Boolean(parent)} initialDraft={currentDraft}
        sending={sending} error={sendError} onDraftChange={changeDraft} onSend={send} onReconnect={onReconnect} />
    </div>
  );
}

export default function TeamsPanel({ news }: { news: (active: boolean) => ReactNode }) {
  useSyncExternalStore(teamsData.subscribe, teamsData.snapshot);
  useEffect(() => { void teamsData.initialize(); }, []);
  const [channels, setChannels] = useState<TeamsChannel[]>([]);
  const [activeId, setActiveId] = useState(NEWS_TAB_ID);
  const [channelsReady, setChannelsReady] = useState(false);
  const [channelError, setChannelError] = useState("");
  const [savingChannels, setSavingChannels] = useState(false);
  const channelSavePending = useRef(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [status, setStatus] = useState<TeamsStatus | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [adding, setAdding] = useState(false);
  const [link, setLink] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [formError, setFormError] = useState("");
  const drafts = useRef<Record<string, ComposerDraft>>({});
  const linkInput = useRef<HTMLInputElement>(null);
  const [openChat, setOpenChat] = useState<TeamsChat | null>(null);
  const scanIndex = useRef(0);
  const newsSelected = activeId === NEWS_TAB_ID;
  const chatsSelected = activeId === CHATS_TAB_ID;
  const active = newsSelected || chatsSelected ? undefined : channels.find((channel) => channel.id === activeId) ?? channels[0];
  const openChatChannel = openChat && chatChannel(teamsData.chats?.find((chat) => chat.id === openChat.id) ?? openChat);

  useEffect(() => {
    invoke<TeamsStatus>("teams_status").then(setStatus).catch((reason) => setError(String(reason)));
  }, []);

  useEffect(() => {
    let cancelled = false;
    setChannelError("");
    void (async () => {
      try {
        const saved = await invoke<ChannelSettings | null>("teams_load_channels");
        if (cancelled) return;
        const restored = saved === null ? readChannels() : decodeChannels(saved.channels);
        const selected = saved === null ? localStorage.getItem(ACTIVE_CHANNEL_KEY) ?? "" : saved.activeId;
        const restoredActive = selected === NEWS_TAB_ID || selected === CHATS_TAB_ID ? selected : restored.find((channel) => channel.id === selected)?.id ?? restored[0]?.id ?? NEWS_TAB_ID;
        // Migrate once. Never write an initial empty render over saved settings.
        if (saved === null) await invoke("teams_save_channels", { settings: { channels: restored, activeId: restoredActive } });
        if (cancelled) return;
        setChannels(restored);
        setActiveId(restoredActive);
        setChannelsReady(true);
      } catch (reason) {
        if (!cancelled) setChannelError(String(reason));
      }
    })();
    return () => { cancelled = true; };
  }, [loadAttempt]);

  useEffect(() => {
    if (!channelsReady || !status?.connected || connecting) return;
    let stopped = false;
    let polling = false;
    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        for (const channel of channels) {
          if (stopped) break;
          try { await teamsData.fetch(channel); } catch { /* Shared backoff; opening the tab shows errors. */ }
        }
      } finally { polling = false; }
    };
    const initial = window.setTimeout(() => void poll(), 1500);
    const timer = window.setInterval(() => void poll(), 180_000);
    const visible = () => { if (!document.hidden) void poll(); };
    document.addEventListener("visibilitychange", visible);
    return () => { stopped = true; window.clearTimeout(initial); window.clearInterval(timer); document.removeEventListener("visibilitychange", visible); };
  }, [channels, active?.id, channelsReady, status?.connected, connecting]);

  useEffect(() => {
    if (!status?.connected || connecting) return;
    // DMs alert on every new message, so poll them even while another tab is open.
    void teamsData.refreshChats();
    const timer = window.setInterval(() => void teamsData.refreshChats(), CHAT_POLL_INTERVAL);
    return () => window.clearInterval(timer);
  }, [status?.connected, connecting]);

  useEffect(() => {
    if (!channelsReady || !status?.connected || connecting) return;
    let stopped = false;
    let busy = false;
    const tabs = new Set(channels.map((channel) => channel.id.toLowerCase()));
    const step = async () => {
      if (busy) return;
      busy = true;
      try {
        const untabbed = (await teamsData.joinedChannels()).filter((channel) => !tabs.has(channel.id.toLowerCase()));
        if (stopped || untabbed.length === 0) return;
        const channel = untabbed[scanIndex.current++ % untabbed.length];
        try { await teamsData.fetch(channel, null, null, false, true); } catch { /* Shared backoff; the next step tries another channel. */ }
      } finally { busy = false; }
    };
    const initial = window.setTimeout(() => void step(), 5000);
    const timer = window.setInterval(() => void step(), SCAN_INTERVAL);
    return () => { stopped = true; window.clearTimeout(initial); window.clearInterval(timer); };
  }, [channels, channelsReady, status?.connected, connecting]);

  async function saveChannels(nextChannels: TeamsChannel[], nextActiveId: string) {
    if (!channelsReady || channelSavePending.current) return false;
    channelSavePending.current = true;
    setSavingChannels(true);
    setChannelError("");
    try {
      await invoke("teams_save_channels", { settings: { channels: nextChannels, activeId: nextActiveId } });
      setChannels(nextChannels);
      setActiveId(nextActiveId);
      return true;
    } catch (reason) {
      setChannelError(String(reason));
      return false;
    } finally {
      channelSavePending.current = false;
      setSavingChannels(false);
    }
  }

  async function selectChannel(id: string) {
    // The built-in feed stays usable even if Teams settings cannot be read.
    if (id === NEWS_TAB_ID && !channelsReady) { setActiveId(id); setAdding(false); return; }
    if (await saveChannels(channels, id)) setAdding(false);
  }

  async function connect() {
    if (connecting) return;
    setConnecting(true);
    setError("");
    try {
      await invoke("teams_connect");
      teamsData.reset();
      drafts.current = {};
      setOpenChat(null);
      setStatus(await invoke<TeamsStatus>("teams_status"));
    } catch (reason) { setError(String(reason)); }
    finally { setConnecting(false); }
  }

  async function showAdd() {
    if (!channelsReady || channelSavePending.current) return;
    setAdding(true);
    setFormError("");
    try { await focusInput(); linkInput.current?.focus(); }
    catch (reason) { setFormError(String(reason)); }
  }

  async function addChannel(event: FormEvent) {
    event.preventDefault();
    try {
      const channel = parseChannelLink(link, name);
      const nextChannels = channels.some((item) => item.id === channel.id)
        ? channels.map((item) => item.id === channel.id ? channel : item) : [...channels, channel];
      if (!await saveChannels(nextChannels, channel.id)) return;
      setAdding(false);
      setLink(""); setName(""); setFormError("");
    } catch (reason) { setFormError(reason instanceof Error ? reason.message : String(reason)); }
  }

  async function removeChannel(id: string) {
    const index = channels.findIndex((channel) => channel.id === id);
    const remaining = channels.filter((channel) => channel.id !== id);
    const nextActive = activeId === id ? remaining[Math.max(0, index - 1)]?.id ?? NEWS_TAB_ID : activeId;
    await saveChannels(remaining, nextActive);
  }

  const connectPrompt = <div className="teams-empty"><h3>{connecting ? "브라우저에서 로그인해 주세요" : "Teams 연결이 필요합니다"}</h3>
    <p>{status?.configured ? "회사 계정으로 로그인해 채널 대화를 불러오세요. 처음 연결할 때 관리자 동의가 필요할 수 있습니다." : "앱의 Microsoft 계정 설정이 필요합니다. README의 Teams 연결 안내를 확인해 주세요."}</p>
    <button className="primary" disabled={!status?.configured || connecting} onClick={connect}>{connecting ? "로그인 기다리는 중…" : "Teams 연결"}</button></div>;

  return <aside className="teams-panel" aria-label="Teams 채널 대화">
    <header className="teams-header"><div className="teams-heading"><span className="teams-mark" aria-hidden="true">T</span><h2>Teams</h2></div>
      <div className="teams-actions">
        <button className="teams-account" disabled={!status?.configured || connecting} onClick={connect}
          data-tooltip={status?.connected ? "Teams 계정 다시 연결" : "Teams 연결"}>
          <span className={status?.connected ? "teams-connected" : "teams-disconnected"} />
          {connecting ? "연결 중…" : status?.connected ? "연결됨" : "연결"}</button>
        <button className="icon-button" data-tooltip="채널 추가" aria-label="채널 추가" disabled={!channelsReady || savingChannels} onClick={showAdd}><Icon name="plus" size={17} /></button>
      </div>
    </header>
    <ChannelTabs channels={channels} activeId={chatsSelected ? CHATS_TAB_ID : active?.id ?? NEWS_TAB_ID} disabled={savingChannels}
      chatUnread={teamsData.chatsUnread()}
      unread={id => teamsData.unread(id)} mentioned={id => teamsData.mentioned(id)} onSelect={id => void selectChannel(id)}
      onReorder={next => { void saveChannels(next, activeId); }} onClose={removeChannel} />
    {error && <p className="teams-panel-error error" role="alert">{error}</p>}
    {teamsData.error && <div className="teams-error" role="alert"><p>{teamsData.error}</p><button onClick={() => { void teamsData.retryReadState(); }}>확인 상태 다시 불러오기</button></div>}
    {teamsData.notificationError && <div className="teams-error" role="alert"><p>{teamsData.notificationError}</p></div>}
    {channelError && <div className="teams-error" role="alert"><p>{channelError}</p>
      {!channelsReady && <button onClick={() => setLoadAttempt((attempt) => attempt + 1)}>채널 목록 다시 불러오기</button>}
    </div>}
    <div className="teams-news-view" id="teams-news-view" role="tabpanel" aria-labelledby="geeknews-tab" hidden={!newsSelected || adding}>{news(newsSelected && !adding)}</div>
    {newsSelected && !adding ? null : !channelsReady ? <div className="teams-empty"><p>{channelError ? "채널 목록을 불러오지 못했습니다." : "저장된 채널을 불러오는 중…"}</p></div>
    : adding ? <form className="teams-add-form" onSubmit={addChannel}>
      <h3>채널 추가</h3><p className="muted">Teams 채널의 ··· 메뉴에서 ‘채널 링크 복사’를 선택하세요.</p>
      <label>채널 링크<input ref={linkInput} value={link} onChange={(event) => setLink(event.target.value)} required placeholder="https://teams.microsoft.com/l/channel/…"
        onPointerDown={(event) => { void focusInput(event.currentTarget).catch((reason) => setFormError(String(reason))); }} /></label>
      <label>탭 이름 <span className="muted">선택</span><input value={name} onChange={(event) => setName(event.target.value)} maxLength={80} placeholder="링크의 채널 이름 사용"
        onPointerDown={(event) => { void focusInput(event.currentTarget).catch((reason) => setFormError(String(reason))); }} /></label>
      {formError && <p className="error" role="alert">{formError}</p>}
      <div className="teams-add-actions"><button type="button" disabled={savingChannels} onClick={() => setAdding(false)}>취소</button><button className="primary" type="submit" disabled={!link.trim() || savingChannels}>{savingChannels ? "저장 중…" : "탭 추가"}</button></div>
    </form> : chatsSelected ? (!status?.connected || connecting ? connectPrompt
      : openChatChannel ? <Conversation key={openChatChannel.id} channel={openChatChannel} draft={drafts.current[openChatChannel.id] ?? emptyDraft()}
          onDraftChange={(value, expected) => {
            if (expected === undefined || drafts.current[openChatChannel.id]?.text === expected) drafts.current[openChatChannel.id] = value;
          }} onReconnect={connect} onBack={() => setOpenChat(null)} />
      : <ChatList onOpen={setOpenChat} onReconnect={connect} />)
    : !active ? <div className="teams-empty"><div className="teams-empty-icon" aria-hidden="true">#</div><h3>자주 보는 채널을 한곳에</h3>
      <p>채널을 탭으로 추가하고<br />일정 옆에서 대화를 확인하세요.</p><button className="primary" onClick={showAdd}><Icon name="plus" size={15} /> 채널 추가</button></div>
      : !status?.connected || connecting ? connectPrompt
      : <Conversation key={active.id} channel={active} draft={drafts.current[active.id] ?? emptyDraft()}
          onDraftChange={(value, expected) => {
            if (expected === undefined || drafts.current[active.id]?.text === expected) drafts.current[active.id] = value;
          }} onReconnect={connect} />}
  </aside>;
}
