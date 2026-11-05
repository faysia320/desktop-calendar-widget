use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use chrono::{DateTime, Local, NaiveDate, NaiveDateTime, TimeDelta, Utc};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::time::timeout;
use url::Url;

const KEYRING_SERVICE: &str = "desktop-calendar-widget";
const LOGIN_TIMEOUT: Duration = Duration::from_secs(180);
// 브라우저가 요청 없이 미리 열어 두는 연결이 로그인 응답을 막지 않도록 짧게 끊습니다.
const REQUEST_READ_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_REQUEST_BYTES: usize = 8192;
// 응답 없는 네트워크에서 저장된 일정 안내가 늦어지지 않게 합니다.
const HTTP_TIMEOUT: Duration = Duration::from_secs(20);
const GOOGLE_PAGE_SIZE: &str = "250";
const GRAPH_PAGE_SIZE: &str = "100";
const GOOGLE_EVENTS_URL: &str = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Google,
    Microsoft,
}

struct ProviderConfig {
    client_id: String,
    client_secret: Option<String>,
    auth_url: &'static str,
    token_url: &'static str,
    scope: &'static str,
    redirect_host: &'static str,
    extra_auth_params: &'static [(&'static str, &'static str)],
}

impl Provider {
    fn keyring_user(self) -> &'static str {
        match self {
            Provider::Google => "google-refresh-token",
            Provider::Microsoft => "microsoft-refresh-token",
        }
    }

    fn config(self) -> Result<ProviderConfig, String> {
        match self {
            Provider::Google => Ok(ProviderConfig {
                client_id: required_env("GOOGLE_CLIENT_ID")?,
                client_secret: std::env::var("GOOGLE_CLIENT_SECRET")
                    .ok()
                    .filter(|secret| !secret.is_empty()),
                auth_url: "https://accounts.google.com/o/oauth2/v2/auth",
                token_url: "https://oauth2.googleapis.com/token",
                scope: "https://www.googleapis.com/auth/calendar.events",
                redirect_host: "127.0.0.1",
                extra_auth_params: &[("access_type", "offline"), ("prompt", "consent")],
            }),
            Provider::Microsoft => Ok(ProviderConfig {
                client_id: required_env("MICROSOFT_CLIENT_ID")?,
                client_secret: None,
                auth_url: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
                token_url: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
                scope: "offline_access https://graph.microsoft.com/Calendars.Read",
                redirect_host: "localhost",
                extra_auth_params: &[("prompt", "select_account")],
            }),
        }
    }
}

fn required_env(name: &str) -> Result<String, String> {
    std::env::var(name)
        .ok()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!(".env.local에 {name} 값이 없습니다."))
}

#[derive(Serialize)]
pub struct ProviderStatus {
    provider: Provider,
    configured: bool,
    connected: bool,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct CalendarEvent {
    pub(crate) id: String,
    pub(crate) title: String,
    pub(crate) start: String,
    pub(crate) end: String,
    pub(crate) all_day: bool,
    pub(crate) location: Option<String>,
}

/// 시각이 없으면 종일 일정이며, 종일 일정의 종료일은 마지막 날을 포함합니다.
#[derive(Deserialize)]
pub struct NewEvent {
    title: String,
    start_date: String,
    end_date: String,
    start_time: Option<String>,
    end_time: Option<String>,
    location: Option<String>,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: Option<String>,
}

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(HTTP_TIMEOUT)
        .build()
        .map_err(|error| error.to_string())
}

fn request_error(action: &str, error: reqwest::Error) -> String {
    if error.is_connect() || error.is_timeout() {
        return "네트워크에 연결할 수 없습니다.".to_string();
    }
    format!("{action} 실패: {error}")
}

fn random_token() -> String {
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

fn keyring_entry(provider: Provider) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, provider.keyring_user())
        .map_err(|error| format!("자격 증명 저장소를 열 수 없습니다: {error}"))
}

fn store_refresh_token(provider: Provider, token: &str) -> Result<(), String> {
    keyring_entry(provider)?.set_password(token).map_err(|error| {
        format!(
            "토큰 저장 실패({}바이트): {error}",
            token.len()
        )
    })
}

