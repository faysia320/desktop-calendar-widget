export type TeamsChannel = {
  id: string;
  teamId: string;
  channelId: string;
  name: string;
  url: string;
  // Set for DMs and group chats, which have no team, channel or reply threads.
  chatId?: string;
};

export type TeamsChat = {
  id: string;
  name: string;
  chat_type: string;
  url: string | null;
  updated: number;
  last: { id: string; time: number; author: string; body: string; body_type: string; mine: boolean } | null;
};
export type ChatPage = { chats: TeamsChat[]; account_id: string | null };

export function chatChannel(chat: TeamsChat): TeamsChannel {
  return { id: `chat:${chat.id}`, teamId: "", channelId: "", chatId: chat.id, name: chat.name, url: chat.url ?? "https://teams.microsoft.com/" };
}

export type TeamsMessage = {
  id: string;
  author: string;
  created_at: string;
  body: string;
  body_type: string;
  subject: string | null;
  web_url: string | null;
  deleted: boolean;
  has_attachments: boolean;
  reactions: TeamsReaction[];
  reply_count: number | null;
  other_activity: number;
  mine?: boolean;
  reply_activity?: number;
  mentions_me?: { id: string; time: number }[];
  activities?: MessageActivity[];
};

export type MessageActivity = {
  kind: "mention" | "reply" | "reaction";
  time: number;
  actors: { id: string | null; name: string | null }[];
  emojis: string[];
  message_id: string;
  parent_id: string | null;
  body: string;
  body_type: string;
  web_url: string | null;
};
export type ActivityItem = MessageActivity & { key: string; conversation: TeamsChannel };

export type TeamsReaction = {
  key: string;
  emoji: string;
  label: string;
  count: number;
  mine: boolean;
  reaction_type: string | null;
  users?: { id: string | null; name: string | null; mine: boolean }[];
};
export type TeamsMember = { userId: string; displayName: string; email: string };

export type MessagePage = { messages: TeamsMessage[]; next: string | null; account_id: string | null };
export type TeamsStatus = { configured: boolean; connected: boolean };

export const CHANNELS_KEY = "teams-channels-v1";
export const ACTIVE_CHANNEL_KEY = "teams-active-channel-v1";

export function parseChannelLink(link: string, label = ""): TeamsChannel {
  let url: URL;
  try {
    url = new URL(link.trim());
  } catch {
    throw new Error("Teams의 ‘채널 링크 복사’로 가져온 주소를 붙여 넣어 주세요.");
  }
  if (url.protocol !== "https:" || !["teams.microsoft.com", "teams.cloud.microsoft"].includes(url.hostname)
    || url.username || url.password || url.port) {
    throw new Error("Teams 채널 링크만 추가할 수 있습니다.");
  }
  let parts: string[];
  try {
    parts = url.pathname.split("/").map(decodeURIComponent);
  } catch {
    throw new Error("채널 링크의 인코딩이 올바르지 않습니다.");
  }
  const teamId = url.searchParams.get("groupId") ?? "";
  const channelId = parts[3] ?? "";
  if (parts[1] !== "l" || !["channel", "message"].includes(parts[2])
    || !/^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/i.test(teamId)
    || !channelId.startsWith("19:") || /[/\\?#]/.test(channelId)) {
    throw new Error("팀 ID가 포함된 채널 링크가 필요합니다. Teams 채널의 ··· → 채널 링크 복사를 사용해 주세요.");
  }
  const name = label.trim() || url.searchParams.get("channelName")
    || (parts[2] === "channel" ? parts[4] : "") || "Teams 채널";
  return { id: `${teamId}:${channelId}`, teamId, channelId, name: name.slice(0, 80), url: url.href };
}

export type ChannelSettings = { channels: Pick<TeamsChannel, "url" | "name">[]; activeId: string };

export function decodeChannels(saved: unknown): TeamsChannel[] {
    if (!Array.isArray(saved)) throw new Error("저장된 채널 목록을 읽을 수 없습니다. 기존 설정은 보존됩니다.");
    const channels = new Map<string, TeamsChannel>();
    for (const item of saved) {
        if (typeof item?.url !== "string") throw new Error("저장된 채널 링크가 올바르지 않습니다.");
        const channel = parseChannelLink(item.url, typeof item.name === "string" ? item.name : "");
        channels.set(channel.id, channel);
    }
    return [...channels.values()];
}

export function readChannels(): TeamsChannel[] {
  return decodeChannels(JSON.parse(localStorage.getItem(CHANNELS_KEY) ?? "[]"));
}
