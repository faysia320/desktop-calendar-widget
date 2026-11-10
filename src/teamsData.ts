import { invoke } from "@tauri-apps/api/core";
import type { ActivityItem, ChatPage, MessagePage, TeamsChannel, TeamsChat, TeamsMember } from "./teams";

type Call = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
type Entry = { page: MessagePage; at: number; bytes: number };
const TTL = 45_000;
const LIMIT = 8 * 1024 * 1024;
const JOINED_TTL = 30 * 60_000;
const ACTIVITY_LIMIT = 300;
const ACTIVITY_AGE = 30 * 86_400_000;
export const ACTIVITY_ID = "builtin:activity";

export function conversationTarget(channel: TeamsChannel) {
  return { teamId: channel.teamId, channelId: channel.channelId, chatId: channel.chatId ?? null };
}

export function plainText(body: string, type: string) {
  if (type.toLowerCase() !== "html") return body;
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };
  return body.replace(/<img\b[^>]*>/gi, "[이미지]").replace(/<br\s*\/?>|<\/(p|div|li)>/gi, "\n").replace(/<[^>]*>/g, "")
    .replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (entity, code: string) => {
      if (code[0] !== "#") return named[code.toLowerCase()] ?? entity;
      const point = Number(code[1].toLowerCase() === "x" ? `0${code.slice(1)}` : code.slice(1));
      return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : " ";
    }).trim();
}

// One owner for pages, request deduplication, throttling and account-scoped read metadata.
export class TeamsData {
  private pages = new Map<string, Entry>();
  private pending = new Map<string, Promise<MessagePage>>();
  private failures = new Map<string, { until: number; count: number; error: unknown }>();
  private queue: (() => void)[] = [];
  private running = 0;
  private epoch = 0;
  private generations = new Map<string, number>();
  private listeners = new Set<() => void>();
  private activity = new Map<string, { account: string; time: number; mention: number }>();
  private marks: Record<string, number> = {};
  private markWrites = new Map<string, Promise<void>>();
  private initialized = false;
  private initializing?: Promise<void>;
  private blockedUntil = 0;
  private memberCache = new Map<string, { until: number; request: Promise<TeamsMember[]> }>();
  private chatsRequest?: Promise<void>;
  private joined?: { until: number; channels: TeamsChannel[] };
  private feed = new Map<string, ActivityItem>();
  private feedAccount: string | null = null;
  chats: TeamsChat[] | null = null;
  chatsAccount: string | null = null;
  chatsError = "";
  scanError = "";
  error = "";
  notificationError = "";
  revision = 0;