pub fn provider_status() -> Vec<ProviderStatus> {
    [Provider::Google, Provider::Microsoft]
        .into_iter()
        .map(|provider| ProviderStatus {
            provider,
            configured: provider.config().is_ok(),
            connected: keyring_entry(provider)
                .and_then(|entry| entry.get_password().map_err(|error| error.to_string()))
                .is_ok(),
        })
        .collect()
}

pub async fn connect(app: &AppHandle, provider: Provider) -> Result<(), String> {
    let config = provider.config()?;
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|error| format!("로그인 수신 포트를 열 수 없습니다: {error}"))?;
    let port = listener.local_addr().map_err(|error| error.to_string())?.port();
    let redirect_uri = format!("http://{}:{port}", config.redirect_host);

    let state = random_token();
    let verifier = random_token();
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));

    let mut auth_url = Url::parse(config.auth_url).map_err(|error| error.to_string())?;
    auth_url
        .query_pairs_mut()
        .append_pair("client_id", &config.client_id)
        .append_pair("response_type", "code")
        .append_pair("redirect_uri", &redirect_uri)
        .append_pair("scope", config.scope)
        .append_pair("state", &state)
        .append_pair("code_challenge", &challenge)
        .append_pair("code_challenge_method", "S256")
        .extend_pairs(config.extra_auth_params);

    app.opener()
        .open_url(auth_url.as_str(), None::<&str>)
        .map_err(|error| format!("브라우저를 열 수 없습니다: {error}"))?;

    let code = timeout(LOGIN_TIMEOUT, wait_for_code(&listener, &state))
        .await
        .map_err(|_| "로그인 시간이 초과되었습니다.".to_string())??;

    let token = request_token(
        &config,
        &[
            ("grant_type", "authorization_code"),
            ("code", &code),
            ("redirect_uri", &redirect_uri),
            ("code_verifier", &verifier),
        ],
    )
    .await?;
    let refresh_token = token
        .refresh_token
        .ok_or("응답에 refresh token이 없습니다.")?;

    store_refresh_token(provider, &refresh_token)
}

async fn wait_for_code(listener: &TcpListener, expected_state: &str) -> Result<String, String> {
    loop {
        let (mut stream, _) = listener.accept().await.map_err(|error| error.to_string())?;
        let Ok(Ok(Some(target))) =
            timeout(REQUEST_READ_TIMEOUT, read_request_target(&mut stream)).await
        else {
            continue;
        };

        let Ok(url) = Url::parse(&format!("http://localhost{target}")) else {
            continue;
        };
        if url.path() != "/" {
            respond(&mut stream, "404 Not Found", "").await;
            continue;
        }

        let param = |name: &str| {
            url.query_pairs()
                .find(|(key, _)| key == name)
                .map(|(_, value)| value.into_owned())
        };
        // state가 다르면 이 로그인 요청의 응답이 아니므로 무시합니다.
        if param("state").as_deref() != Some(expected_state) {
            respond(&mut stream, "400 Bad Request", "잘못된 요청입니다.").await;
            continue;
        }
        if let Some(error) = param("error") {
            let description = param("error_description").unwrap_or_default();
            respond(&mut stream, "200 OK", "로그인에 실패했습니다. 이 창을 닫아 주세요.").await;
            return Err(format!("로그인 실패: {error} {description}"));
        }
        if let Some(code) = param("code") {
            respond(&mut stream, "200 OK", "로그인되었습니다. 이 창을 닫아 주세요.").await;
            return Ok(code);
        }
        respond(&mut stream, "400 Bad Request", "잘못된 요청입니다.").await;
    }
}

async fn read_request_target(stream: &mut TcpStream) -> std::io::Result<Option<String>> {
    let mut request = Vec::new();
    let mut buffer = [0u8; 1024];
    while !request.windows(4).any(|window| window == b"\r\n\r\n") {
        let read = stream.read(&mut buffer).await?;
        if read == 0 || request.len() + read > MAX_REQUEST_BYTES {
            return Ok(None);
        }
        request.extend_from_slice(&buffer[..read]);
    }
    let request = String::from_utf8_lossy(&request);
    Ok(request
        .lines()
        .next()
        .and_then(|line| line.strip_prefix("GET "))
        .and_then(|line| line.split(' ').next())
        .filter(|target| target.starts_with('/'))
        .map(str::to_owned))
}

