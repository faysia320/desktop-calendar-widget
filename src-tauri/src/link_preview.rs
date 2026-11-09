use std::{collections::VecDeque, net::{IpAddr, SocketAddr}, time::{Duration, Instant}};
use base64::{Engine, engine::general_purpose::STANDARD};
use scraper::{Html, Selector};
use serde::Serialize;
use tauri::State;
use url::Url;

#[derive(Clone, Serialize)]
pub struct LinkPreview {
    url: String,
    title: String,
    description: String,
    site: String,
    image: Option<String>,
}

pub struct PreviewStore {
    cache: tokio::sync::Mutex<VecDeque<(String, Instant, LinkPreview)>>,
    gate: tokio::sync::Semaphore,
}
impl Default for PreviewStore {
    fn default() -> Self { Self { cache: Default::default(), gate: tokio::sync::Semaphore::new(2) } }
}

fn web_url(value: &str) -> Result<Url, String> {
    let mut url = Url::parse(value).map_err(|_| "Invalid preview URL")?;
    if value.len() > 8192 || value.chars().any(char::is_control) || !matches!(url.scheme(), "https" | "http")
        || url.host_str().is_none() || !url.username().is_empty() || url.password().is_some()
        || !matches!(url.port_or_known_default(), Some(80 | 443)) { return Err("Invalid preview URL".into()); }
    url.set_fragment(None);
    Ok(url)
}

fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let o = ip.octets();
            !ip.is_private() && !ip.is_loopback() && !ip.is_link_local() && !ip.is_documentation()
                && !ip.is_broadcast() && o[0] != 0 && o[0] < 224
                && !(o[0] == 100 && (64..=127).contains(&o[1]))
                && !(o[0] == 198 && (18..=19).contains(&o[1]))
                && !(o[0] == 192 && o[1] == 0 && o[2] == 0)
        }
        IpAddr::V6(ip) => {
            if let Some(v4) = ip.to_ipv4_mapped() { return public_ip(IpAddr::V4(v4)); }
            let s = ip.segments();
            (s[0] & 0xe000) == 0x2000 && !(s[0] == 0x2001 && s[1] == 0xdb8)
        }
    }
}

// Public pages only. Resolve and pin the validated addresses for every redirect;
// never send Teams credentials, browser cookies, or a Referer to preview hosts.
async fn download(value: &str, limit: usize, image: bool) -> Result<(Url, String, Vec<u8>), String> {
    let mut url = web_url(value)?;
    for _ in 0..4 {
        let host = url.host_str().ok_or("Missing host")?.to_string();
        let port = url.port_or_known_default().ok_or("Missing port")?;
        let addresses: Vec<SocketAddr> = tokio::net::lookup_host((host.as_str(), port)).await.map_err(|_| "DNS failed")?.collect();
        if addresses.is_empty() || addresses.iter().any(|address| !public_ip(address.ip())) { return Err("Private preview host".into()); }
        let client = reqwest::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(8)).resolve_to_addrs(&host, &addresses)
            .user_agent("DesktopCalendarWidget/1.0 (link preview)").build().map_err(|_| "Preview client failed")?;
        let mut response = client.get(url.clone()).send().await.map_err(|_| "Preview unavailable")?;
        if response.status().is_redirection() {
            let location = response.headers().get("location").and_then(|value| value.to_str().ok()).ok_or("Missing redirect")?;
            url = web_url(url.join(location).map_err(|_| "Invalid redirect")?.as_str())?;
            continue;
        }
        if !response.status().is_success() { return Err("Preview unavailable".into()); }
        let mime = response.headers().get("content-type").and_then(|value| value.to_str().ok()).unwrap_or("")
            .split(';').next().unwrap_or("").trim().to_lowercase();
        if if image { !matches!(mime.as_str(), "image/png" | "image/jpeg" | "image/gif" | "image/webp") }
            else { !matches!(mime.as_str(), "text/html" | "application/xhtml+xml") } { return Err("Unsupported preview type".into()); }
        if image && response.content_length().is_some_and(|length| length > limit as u64) { return Err("Preview image too large".into()); }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| "Preview download failed")? {
            if bytes.len() + chunk.len() > limit {
                if image { return Err("Preview image too large".into()); }
                bytes.extend_from_slice(&chunk[..limit - bytes.len()]);
                break;
            }
            bytes.extend_from_slice(&chunk);
        }
        return Ok((url, mime, bytes));
    }
    Err("Too many preview redirects".into())
}

fn compact(value: &str, limit: usize) -> String { value.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(limit).collect() }

