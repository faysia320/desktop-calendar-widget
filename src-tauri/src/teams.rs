use crate::oauth::{self, Provider, ProviderStatus};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;
use url::Url;
use std::collections::HashSet;

// Rotating refresh tokens must not race between polling, replies, and sending.
#[derive(Default)]
pub struct TeamsSession {
    token_lock: tokio::sync::Mutex<()>,
    user_id: tokio::sync::Mutex<Option<Option<String>>>,
    access: tokio::sync::Mutex<Option<(String, std::time::Instant)>>,
}

impl TeamsSession {
    async fn access_token(&self) -> Result<String, String> {
        let _guard = self.token_lock.lock().await;
        let mut cached = self.access.lock().await;
        if let Some((token, until)) = cached.as_ref() {
            if *until > std::time::Instant::now() { return Ok(token.clone()); }
        }
        let (token, lifetime) = oauth::access_token_with_lifetime(Provider::Teams).await?;
        // Use the server's lifetime with a safety margin; unknown lifetimes aren't cached.
        *cached = Some((token.clone(), std::time::Instant::now() + std::time::Duration::from_secs(lifetime.saturating_sub(120).min(300))));
        Ok(token)
    }
    async fn current_user(&self, client: &reqwest::Client, token: &str) -> Option<String> {
        let mut cached = self.user_id.lock().await;
        if let Some(id) = cached.as_ref() { return id.clone(); }
        let response = client.get("https://graph.microsoft.com/v1.0/me?$select=id")
            .bearer_auth(token).send().await.ok()?;
        // Existing Teams logins can still read messages before granting User.Read.
        if response.status().as_u16() == 403 {
            *cached = Some(None);
            return None;
        }
        let value = graph_response(response).await.ok()?;
        let id = value["id"].as_str()?.to_string();
        *cached = Some(Some(id.clone()));
        Some(id)
    }
}

#[derive(Serialize)]
pub struct ReactionUser {
    id: Option<String>,
    name: Option<String>,
    mine: bool,
}

#[derive(Serialize)]
pub struct Reaction {
    key: String,
    emoji: String,
    label: String,
    count: usize,
    mine: bool,
    reaction_type: Option<String>,
    users: Vec<ReactionUser>,
}

fn reactions(value: &Value, user_id: Option<&str>) -> Vec<Reaction> {
    let mut result: Vec<Reaction> = Vec::new();
    for reaction in value["reactions"].as_array().into_iter().flatten() {
        let kind = reaction["reactionType"].as_str().unwrap_or_default();
        if kind.is_empty() { continue; }
        let (emoji, default_label) = match kind {
            "like" | "👍" => ("👍", "좋아요"),
            "heart" | "❤" | "❤️" => ("❤️", "하트"),
            "laugh" | "😆" => ("😆", "웃음"),
            "surprised" | "😮" => ("😮", "놀람"),
            "sad" | "😢" => ("😢", "슬픔"),
            "angry" | "😠" => ("😠", "화남"),
            "custom" => ("✨", "사용자 지정 반응"),
            other => (other, other),
        };
        let label = reaction["displayName"].as_str().filter(|name| !name.is_empty()).unwrap_or(default_label);
        let key = if kind == "custom" {
            format!("custom:{}", reaction["reactionContentUrl"].as_str().unwrap_or(label))
        } else { emoji.to_string() };
        let mine = user_id.is_some() && reaction.pointer("/user/user/id").and_then(Value::as_str) == user_id;
        let user = ReactionUser {
            id: reaction.pointer("/user/user/id").and_then(Value::as_str).filter(|id| !id.is_empty()).map(str::to_string),
            name: reaction.pointer("/user/user/displayName").and_then(Value::as_str).filter(|name| !name.trim().is_empty()).map(str::to_string),
            mine,
        };
        if let Some(existing) = result.iter_mut().find(|item| item.key == key) {
            existing.count += 1;
            existing.mine |= mine;
            existing.users.push(user);
        } else {
            result.push(Reaction { key, emoji: emoji.into(), label: label.into(), count: 1, mine,
                reaction_type: (kind != "custom").then(|| emoji.to_string()),
                users: vec![user],
            });
        }
    }
    result
}