async fn respond(stream: &mut TcpStream, status: &str, message: &str) {
    let body = format!("<!doctype html><meta charset=\"utf-8\"><p>{message}</p>");
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.shutdown().await;
}

async fn request_token(
    config: &ProviderConfig,
    params: &[(&str, &str)],
) -> Result<TokenResponse, String> {
    let mut form = vec![("client_id", config.client_id.as_str())];
    form.extend_from_slice(params);
    if let Some(secret) = &config.client_secret {
        form.push(("client_secret", secret));
    }

    let response = http_client()?
        .post(config.token_url)
        .form(&form)
        .send()
        .await
        .map_err(|error| request_error("토큰 요청", error))?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(format!("토큰 요청 실패({status}): {body}"));
    }
    response
        .json()
        .await
        .map_err(|error| format!("토큰 응답 해석 실패: {error}"))
}

async fn access_token(provider: Provider) -> Result<String, String> {
    let config = provider.config()?;
    let refresh_token = keyring_entry(provider)?
        .get_password()
        .map_err(|error| format!("저장된 토큰을 읽을 수 없습니다. 먼저 로그인해 주세요: {error}"))?;

    let token = request_token(
        &config,
        &[
            ("grant_type", "refresh_token"),
            ("refresh_token", &refresh_token),
        ],
    )
    .await
    .map_err(|error| {
        if !is_expired_login(&error) {
            return error;
        }
        // 다시 쓸 수 없는 토큰을 지워 화면에 로그인 버튼이 나오게 합니다.
        if let Ok(entry) = keyring_entry(provider) {
            let _ = entry.delete_credential();
        }
        "로그인이 만료되었습니다. 다시 로그인해 주세요.".to_string()
    })?;
    if let Some(rotated) = &token.refresh_token {
        store_refresh_token(provider, rotated)?;
    }
    Ok(token.access_token)
}

fn is_expired_login(token_error: &str) -> bool {
    token_error.contains("invalid_grant")
}

fn parse_date(value: &str) -> Result<NaiveDate, String> {
    NaiveDate::parse_from_str(value, "%Y-%m-%d")
        .map_err(|_| format!("날짜 형식이 올바르지 않습니다: {value}"))
}

fn local_time(value: NaiveDateTime) -> Result<DateTime<Local>, String> {
    value
        .and_local_timezone(Local)
        .earliest()
        .ok_or_else(|| format!("이 시간대에 없는 시각입니다: {value}"))
}

fn local_midnight(date: NaiveDate) -> Result<DateTime<Local>, String> {
    local_time(date.and_time(chrono::NaiveTime::MIN))
}

/// `from`부터 `to` 전날까지 걸치는 일정을 가져옵니다.
pub async fn fetch_events(
    provider: Provider,
    from: &str,
    to: &str,
) -> Result<Vec<CalendarEvent>, String> {
    let start = local_midnight(parse_date(from)?)?;
    let end = local_midnight(parse_date(to)?)?;
    let access_token = access_token(provider).await?;
    match provider {
        Provider::Google => fetch_google(&access_token, start, end).await,
        Provider::Microsoft => fetch_microsoft(&access_token, start, end).await,
    }
}

pub async fn create_google_event(event: &NewEvent) -> Result<CalendarEvent, String> {
    let body = google_event_body(event)?;
    let access_token = access_token(Provider::Google).await?;

    let response = http_client()?
        .post(GOOGLE_EVENTS_URL)
        .bearer_auth(&access_token)
        .json(&body)
        .send()
        .await
        .map_err(|error| request_error("일정 등록", error))?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(format!("일정 등록 실패({status}): {body}"));
    }
    let created: GoogleEvent = response
        .json()
        .await
        .map_err(|error| format!("일정 응답 해석 실패: {error}"))?;
    Ok(created.into())
}