fn metadata(html: &str, url: &Url) -> (LinkPreview, Option<String>) {
    let document = Html::parse_document(html);
    let meta = Selector::parse("meta").unwrap();
    let find = |keys: &[&str]| -> Option<String> {
        for key in keys {
            if let Some(value) = document.select(&meta).find(|element| {
                element.value().attr("property").or_else(|| element.value().attr("name")).is_some_and(|name| name.eq_ignore_ascii_case(key))
            }).and_then(|element| element.value().attr("content")).filter(|value| !value.trim().is_empty()) { return Some(value.to_string()); }
        }
        None
    };
    let title = find(&["og:title", "twitter:title"]).unwrap_or_else(|| document.select(&Selector::parse("title").unwrap())
        .next().map(|element| element.text().collect::<String>()).unwrap_or_default());
    let image = find(&["og:image:secure_url", "og:image", "twitter:image"]).and_then(|value| url.join(&value).ok())
        .and_then(|url| web_url(url.as_str()).ok()).map(|url| url.to_string());
    (LinkPreview { url: url.to_string(), title: compact(&title, 240),
        description: compact(&find(&["og:description", "twitter:description", "description"]).unwrap_or_default(), 500),
        site: url.host_str().unwrap_or_default().to_string(), image: None }, image)
}

async fn fetch(url: &str) -> Result<LinkPreview, String> {
    let (resolved, _, bytes) = download(url, 512 * 1024, false).await?;
    let (mut preview, image) = metadata(&String::from_utf8_lossy(&bytes), &resolved);
    if let Some(image) = image {
        if let Ok((_, mime, bytes)) = download(&image, 1024 * 1024, true).await {
            preview.image = Some(format!("data:{mime};base64,{}", STANDARD.encode(bytes)));
        }
    }
    Ok(preview)
}

#[tauri::command]
pub async fn teams_link_preview(store: State<'_, PreviewStore>, url: String) -> Result<LinkPreview, String> {
    let url = web_url(&url)?.to_string();
    let _permit = store.gate.acquire().await.map_err(|_| "Preview queue closed")?;
    {
        let mut cache = store.cache.lock().await;
        cache.retain(|(_, until, _)| *until > Instant::now());
        if let Some(index) = cache.iter().position(|(key, _, _)| *key == url) {
            let entry = cache.remove(index).unwrap();
            let result = entry.2.clone(); cache.push_back(entry); return Ok(result);
        }
    }
    let result = tokio::time::timeout(Duration::from_secs(12), fetch(&url)).await.ok().and_then(Result::ok);
    let lifetime = if result.is_some() { 3600 } else { 300 };
    let preview = result.unwrap_or_else(|| LinkPreview { url: url.clone(), title: String::new(), description: String::new(),
        site: Url::parse(&url).unwrap().host_str().unwrap_or_default().into(), image: None });
    let mut cache = store.cache.lock().await;
    cache.push_back((url, Instant::now() + Duration::from_secs(lifetime), preview.clone()));
    let mut size: usize = cache.iter().map(|(_, _, item)| item.image.as_ref().map_or(0, String::len) + item.title.len() + item.description.len()).sum();
    while cache.len() > 48 || size > 12 * 1024 * 1024 {
        if let Some((_, _, item)) = cache.pop_front() { size -= item.image.as_ref().map_or(0, String::len) + item.title.len() + item.description.len(); }
    }
    Ok(preview)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "Requires an explicit public WIDGET_PREVIEW_SMOKE_URL and network access"]
    fn public_preview_smoke() {
        let url = std::env::var("WIDGET_PREVIEW_SMOKE_URL").expect("Set WIDGET_PREVIEW_SMOKE_URL");
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let result = runtime.block_on(fetch(&url)).unwrap();
        assert!(!result.title.is_empty());
        assert!(result.image.is_some(), "The selected smoke-test page must publish a raster preview image");
    }
    #[test]
    fn extracts_entities_metadata_priority_and_relative_images() {
        let (preview, image) = metadata(r#"<title>Fallback</title><meta name='description' content='Line one&#10;line two'>
            <meta property='og:title' content='표 &amp; 링크'><meta property='og:image' content='/thumb.png'>"#,
            &Url::parse("https://example.com/page").unwrap());
        assert_eq!(preview.title, "표 & 링크"); assert_eq!(preview.description, "Line one line two");
        assert_eq!(image.as_deref(), Some("https://example.com/thumb.png"));
    }
    #[test]
    fn preview_requests_reject_local_networks_and_non_web_schemes() {
        for ip in ["127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "::1", "fc00::1", "fe80::1", "::ffff:127.0.0.1"] {
            assert!(!public_ip(ip.parse().unwrap()), "{ip}");
        }
        assert!(public_ip("8.8.8.8".parse().unwrap()));
        assert!(public_ip("2606:4700:4700::1111".parse().unwrap()));
        for url in ["file:///test", "javascript:alert(1)", "https://user:pass@example.com", "https://example.com:8080"] { assert!(web_url(url).is_err()); }
    }
}