#[derive(Serialize)]
pub struct Message {
    id: String,
    author: String,
    created_at: String,
    body: String,
    body_type: String,
    subject: Option<String>,
    web_url: Option<String>,
    deleted: bool,
    has_attachments: bool,
    reactions: Vec<Reaction>,
    reply_count: Option<usize>,
    other_activity: i64,
    mentions_me: Vec<crate::teams_notifications::Mention>,
}

fn direct_mention(value: &Value, user_id: Option<&str>) -> Option<crate::teams_notifications::Mention> {
    let time = other_activity(value, user_id);
    if time <= 0 || !value["mentions"].as_array().into_iter().flatten().any(|mention| {
        mention.pointer("/mentioned/user/id").and_then(Value::as_str) == user_id
    }) { return None; }
    Some(crate::teams_notifications::Mention { id: value["id"].as_str()?.to_string(), time })
}

fn other_activity(value: &Value, user_id: Option<&str>) -> i64 {
    if user_id.is_none() || !value["deletedDateTime"].is_null()
        || value.pointer("/from/user/id").and_then(Value::as_str) == user_id { return 0; }
    value["createdDateTime"].as_str().and_then(|time| chrono::DateTime::parse_from_rfc3339(time).ok())
        .map(|time| time.timestamp_millis()).unwrap_or(0)
}

impl Message {
    fn from_graph(value: &Value, user_id: Option<&str>) -> Result<Self, String> {
        let text = |key: &str| value[key].as_str().unwrap_or_default().to_string();
        let id = text("id");
        if id.is_empty() {
            return Err("Teams 메시지 응답에 ID가 없습니다.".into());
        }
        Ok(Self {
            id,
            author: value.pointer("/from/user/displayName")
                .or_else(|| value.pointer("/from/application/displayName"))
                .and_then(Value::as_str).unwrap_or("Teams").to_string(),
            created_at: text("createdDateTime"),
            body: value.pointer("/body/content").and_then(Value::as_str).unwrap_or_default().to_string(),
            body_type: value.pointer("/body/contentType").and_then(Value::as_str).unwrap_or("text").to_string(),
            subject: value["subject"].as_str().map(str::to_string),
            web_url: value["webUrl"].as_str().map(str::to_string),
            deleted: !value["deletedDateTime"].is_null(),
            has_attachments: value["attachments"].as_array().is_some_and(|items| !items.is_empty()),
            reactions: reactions(value, user_id),
            reply_count: value["replies"].as_array().map(Vec::len),
            other_activity: value["replies"].as_array().into_iter().flatten()
                .map(|reply| other_activity(reply, user_id)).fold(other_activity(value, user_id), i64::max),
            mentions_me: std::iter::once(value).chain(value["replies"].as_array().into_iter().flatten())
                .filter_map(|item| direct_mention(item, user_id)).collect(),
        })
    }
}

#[derive(Serialize)]
pub struct MessagePage {
    messages: Vec<Message>,
    next: Option<String>,
    account_id: Option<String>,
}

fn messages_url(team_id: &str, channel_id: &str, parent_id: Option<&str>) -> Result<Url, String> {
    if team_id.is_empty() || channel_id.is_empty() {
        return Err("팀과 채널 ID가 필요합니다. 채널 링크를 다시 확인해 주세요.".into());
    }
    for segment in [Some(team_id), Some(channel_id), parent_id].into_iter().flatten() {
        if segment.is_empty() || segment == "." || segment == ".." || segment.contains(['/', '\\', '?', '#']) {
            return Err("올바르지 않은 Teams ID입니다.".into());
        }
    }
    let mut url = Url::parse("https://graph.microsoft.com/v1.0/").unwrap();
    {
        let mut path = url.path_segments_mut().unwrap();
        path.pop_if_empty().extend(["teams", team_id, "channels", channel_id, "messages"]);
        if let Some(parent) = parent_id {
            path.extend([parent, "replies"]);
        }
    }
    Ok(url)
}

fn page_url(base: &Url, next: Option<&str>) -> Result<Url, String> {
    if let Some(next) = next {
        let url = Url::parse(next).map_err(|_| "잘못된 다음 페이지 주소입니다.")?;
        if url.origin() != base.origin() || url.path() != base.path()
            || !url.username().is_empty() || url.password().is_some() || url.fragment().is_some()
        {
            return Err("허용되지 않은 다음 페이지 주소입니다.".into());
        }
        return Ok(url);
    }
    let mut url = base.clone();
    url.query_pairs_mut().append_pair("$top", "50");
    if base.path().ends_with("/messages") {
        url.query_pairs_mut().append_pair("$expand", "replies");
    }
    Ok(url)
}