fn google_event_body(event: &NewEvent) -> Result<serde_json::Value, String> {
    let title = event.title.trim();
    if title.is_empty() {
        return Err("제목을 입력해 주세요.".to_string());
    }
    let start_date = parse_date(&event.start_date)?;
    let end_date = parse_date(&event.end_date)?;

    let (start, end) = match (&event.start_time, &event.end_time) {
        (Some(start_time), Some(end_time)) => {
            let at = |date: NaiveDate, time: &str| {
                chrono::NaiveTime::parse_from_str(time, "%H:%M")
                    .map(|time| date.and_time(time))
                    .map_err(|_| format!("시각 형식이 올바르지 않습니다: {time}"))
            };
            let start = at(start_date, start_time)?;
            let end = at(end_date, end_time)?;
            if end <= start {
                return Err("종료 시각은 시작 시각보다 늦어야 합니다.".to_string());
            }
            (
                serde_json::json!({ "dateTime": local_time(start)?.to_rfc3339() }),
                serde_json::json!({ "dateTime": local_time(end)?.to_rfc3339() }),
            )
        }
        (None, None) => {
            if end_date < start_date {
                return Err("종료일은 시작일보다 빠를 수 없습니다.".to_string());
            }
            // Google의 종일 일정 종료일은 마지막 날의 다음 날입니다.
            let exclusive_end = end_date + TimeDelta::days(1);
            (
                serde_json::json!({ "date": start_date.to_string() }),
                serde_json::json!({ "date": exclusive_end.to_string() }),
            )
        }
        _ => return Err("시작 시각과 종료 시각을 모두 입력해 주세요.".to_string()),
    };

    let mut body = serde_json::json!({ "summary": title, "start": start, "end": end });
    if let Some(location) = event.location.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
        body["location"] = location.into();
    }
    Ok(body)
}

async fn get_json<T: for<'de> Deserialize<'de>>(
    url: &str,
    access_token: &str,
    query: &[(&str, String)],
) -> Result<T, String> {
    let response = http_client()?
        .get(url)
        .bearer_auth(access_token)
        .query(query)
        .send()
        .await
        .map_err(|error| request_error("일정 요청", error))?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(format!("일정 요청 실패({status}): {body}"));
    }
    response
        .json()
        .await
        .map_err(|error| format!("일정 응답 해석 실패: {error}"))
}

fn format_local(time: DateTime<Local>) -> String {
    time.format("%Y-%m-%d %H:%M").to_string()
}

#[derive(Deserialize)]
struct GoogleEvents {
    #[serde(default)]
    items: Vec<GoogleEvent>,
    #[serde(rename = "nextPageToken")]
    next_page_token: Option<String>,
}

#[derive(Deserialize)]
struct GoogleEvent {
    id: String,
    summary: Option<String>,
    location: Option<String>,
    start: GoogleTime,
    end: GoogleTime,
}

impl From<GoogleEvent> for CalendarEvent {
    fn from(event: GoogleEvent) -> Self {
        CalendarEvent {
            id: event.id,
            title: event.summary.unwrap_or_else(|| "(제목 없음)".to_string()),
            all_day: event.start.date.is_some(),
            start: event.start.display(),
            end: event.end.display(),
            location: event.location,
        }
    }
}

#[derive(Deserialize)]
struct GoogleTime {
    #[serde(rename = "dateTime")]
    date_time: Option<String>,
    date: Option<String>,
}

impl GoogleTime {
    fn display(&self) -> String {
        self.date_time
            .as_deref()
            .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
            .map(|value| format_local(value.with_timezone(&Local)))
            .or_else(|| self.date.clone())
            .unwrap_or_default()
    }
}