  constructor(private call: Call = invoke, private now = Date.now) {}
  members(channel: TeamsChannel, account: string | null) {
    const key = JSON.stringify([account, channel.id]);
    const cached = this.memberCache.get(key);
    if (cached && cached.until > this.now()) return cached.request;
    const epoch = this.epoch;
    const entry = { until: Infinity, request: Promise.resolve([] as TeamsMember[]) };
    entry.request = this.call<TeamsMember[]>("teams_members", conversationTarget(channel))
      .then(members => {
        if (epoch !== this.epoch) throw new Error("Teams 연결이 변경되었습니다.");
        entry.until = this.now() + 300_000;
        return members;
      }).catch(error => { entry.until = this.now() + 30_000; throw error; });
    this.memberCache.delete(key);
    this.memberCache.set(key, entry);
    if (this.memberCache.size > 30) this.memberCache.delete(this.memberCache.keys().next().value!);
    return entry.request;
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.revision;
  private emit() { this.revision++; this.listeners.forEach((listener) => listener()); }
  private context(channel: TeamsChannel, parent: string | null) { return JSON.stringify([channel.id, parent]); }
  private key(channel: TeamsChannel, parent: string | null, cursor: string | null) { return JSON.stringify([channel.id, parent, cursor]); }
  private markKey(account: string, channel: string) { return JSON.stringify([account, channel]); }

  initialize() {
    if (this.initialized) return Promise.resolve();
    if (this.initializing) return this.initializing;
    this.initializing = this.call<Record<string, number>>("teams_load_read_marks").then((marks) => {
      this.marks = marks;
      this.initialized = true;
      this.error = "";
      this.activity.forEach((value, channel) => this.baseline(channel, value));
      this.emit();
    }).catch((reason) => { this.error = String(reason); this.emit(); })
      .finally(() => { this.initializing = undefined; });
    return this.initializing;
  }
  retryReadState() { this.initialized = false; return this.initialize(); }
  unread(channel: string) {
    const value = this.activity.get(channel);
    if (!this.initialized || !value) return false;
    const mark = this.marks[this.markKey(value.account, channel)];
    return mark !== undefined && value.time > mark;
  }
  mentioned(channel: string) {
    const value = this.activity.get(channel);
    if (!this.initialized || !value) return false;
    const mark = this.marks[this.markKey(value.account, channel)];
    return mark !== undefined && value.mention > mark;
  }
  private baseline(channel: string, value: { account: string; time: number }) {
    const key = this.markKey(value.account, channel);
    // First use establishes a baseline, without flagging the entire channel history.
    if (this.initialized && this.marks[key] === undefined && !this.markWrites.has(key)) {
      void this.markRead(channel, value.account, value.time);
    }
  }
  async markRead(channel: string, account: string | null, timestamp: number): Promise<void> {
    if (!this.initialized || !account) return;
    const key = this.markKey(account, channel);
    const previous = this.markWrites.get(key);
    if (previous) { await previous; return this.markRead(channel, account, timestamp); }
    if (this.marks[key] !== undefined && this.marks[key] >= timestamp) return;
    const write = this.call<number>("teams_mark_read", { key, timestamp }).then((saved) => {
      this.marks[key] = Math.max(this.marks[key] ?? 0, saved);
      this.error = "";
      this.emit();
    }).catch((reason) => { this.error = String(reason); this.emit(); })
      .finally(() => { this.markWrites.delete(key); });
    this.markWrites.set(key, write);
    await write;
  }
  private observe(channel: TeamsChannel, page: MessagePage) {
    if (!page.account_id) return;
    const previous = this.activity.get(channel.id);
    const value = { account: page.account_id, time: Math.max(
      previous?.account === page.account_id ? previous.time : 0,
      ...page.messages.map((message) => message.other_activity || 0),
    ), mention: Math.max(previous?.account === page.account_id ? previous.mention : 0,
      ...page.messages.flatMap(message => (message.mentions_me ?? []).map(mention => mention.time)), 0) };
    this.activity.set(channel.id, value);
    this.baseline(channel.id, value);
    this.emit();
  }
  peek(channel: TeamsChannel, parent: string | null = null, cursor: string | null = null) {
    const key = this.key(channel, parent, cursor);
    const entry = this.pages.get(key);
    if (entry) { this.pages.delete(key); this.pages.set(key, entry); }
    return entry;
  }
  private put(key: string, page: MessagePage) {
    const bytes = JSON.stringify(page).length * 2;
    this.pages.delete(key);
    if (bytes > LIMIT) return;
    this.pages.set(key, { page, at: this.now(), bytes });
    let total = [...this.pages.values()].reduce((sum, entry) => sum + entry.bytes, 0);
    while (total > LIMIT || this.pages.size > 100) {
      const oldest = this.pages.keys().next().value!;
      total -= this.pages.get(oldest)!.bytes;
      this.pages.delete(oldest);
    }
  }
  // Items are rebuilt from every fresh head page; the read mark is the only persisted state.
  private ingest(channel: TeamsChannel, page: MessagePage) {
    const account = page.account_id;
    if (!account) return;
    if (this.feedAccount !== account) { this.feed.clear(); this.feedAccount = account; }
    const roots = new Set(page.messages.map(message => message.id));
    for (const [key, item] of this.feed) {
      if (item.conversation.id === channel.id && roots.has(item.parent_id ?? item.message_id)) this.feed.delete(key);
    }
    const oldest = this.now() - ACTIVITY_AGE;
    for (const message of page.messages) {
      for (const activity of message.activities ?? []) {
        if (activity.time < oldest) continue;
        const key = JSON.stringify([channel.id, activity.kind, activity.message_id]);
        this.feed.set(key, { ...activity, key, conversation: channel });
      }
    }
    if (this.feed.size > ACTIVITY_LIMIT) {
      [...this.feed.values()].sort((a, b) => b.time - a.time).slice(ACTIVITY_LIMIT).forEach(item => this.feed.delete(item.key));
    }
    const mark = this.markKey(account, ACTIVITY_ID);
    // The first feed for an account starts read, like the channel baselines.
    if (this.initialized && this.marks[mark] === undefined && !this.markWrites.has(mark)) void this.markRead(ACTIVITY_ID, account, this.now());
    this.emit();
  }
  readMark(channel: string, account: string | null) {
    if (!this.initialized || !account) return undefined;
    return this.marks[this.markKey(account, channel)];
  }
  activities() { return [...this.feed.values()].sort((a, b) => b.time - a.time); }
  activityAccount() { return this.feedAccount; }
  activityMark() {
    if (!this.initialized || !this.feedAccount) return undefined;
    return this.marks[this.markKey(this.feedAccount, ACTIVITY_ID)];
  }
  activityUnread() {
    const mark = this.activityMark();
    return mark === undefined ? 0 : [...this.feed.values()].filter(item => item.time > mark).length;
  }
  chatPreview(chat: TeamsChat) { return chat.last ? plainText(chat.last.body, chat.last.body_type) : ""; }
  chatsUnread() { return (this.chats ?? []).some(chat => this.unread(`chat:${chat.id}`)); }
  refreshChats(): Promise<void> {
    if (this.chatsRequest) return this.chatsRequest;
    const epoch = this.epoch;
    this.chatsRequest = (async () => {
      try {
        const page = await this.call<ChatPage>("teams_chats");
        if (epoch !== this.epoch) return;
        this.chats = page.chats; this.chatsAccount = page.account_id; this.chatsError = "";
        if (!page.account_id) return;
        for (const chat of page.chats) {
          const id = `chat:${chat.id}`;
          const previous = this.activity.get(id);
          const time = Math.max(previous?.account === page.account_id ? previous.time : 0, chat.last && !chat.last.mine ? chat.last.time : 0);
          const value = { account: page.account_id, time, mention: previous?.account === page.account_id ? previous.mention : 0 };
          this.activity.set(id, value);
          if (time > 0) this.baseline(id, value);
        }
        const notices = page.chats.flatMap(chat => chat.last && !chat.last.mine && chat.url ? [{
          id: chat.last.id, time: chat.last.time, name: chat.name.slice(0, 200), author: chat.last.author,
          text: this.chatPreview(chat).slice(0, 500), url: chat.url }] : []);
        try {
          await this.call("teams_observe_chats", { account: page.account_id, chats: notices });
          if (epoch === this.epoch) this.notificationError = "";
        } catch (error) { if (epoch === this.epoch) this.notificationError = String(error); }
      } catch (error) {
        if (epoch === this.epoch) this.chatsError = String(error);
      } finally {
        if (epoch === this.epoch) { this.chatsRequest = undefined; this.emit(); }
      }
    })();
    return this.chatsRequest;
  }
  // All channels the account can read, for mention alerts outside the widget's tabs.
  async joinedChannels(): Promise<TeamsChannel[]> {
    if (this.joined && this.joined.until > this.now()) return this.joined.channels;
    const epoch = this.epoch;
    try {
      const channels = (await this.call<{ teamId: string; channelId: string; name: string; url: string }[]>("teams_joined_channels"))
        .map(item => ({ id: `${item.teamId}:${item.channelId}`, teamId: item.teamId, channelId: item.channelId, name: item.name, url: item.url }));
      if (epoch !== this.epoch) return [];
      this.joined = { until: this.now() + JOINED_TTL, channels };
      if (this.scanError) { this.scanError = ""; this.emit(); }
      return channels;
    } catch (error) {
      if (epoch === this.epoch) { this.joined = { until: this.now() + 5 * 60_000, channels: [] }; this.scanError = String(error); this.emit(); }
      return [];
    }
  }
  async fetch(channel: TeamsChannel, parent: string | null = null, cursor: string | null = null, force = false,
    scan = false): Promise<MessagePage> {
    const key = this.key(channel, parent, cursor);
    const cached = this.peek(channel, parent, cursor);
    if (!force && cached && this.now() - cached.at < TTL) return cached.page;
    const existing = this.pending.get(key);
    if (existing) return existing;
    const failure = this.failures.get(key);
    if (this.now() < this.blockedUntil) throw new Error("Teams 요청 제한 대기 중입니다. 잠시 후 다시 시도해 주세요.");
    if (!force && failure && this.now() < failure.until) throw failure.error;
    const epoch = this.epoch;
    const context = this.context(channel, parent);
    const generation = this.generations.get(context) ?? 0;
    const request = (async () => {
      await new Promise<void>((resolve) => {
        const start = () => { this.running++; resolve(); };
        if (this.running < 2) start(); else this.queue.push(start);
      });
      try {
        if (epoch !== this.epoch || this.now() < this.blockedUntil) throw new Error("Teams 조회가 취소되었거나 잠시 대기 중입니다.");
        const page = await this.call<MessagePage>("teams_messages", {
          ...conversationTarget(channel), parentId: parent, next: cursor,
        });
        if (epoch !== this.epoch || generation !== (this.generations.get(context) ?? 0)) throw new Error("대화 변경 후 다시 갱신해 주세요.");
        // Background mention scans of untabbed channels keep no pages or unread state.
        if (!scan) this.put(key, page);
        this.failures.delete(key);
        if (!parent && !cursor && !scan) this.observe(channel, page);
        if (!parent && !cursor && epoch === this.epoch) this.ingest(channel, page);
        // Only fresh head pages notify. Cached/paginated history must never replay alerts.
        // Chats notify every new message through refreshChats instead.
        if (!parent && !cursor && !channel.chatId && page.account_id && page.messages.every(message => message.mentions_me !== undefined)) {
          try {
            await this.call("teams_observe_mentions", { account: page.account_id, channel: channel.id,
              name: channel.name, url: channel.url, mentions: page.messages.flatMap(message => message.mentions_me ?? []) });
            if (epoch === this.epoch) this.notificationError = "";
          } catch (error) { if (epoch === this.epoch) this.notificationError = String(error); }
          if (epoch === this.epoch) this.emit();
        }
        if (epoch !== this.epoch || generation !== (this.generations.get(context) ?? 0)) throw new Error("대화 변경 후 다시 갱신해 주세요.");
        return page;
      } catch (error) {
        if (epoch === this.epoch) {
          const count = (failure?.count ?? 0) + 1;
          this.failures.set(key, { until: this.now() + Math.min(300_000, 30_000 * 2 ** Math.min(count - 1, 4)), count, error });
          if (String(error).includes("Teams 요청이 많습니다")) {
            const seconds = Number(String(error).match(/(\d+)초/)?.[1] ?? 60);
            this.blockedUntil = this.now() + Math.max(60, seconds) * 1000;
          }
        }
        throw error;
      } finally {
        this.running--;
        this.queue.shift()?.();
      }
    })();
    this.pending.set(key, request);
    try { return await request; }
    finally { if (this.pending.get(key) === request) this.pending.delete(key); }
  }
  mutate(channel: TeamsChannel, parent: string | null) {
    const context = this.context(channel, parent);
    this.generations.set(context, (this.generations.get(context) ?? 0) + 1);
    // Pending pre-mutation responses must not populate a newer cache.
    for (const key of this.pages.keys()) {
      const [id, thread] = JSON.parse(key);
      if (id !== channel.id || thread !== parent) continue;
      this.pages.delete(key);
    }
  }
  reset() {
    this.epoch++;
    this.pages.clear(); this.pending.clear(); this.failures.clear(); this.generations.clear();
    this.memberCache.clear(); this.chatsRequest = undefined; this.joined = undefined;
    this.chats = null; this.chatsAccount = null; this.chatsError = ""; this.scanError = "";
    this.feed.clear(); this.feedAccount = null;
    this.activity.clear(); this.notificationError = ""; this.blockedUntil = 0; this.emit();
  }
}

export const teamsData = new TeamsData();