async fn graph_response(response: reqwest::Response) -> Result<Value, String> {
    let status = response.status();
    if !status.is_success() {
        return Err(match status.as_u16() {
            401 => "Teams 로그인이 만료되었거나 권한이 바뀌었습니다. 다시 연결해 주세요.".into(),
            403 => "이 채널에 접근할 수 없습니다. 채널 멤버십과 관리자 권한 동의를 확인한 뒤 Teams를 다시 연결해 주세요.".into(),
            404 => "채널 또는 메시지를 찾을 수 없습니다. 링크와 로그인한 회사 계정을 확인해 주세요.".into(),
            429 => {
                let retry = response.headers().get("retry-after").and_then(|v| v.to_str().ok()).unwrap_or("60");
                format!("Teams 요청이 많습니다. {retry}초 후 새로고침해 주세요.")
            }
            _ => format!("Teams 요청에 실패했습니다 ({status})."),
        });
    }
    if status.as_u16() == 204 { return Ok(Value::Null); }
    response.json().await.map_err(|_| "Teams 응답을 읽을 수 없습니다.".into())
}

#[tauri::command]
pub fn teams_status() -> ProviderStatus {
    oauth::teams_status()
}

#[tauri::command]
pub async fn teams_connect(app: AppHandle, session: State<'_, TeamsSession>) -> Result<(), String> {
    let _guard = session.token_lock.lock().await;
    oauth::connect(&app, Provider::Teams).await?;
    *session.user_id.lock().await = None;
    *session.access.lock().await = None;
    Ok(())
}

#[tauri::command]
pub async fn teams_messages(
    session: State<'_, TeamsSession>,
    team_id: String,
    channel_id: String,
    parent_id: Option<String>,
    next: Option<String>,
) -> Result<MessagePage, String> {
    let base = messages_url(&team_id, &channel_id, parent_id.as_deref())?;
    let url = page_url(&base, next.as_deref())?;
    let token = session.access_token().await?;
    let client = oauth::http_client()?;
    let user_id = session.current_user(&client, &token).await;
    let response = client.get(url).bearer_auth(&token).send().await
        .map_err(|error| oauth::request_error("Teams 대화 조회", error))?;
    let value = graph_response(response).await?;
    let items = value["value"].as_array().ok_or("Teams 대화 목록이 올바르지 않습니다.")?;
    let mut messages = Vec::with_capacity(items.len());
    for item in items {
        let mut message = Message::from_graph(item, user_id.as_deref())?;
        // Expanded replies stop at 200. Follow their own pagination for an exact count.
        if parent_id.is_none() {
            let replies_base = messages_url(&team_id, &channel_id, Some(&message.id))?;
            let mut replies_next = item["replies@odata.nextLink"].as_str().map(str::to_string);
            let mut reply_ids: HashSet<String> = item["replies"].as_array().into_iter().flatten()
                .filter_map(|reply| reply["id"].as_str().map(str::to_string)).collect();
            let mut visited = HashSet::new();
            while let Some(cursor) = replies_next {
                if !visited.insert(cursor.clone()) {
                    return Err("Teams 댓글 페이지가 반복되었습니다. 다시 시도해 주세요.".into());
                }
                let response = client.get(page_url(&replies_base, Some(&cursor))?).bearer_auth(&token)
                    .send().await.map_err(|error| oauth::request_error("Teams 댓글 수 조회", error))?;
                let page = graph_response(response).await?;
                let replies = page["value"].as_array().ok_or("Teams 댓글 목록이 올바르지 않습니다.")?;
                for reply in replies {
                    message.other_activity = message.other_activity.max(other_activity(reply, user_id.as_deref()));
                    if let Some(mention) = direct_mention(reply, user_id.as_deref()) { message.mentions_me.push(mention); }
                }
                reply_ids.extend(replies.iter().filter_map(|reply| reply["id"].as_str().map(str::to_string)));
                replies_next = page["@odata.nextLink"].as_str().map(str::to_string);
            }
            if item["replies"].is_array() {
                message.reply_count = Some(reply_ids.len());
            }
        }
        messages.push(message);
    }
    let next = value["@odata.nextLink"].as_str().map(|next| page_url(&base, Some(next)).map(|url| url.to_string())).transpose()?;
    Ok(MessagePage { messages, next, account_id: user_id })
}