async fn fetch_google(
    access_token: &str,
    start: DateTime<Local>,
    end: DateTime<Local>,
) -> Result<Vec<CalendarEvent>, String> {
    let mut events = Vec::new();
    let mut page_token = None;
    loop {
        let mut query = vec![
            ("singleEvents", "true".to_string()),
            ("orderBy", "startTime".to_string()),
            ("maxResults", GOOGLE_PAGE_SIZE.to_string()),
            ("timeMin", start.to_rfc3339()),
            ("timeMax", end.to_rfc3339()),
        ];
        if let Some(token) = page_token {
            query.push(("pageToken", token));
        }
        let page: GoogleEvents = get_json(GOOGLE_EVENTS_URL, access_token, &query).await?;
        events.extend(page.items.into_iter().map(CalendarEvent::from));
        page_token = page.next_page_token;
        if page_token.is_none() {
            return Ok(events);
        }
    }
}

#[derive(Deserialize)]
struct GraphEvents {
    #[serde(default)]
    value: Vec<GraphEvent>,
    #[serde(rename = "@odata.nextLink")]
    next_link: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GraphEvent {
    id: String,
    subject: Option<String>,
    is_all_day: bool,
    location: Option<GraphLocation>,
    start: GraphTime,
    end: GraphTime,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GraphLocation {
    display_name: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GraphTime {
    date_time: String,
}

impl GraphTime {
    // Prefer 헤더를 보내지 않으면 Graph는 UTC 시각을 돌려줍니다.
    fn display(&self, all_day: bool) -> String {
        if all_day {
            return self.date_time.chars().take(10).collect();
        }
        NaiveDateTime::parse_from_str(&self.date_time, "%Y-%m-%dT%H:%M:%S%.f")
            .map(|value| format_local(DateTime::<Utc>::from_naive_utc_and_offset(value, Utc).with_timezone(&Local)))
            .unwrap_or_else(|_| self.date_time.clone())
    }
}

async fn fetch_microsoft(
    access_token: &str,
    start: DateTime<Local>,
    end: DateTime<Local>,
) -> Result<Vec<CalendarEvent>, String> {
    let mut page: GraphEvents = get_json(
        "https://graph.microsoft.com/v1.0/me/calendarView",
        access_token,
        &[
            ("startDateTime", start.to_rfc3339()),
            ("endDateTime", end.to_rfc3339()),
            ("$top", GRAPH_PAGE_SIZE.to_string()),
            ("$orderby", "start/dateTime".to_string()),
            ("$select", "id,subject,isAllDay,location,start,end".to_string()),
        ],
    )
    .await?;

    let mut events = Vec::new();
    loop {
        events.extend(page.value.into_iter().map(|event| CalendarEvent {
            id: event.id,
            title: event.subject.unwrap_or_else(|| "(제목 없음)".to_string()),
            start: event.start.display(event.is_all_day),
            end: event.end.display(event.is_all_day),
            all_day: event.is_all_day,
            location: event
                .location
                .and_then(|location| location.display_name)
                .filter(|name| !name.is_empty()),
        }));
        let Some(next_link) = page.next_link else {
            return Ok(events);
        };
        page = get_json(&next_link, access_token, &[]).await?;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn send(port: u16, request: &str) -> String {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        stream.write_all(request.as_bytes()).await.unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).await.unwrap();
        response
    }

    #[test]
    fn wait_for_code_skips_unrelated_connections() {
        tauri::async_runtime::block_on(async {
            let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
            let port = listener.local_addr().unwrap().port();

            let client = tauri::async_runtime::spawn(async move {
                // 요청을 보내지 않는 사전 연결이 있어도 다음 요청을 처리해야 합니다.
                let _idle = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
                let favicon = send(port, "GET /favicon.ico HTTP/1.1\r\n\r\n").await;
                let wrong_state = send(port, "GET /?code=bad&state=other HTTP/1.1\r\n\r\n").await;
                let success = send(port, "GET /?code=good&state=expected HTTP/1.1\r\n\r\n").await;
                (favicon, wrong_state, success)
            });

            let code = wait_for_code(&listener, "expected").await.unwrap();
            let (favicon, wrong_state, success) = client.await.unwrap();

            assert_eq!(code, "good");
            assert!(favicon.starts_with("HTTP/1.1 404"));
            assert!(wrong_state.starts_with("HTTP/1.1 400"));
            assert!(success.starts_with("HTTP/1.1 200"));
        });
    }

    #[test]
    fn wait_for_code_reports_provider_error() {
        tauri::async_runtime::block_on(async {
            let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
            let port = listener.local_addr().unwrap().port();

            let client = tauri::async_runtime::spawn(async move {
                send(port, "GET /?error=access_denied&state=expected HTTP/1.1\r\n\r\n").await
            });

            let error = wait_for_code(&listener, "expected").await.unwrap_err();
            client.await.unwrap();
            assert!(error.contains("access_denied"));
        });
    }

    #[test]
    fn graph_time_converts_utc_and_keeps_all_day_date() {
        let time = GraphTime {
            date_time: "2026-11-04T01:30:00.0000000".to_string(),
        };
        let expected = format_local(
            DateTime::parse_from_rfc3339("2026-11-04T01:30:00Z")
                .unwrap()
                .with_timezone(&Local),
        );
        assert_eq!(time.display(false), expected);
        assert_eq!(time.display(true), "2026-11-04");
    }

    fn new_event(start_time: Option<&str>, end_time: Option<&str>, end_date: &str) -> NewEvent {
        NewEvent {
            title: " 회의 ".to_string(),
            start_date: "2026-11-05".to_string(),
            end_date: end_date.to_string(),
            start_time: start_time.map(str::to_owned),
            end_time: end_time.map(str::to_owned),
            location: Some("  ".to_string()),
        }
    }

    #[test]
    fn only_invalid_grant_counts_as_expired_login() {
        assert!(is_expired_login(
            r#"토큰 요청 실패(400 Bad Request): {"error": "invalid_grant"}"#
        ));
        assert!(!is_expired_login("토큰 요청 실패: connection refused"));
        assert!(!is_expired_login(
            r#"토큰 요청 실패(401 Unauthorized): {"error": "invalid_client"}"#
        ));
    }

    #[test]
    fn all_day_body_uses_exclusive_end_date() {
        let body = google_event_body(&new_event(None, None, "2026-11-06")).unwrap();
        assert_eq!(body["summary"], "회의");
        assert_eq!(body["start"]["date"], "2026-11-05");
        assert_eq!(body["end"]["date"], "2026-11-07");
        assert!(body.get("location").is_none());
    }

    #[test]
    fn timed_body_uses_local_offset() {
        let body =
            google_event_body(&new_event(Some("09:00"), Some("10:30"), "2026-11-05")).unwrap();
        let start = DateTime::parse_from_rfc3339(body["start"]["dateTime"].as_str().unwrap()).unwrap();
        let end = DateTime::parse_from_rfc3339(body["end"]["dateTime"].as_str().unwrap()).unwrap();
        assert_eq!(start.naive_local().to_string(), "2026-11-05 09:00:00");
        assert_eq!((end - start).num_minutes(), 90);
    }

    #[test]
    fn body_rejects_invalid_input() {
        let same_time = new_event(Some("09:00"), Some("09:00"), "2026-11-05");
        assert!(google_event_body(&same_time).is_err());
        assert!(google_event_body(&new_event(None, None, "2026-11-04")).is_err());
        assert!(google_event_body(&new_event(Some("09:00"), None, "2026-11-05")).is_err());

        let mut blank_title = new_event(None, None, "2026-11-05");
        blank_title.title = "  ".to_string();
        assert!(google_event_body(&blank_title).is_err());
    }

    // 실제 Credential Manager를 사용하므로 직접 지정할 때만 실행합니다.
    #[test]
    #[ignore]
    fn keyring_size_limit() {
        let entry = keyring::Entry::new(KEYRING_SERVICE, "size-limit-test").unwrap();
        for size in [1024, 2048, 2560, 2561, 4096, 8192] {
            let value = "x".repeat(size);
            match entry.set_password(&value) {
                Ok(()) => {
                    assert_eq!(entry.get_password().unwrap(), value);
                    println!("{size} bytes: ok");
                }
                Err(error) => println!("{size} bytes: {error}"),
            }
        }
        let _ = entry.delete_credential();
    }
}
