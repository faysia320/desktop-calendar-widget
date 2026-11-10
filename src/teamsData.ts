import { invoke } from "@tauri-apps/api/core";
import type { MessagePage, TeamsChannel, TeamsMember } from "./teams";

type Call = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
type Entry = { page: MessagePage; at: number; bytes: number };
const TTL = 45_000;
const LIMIT = 8 * 1024 * 1024;

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
    entry.request = this.call<TeamsMember[]>("teams_members", { teamId: channel.teamId, channelId: channel.channelId })
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
  async fetch(channel: TeamsChannel, parent: string | null = null, cursor: string | null = null, force = false): Promise<MessagePage> {
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
          teamId: channel.teamId, channelId: channel.channelId, parentId: parent, next: cursor,
        });
        if (epoch !== this.epoch || generation !== (this.generations.get(context) ?? 0)) throw new Error("대화 변경 후 다시 갱신해 주세요.");
        this.put(key, page);
        this.failures.delete(key);
        if (!parent && !cursor) this.observe(channel, page);
        // Only fresh head pages notify. Cached/paginated history must never replay alerts.
        if (!parent && !cursor && page.account_id && page.messages.every(message => message.mentions_me !== undefined)) {
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
    this.memberCache.clear();
    this.activity.clear(); this.notificationError = ""; this.blockedUntil = 0; this.emit();
  }
}

export const teamsData = new TeamsData();