#[tauri::command]
pub async fn teams_send(
    session: State<'_, TeamsSession>,
    team_id: String,
    channel_id: String,
    parent_id: Option<String>,
    content: String,
    mentions: Option<Vec<SendMention>>,
) -> Result<Message, String> {
    let body = message_body(&content, mentions.unwrap_or_default())?;
    let url = messages_url(&team_id, &channel_id, parent_id.as_deref())?;
    let token = session.access_token().await?;
    // Never retry a POST automatically: the server may have accepted it before a timeout.
    let response = oauth::http_client()?.post(url).bearer_auth(token)
        .json(&body)
        .send().await.map_err(|_| "전송 결과를 확인할 수 없습니다. Teams에서 전송 여부를 확인한 후 다시 시도해 주세요.")?;
    let mut message = Message::from_graph(&graph_response(response).await?, None)?;
    if parent_id.is_none() { message.reply_count = Some(0); }
    Ok(message)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendMention {
    start: usize,
    end: usize,
    user_id: String,
    display_name: String,
}

fn html_escape(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
        .replace('"', "&quot;").replace('\'', "&#39;").replace('\n', "<br>")
}

fn utf16_byte_offset(text: &str, offset: usize) -> Option<usize> {
    let mut units = 0;
    for (byte, ch) in text.char_indices() {
        if units == offset { return Some(byte); }
        units += ch.len_utf16();
    }
    (units == offset).then_some(text.len())
}

fn message_body(content: &str, mut mentions: Vec<SendMention>) -> Result<Value, String> {
    if content.trim().is_empty() || content.chars().count() > 10_000 {
        return Err("메시지는 1~10,000자로 입력해 주세요.".into());
    }
    if mentions.is_empty() { return Ok(json!({"body":{"contentType":"text","content":content}})); }
    if mentions.len() > 50 { return Err("한 메시지에는 최대 50개의 멘션을 추가할 수 있습니다.".into()); }
    mentions.sort_by_key(|mention| mention.start);
    let mut previous = 0;
    let mut html = String::new();
    let mut identities = Vec::new();
    for (id, mention) in mentions.iter().enumerate() {
        let invalid = || "멘션 대상이나 본문이 변경되었습니다. 멘션을 다시 선택해 주세요.".to_string();
        let start = utf16_byte_offset(content, mention.start).ok_or_else(invalid)?;
        let end = utf16_byte_offset(content, mention.end).ok_or_else(invalid)?;
        if start < previous || end <= start || mention.user_id.is_empty()
            || mention.user_id.len() > 128 || mention.display_name.is_empty()
            || content.get(start..end) != Some(format!("@{}", mention.display_name).as_str())
        { return Err(invalid()); }
        html.push_str(&html_escape(&content[previous..start]));
        html.push_str(&format!("<at id=\"{id}\">{}</at>", html_escape(&mention.display_name)));
        identities.push(json!({"id":id,"mentionText":mention.display_name,
            "mentioned":{"user":{"id":mention.user_id,"displayName":mention.display_name,"userIdentityType":"aadUser"}}}));
        previous = end;
    }
    html.push_str(&html_escape(&content[previous..]));
    Ok(json!({"body":{"contentType":"html","content":html},"mentions":identities}))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelMember { user_id: String, display_name: String, email: String }

#[tauri::command]
pub async fn teams_members(session: State<'_, TeamsSession>, team_id: String, channel_id: String) -> Result<Vec<ChannelMember>, String> {
    let mut base = messages_url(&team_id, &channel_id, None)?;
    base.path_segments_mut().unwrap().pop().push("allMembers");
    let token = session.access_token().await?;
    let client = oauth::http_client()?;
    let mut url = base.clone();
    let mut visited = HashSet::new();
    let mut seen = HashSet::new();
    let mut members = Vec::new();
    loop {
        if !visited.insert(url.to_string()) { return Err("채널 멤버 페이지가 반복되었습니다.".into()); }
        let response = client.get(url).bearer_auth(&token).send().await
            .map_err(|error| oauth::request_error("채널 멤버 조회", error))?;
        if response.status().as_u16() == 403 {
            return Err("멤버 조회 권한이 필요합니다. 관리자에게 ChannelMember.Read.All 권한 동의를 요청한 뒤 Teams를 다시 연결해 주세요.".into());
        }
        let value = graph_response(response).await?;
        for member in value["value"].as_array().ok_or("채널 멤버 목록이 올바르지 않습니다.")? {
            let id = member["userId"].as_str().unwrap_or_default();
            let name = member["displayName"].as_str().unwrap_or_default();
            if !id.is_empty() && !name.is_empty() && seen.insert(id.to_string()) {
                members.push(ChannelMember {user_id:id.into(), display_name:name.into(), email:member["email"].as_str().unwrap_or_default().into()});
            }
        }
        match value["@odata.nextLink"].as_str() {
            Some(next) => url = page_url(&base, Some(next))?,
            None => break,
        }
    }
    members.sort_by(|a,b| a.display_name.cmp(&b.display_name));
    Ok(members)
}

fn message_url(team_id: &str, channel_id: &str, message_id: &str, parent_id: Option<&str>) -> Result<Url, String> {
    // Reuse ID validation for both root and reply message identifiers.
    messages_url(team_id, channel_id, Some(message_id))?;
    let mut url = messages_url(team_id, channel_id, parent_id)?;
    url.path_segments_mut().unwrap().push(message_id);
    Ok(url)
}

#[tauri::command]
pub async fn teams_react(
    session: State<'_, TeamsSession>, team_id: String, channel_id: String,
    message_id: String, parent_id: Option<String>, reaction_type: String, remove: bool,
) -> Result<Vec<Reaction>, String> {
    if reaction_type.is_empty() || reaction_type.chars().count() > 32
        || reaction_type.is_ascii() || reaction_type.chars().any(char::is_control)
    {
        return Err("반응으로 사용할 이모지를 선택해 주세요.".into());
    }
    let message_url = message_url(&team_id, &channel_id, &message_id, parent_id.as_deref())?;
    let mut action_url = message_url.clone();
    action_url.path_segments_mut().unwrap().push(if remove { "unsetReaction" } else { "setReaction" });
    let token = session.access_token().await?;
    let client = oauth::http_client()?;
    let user_id = session.current_user(&client, &token).await
        .ok_or("내 반응을 확인하려면 Teams를 다시 연결해 주세요. 로그인할 때 프로필 읽기 권한이 추가됩니다.")?;
    let response = client.post(action_url).bearer_auth(&token)
        .json(&json!({"reactionType": reaction_type})).send().await
        .map_err(|_| "반응 변경 결과를 확인할 수 없습니다. 새로고침 후 다시 확인해 주세요.")?;
    graph_response(response).await?;
    let response = client.get(message_url).bearer_auth(&token).send().await
        .map_err(|_| "반응은 변경됐지만 표시를 갱신하지 못했습니다. 새로고침해 주세요.")?;
    let value = graph_response(response).await
        .map_err(|_| "반응은 변경됐지만 표시를 갱신하지 못했습니다. 새로고침해 주세요.")?;
    Ok(reactions(&value, Some(&user_id)))
}

#[tauri::command]
pub fn teams_open(app: AppHandle, url: String) -> Result<(), String> {
    let parsed = Url::parse(&url).map_err(|_| "잘못된 Teams 링크입니다.")?;
    if parsed.scheme() != "https" || !matches!(parsed.host_str(), Some("teams.microsoft.com" | "teams.cloud.microsoft"))
        || !parsed.username().is_empty() || parsed.password().is_some()
    {
        return Err("Teams 링크만 열 수 있습니다.".into());
    }
    app.opener().open_url(parsed.as_str(), None::<&str>).map_err(|error| error.to_string())
}

fn message_link(url: &str) -> Result<Url, String> {
    let parsed = Url::parse(url).map_err(|_| "올바르지 않은 URL입니다.")?;
    if url.len() > 8192 || url.chars().any(char::is_control)
        || !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none()
        || !parsed.username().is_empty() || parsed.password().is_some()
    { return Err("HTTP 또는 HTTPS 웹 링크만 열 수 있습니다.".into()); }
    Ok(parsed)
}

#[tauri::command]
pub fn teams_open_message_url(app: AppHandle, url: String) -> Result<(), String> {
    app.opener().open_url(message_link(&url)?.as_str(), None::<&str>).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn direct_mentions_use_identity_and_include_replies_not_deleted_or_self_messages() {
        let mention = json!({"id":"reply", "createdDateTime":"2026-11-10T01:00:00Z",
            "from":{"user":{"id":"other"}}, "mentions":[{"mentioned":{"user":{"id":"me"}}}]});
        let root = json!({"id":"root", "body":{"content":"@me"}, "replies":[mention.clone()]});
        let parsed = Message::from_graph(&root, Some("me")).unwrap();
        assert_eq!(parsed.mentions_me.len(), 1);
        assert_eq!(parsed.mentions_me[0].id, "reply");
        assert!(direct_mention(&mention, Some("someone-else")).is_none());
        assert!(direct_mention(&mention, None).is_none());
        assert!(direct_mention(&root, Some("me")).is_none());
        let mut deleted = mention.clone(); deleted["deletedDateTime"] = json!("2026-11-10T02:00:00Z");
        assert!(direct_mention(&deleted, Some("me")).is_none());
        let mut own = mention; own["from"]["user"]["id"] = json!("me");
        assert!(direct_mention(&own, Some("me")).is_none());
    }

    #[test]
    fn unread_activity_uses_others_created_times_including_replies_only() {
        let mut value = json!({"id":"root","createdDateTime":"2026-11-09T00:00:00Z",
            "lastModifiedDateTime":"2026-11-09T02:00:00Z", "from":{"user":{"id":"me"}},
            "replies":[{"createdDateTime":"2026-11-09T01:00:00Z","from":{"user":{"id":"other"}}}]});
        let reply_time = chrono::DateTime::parse_from_rfc3339("2026-11-09T01:00:00Z").unwrap().timestamp_millis();
        assert_eq!(Message::from_graph(&value, Some("me")).unwrap().other_activity, reply_time);
        value["replies"][0]["from"]["user"]["id"] = json!("me");
        assert_eq!(Message::from_graph(&value, Some("me")).unwrap().other_activity, 0);
        value["from"]["user"]["id"] = json!("other");
        value["deletedDateTime"] = json!("2026-11-09T03:00:00Z");
        assert_eq!(Message::from_graph(&value, Some("me")).unwrap().other_activity, 0);
        assert_eq!(Message::from_graph(&value, None).unwrap().other_activity, 0);
    }

    #[test]
    fn message_urls_allow_web_links_and_reject_executable_or_ambiguous_links() {
        assert!(message_link("https://example.com/문서?a=1&b=2#section").is_ok());
        assert!(message_link("http://intranet.example/path").is_ok());
        for link in ["javascript:alert(1)", "file:///C:/test.exe", "data:text/html,test", "ms-teams:test", "https://user:pass@example.com", "https://example.com/\npath"] {
            assert!(message_link(link).is_err(), "{link}");
        }
    }

    #[test]
    fn mention_payload_escapes_html_and_handles_utf16_offsets() {
        let body = message_body("😀 안녕 @이&진영\n<script>", vec![SendMention {
            start: 6, end: 11, user_id: "user-1".into(), display_name: "이&진영".into(),
        }]).unwrap();
        assert_eq!(body["body"]["content"], "😀 안녕 <at id=\"0\">이&amp;진영</at><br>&lt;script&gt;");
        assert_eq!(body["mentions"][0]["mentioned"]["user"]["id"], "user-1");
        assert_eq!(body["mentions"][0]["mentionText"], "이&진영");
        assert_eq!(body["body"]["contentType"], "html");
    }

    #[test]
    fn modified_or_overlapping_mentions_are_rejected() {
        let mention = || SendMention {start:0,end:3,user_id:"u".into(),display_name:"이름".into()};
        assert!(message_body("@다름", vec![mention()]).is_err());
        assert!(message_body("@이름", vec![mention(), mention()]).is_err());
        assert_eq!(utf16_byte_offset("😀", 1), None);
        assert!(message_body("\n ", vec![]).is_err());
        assert_eq!(message_body("  줄1\n줄2", vec![]).unwrap()["body"]["content"], "  줄1\n줄2");
    }

    #[test]
    fn reaction_owner_is_the_signed_in_user() {
        let value = json!({"reactions": [
            {"reactionType":"like", "user":{"user":{"id":"someone", "displayName":"김민수"}}},
            {"reactionType":"👍", "user":{"user":{"id":"me"}}},
            {"reactionType":"heart", "user":{"user":{"id":"someone"}}}
        ]});
        let grouped = reactions(&value, Some("me"));
        assert_eq!(grouped[0].count, 2);
        assert_eq!(grouped[0].users[0].name.as_deref(), Some("김민수"));
        assert_eq!(grouped[0].users[1].id.as_deref(), Some("me"));
        assert!(grouped[0].users[1].mine);
        assert!(grouped[0].users[1].name.is_none());
        assert!(grouped[0].mine);
        assert_eq!(grouped[0].reaction_type.as_deref(), Some("👍"));
        assert!(!grouped[1].mine);
        assert!(!reactions(&value, None)[0].mine);
    }

    #[test]
    fn reaction_targets_root_or_reply_without_path_injection() {
        assert!(message_url("team", "channel", "message", None).unwrap().path().ends_with("/messages/message"));
        assert!(message_url("team", "channel", "reply", Some("parent")).unwrap().path().ends_with("/messages/parent/replies/reply"));
        assert!(message_url("team", "channel", "../other", None).is_err());
    }

    #[test]
    fn reactions_group_legacy_unicode_and_separate_custom_types() {
        let value = json!({"id":"1", "replies": [{"id":"r1"}, {"id":"r2"}], "reactions": [
            {"reactionType":"like"}, {"reactionType":"👍"}, {"reactionType":"heart"},
            {"reactionType":"🎉", "displayName":"축하"},
            {"reactionType":"custom", "displayName":"A", "reactionContentUrl":"https://example.com/a"},
            {"reactionType":"custom", "displayName":"B", "reactionContentUrl":"https://example.com/b"}
        ]});
        let message = Message::from_graph(&value, None).unwrap();
        assert_eq!(message.reply_count, Some(2));
        assert_eq!(message.reactions.len(), 5);
        assert_eq!(message.reactions[0].emoji, "👍");
        assert_eq!(message.reactions[0].count, 2);
        assert_eq!(message.reactions[2].label, "축하");
        let empty = Message::from_graph(&json!({"id":"2", "reactions":[], "replies":[]}), None).unwrap();
        assert_eq!(empty.reply_count, Some(0));
        assert!(empty.reactions.is_empty());
    }

    #[test]
    fn channel_pages_expand_replies_but_reply_pages_do_not() {
        let root = messages_url("team", "channel", None).unwrap();
        let replies = messages_url("team", "channel", Some("message")).unwrap();
        assert!(page_url(&root, None).unwrap().query_pairs().any(|(key, value)| key == "$expand" && value == "replies"));
        assert!(!page_url(&replies, None).unwrap().query_pairs().any(|(key, _)| key == "$expand"));
    }

    #[test]
    fn pagination_cannot_leak_tokens_or_switch_channels() {
        let base = messages_url("team", "19:channel@thread.tacv2", None).unwrap();
        let mut next = base.clone();
        next.set_query(Some("$skiptoken=abc"));
        assert!(page_url(&base, Some(next.as_str())).is_ok());
        for bad in ["https://evil.example/v1.0/teams/team/channels/channel/messages", "http://graph.microsoft.com/v1.0/teams/team/channels/channel/messages", "https://graph.microsoft.com/v1.0/me"] {
            assert!(page_url(&base, Some(bad)).is_err());
        }
        assert!(messages_url("..", "channel", None).is_err());
        assert!(messages_url("team", "channel", Some("a/b")).is_err());
    }

    #[test]
    fn deleted_and_bot_messages_are_supported() {
        let message = Message::from_graph(&json!({"id": "1", "from": {"application": {"displayName": "Bot"}}, "deletedDateTime": "2026-01-01", "attachments": [{"id": "a"}]}), None).unwrap();
        assert_eq!(message.author, "Bot");
        assert!(message.deleted && message.has_attachments);
        assert!(Message::from_graph(&json!({}), None).is_err());
    }
}
