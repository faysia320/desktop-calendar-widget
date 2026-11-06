use std::path::Path;

use chrono::Local;
use roxmltree::{Document, Node};
use serde::{Deserialize, Serialize};
use url::Url;

use crate::oauth::{http_client, request_error};

const FEED_URL: &str = "https://news.hada.io/rss/news";
const ARTICLE_HOST: &str = "news.hada.io";

#[derive(Clone, Serialize, Deserialize)]
pub struct Article {
    id: String,
    title: String,
    url: String,
    published: String,
    content_html: String,
}

#[derive(Serialize, Deserialize)]
pub struct NewsFeed {
    articles: Vec<Article>,
    fetched_at: String,
    // 받아 오지 못해 저장된 목록을 대신 보여 주는 중입니다.
    #[serde(default)]
    stale: bool,
}

// 피드 내용이 다른 프로그램이나 사이트를 열게 하지 못하도록 GeekNews 주소만 엽니다.
pub fn is_article_url(url: &str) -> bool {
    Url::parse(url).is_ok_and(|url| url.scheme() == "https" && url.host_str() == Some(ARTICLE_HOST))
}

fn child_text(entry: Node, name: &str) -> String {
    entry
        .children()
        .find(|node| node.has_tag_name(name))
        .and_then(|node| node.text())
        .unwrap_or_default()
        .trim()
        .to_string()
}

fn article_from(entry: Node) -> Option<Article> {
    let url = entry
        .children()
        .filter(|node| node.has_tag_name("link"))
        .find(|node| node.attribute("rel").is_none_or(|rel| rel == "alternate"))?
        .attribute("href")?
        .to_string();
    let title = child_text(entry, "title");
    if title.is_empty() || !is_article_url(&url) {
        return None;
    }
    Some(Article {
        id: child_text(entry, "id"),
        title,
        url,
        published: child_text(entry, "published"),
        content_html: child_text(entry, "content"),
    })
}

fn parse_feed(xml: &str) -> Result<Vec<Article>, String> {
    let document = Document::parse(xml).map_err(|error| format!("GeekNews 피드 해석 실패: {error}"))?;
    let articles: Vec<Article> = document
        .root_element()
        .children()
        .filter(|node| node.has_tag_name("entry"))
        .filter_map(article_from)
        .collect();
    // 빈 목록이 저장된 글을 덮어쓰지 않도록 실패로 다룹니다.
    if articles.is_empty() {
        return Err("GeekNews 피드에 글이 없습니다.".to_string());
    }
    Ok(articles)
}

async fn download() -> Result<Vec<Article>, String> {
    let response = http_client()?
        .get(FEED_URL)
        .send()
        .await
        .map_err(|error| request_error("GeekNews 요청", error))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("GeekNews 요청 실패({status})"));
    }
    let xml = response
        .text()
        .await
        .map_err(|error| request_error("GeekNews 요청", error))?;
    parse_feed(&xml)
}

fn load_cached(cache_path: &Path) -> Option<NewsFeed> {
    serde_json::from_slice(&std::fs::read(cache_path).ok()?).ok()
}

/// 최신 글을 받아 저장합니다. 받지 못하면 마지막으로 저장한 글을 돌려줍니다.
pub async fn fetch(cache_path: &Path) -> Result<NewsFeed, String> {
    match download().await {
        Ok(articles) => {
            let feed = NewsFeed {
                articles,
                fetched_at: Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
                stale: false,
            };
            // 저장에 실패해도 받아 온 글은 그대로 보여 줍니다.
            let saved = serde_json::to_vec(&feed)
                .map_err(|error| error.to_string())
                .and_then(|bytes| {
                    if let Some(parent) = cache_path.parent() {
                        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
                    }
                    std::fs::write(cache_path, bytes).map_err(|error| error.to_string())
                });
            if let Err(error) = saved {
                eprintln!("GeekNews 저장 실패: {error}");
            }
            Ok(feed)
        }
        Err(error) => match load_cached(cache_path) {
            Some(cached) => Ok(NewsFeed { stale: true, ..cached }),
            None => Err(error),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FEED: &str = r#"<?xml version='1.0' encoding='UTF-8'?>
<feed xmlns='http://www.w3.org/2005/Atom'>
<title>GeekNews</title>
<link rel='self' href='https://news.hada.io/rss/news' />
<entry>
  <title><![CDATA[첫 글 <제목>]]></title>
  <link rel='alternate' type='text/html' href='https://news.hada.io/topic?id=1&amp;utm_source=geeknews' />
  <id>https://news.hada.io/topic?id=1</id>
  <published>2026-11-06T09:39:03+09:00</published>
  <content type='html'><![CDATA[<ul><li>요약</li></ul>]]></content>
</entry>
<entry>
  <title>다른 주소 글</title>
  <link rel='alternate' href='https://example.com/1' />
  <id>2</id>
</entry>
</feed>"#;

    #[test]
    fn feed_entries_are_read_and_foreign_links_are_dropped() {
        let articles = parse_feed(FEED).unwrap();
        assert_eq!(articles.len(), 1);
        let article = &articles[0];
        assert_eq!(article.title, "첫 글 <제목>");
        assert_eq!(article.url, "https://news.hada.io/topic?id=1&utm_source=geeknews");
        assert_eq!(article.published, "2026-11-06T09:39:03+09:00");
        assert_eq!(article.content_html, "<ul><li>요약</li></ul>");
    }

    #[test]
    fn feed_without_articles_is_an_error() {
        assert!(parse_feed("<feed xmlns='http://www.w3.org/2005/Atom'></feed>").is_err());
        assert!(parse_feed("<html>점검 중").is_err());
    }

    #[test]
    fn only_geeknews_https_links_can_be_opened() {
        assert!(is_article_url("https://news.hada.io/topic?id=1"));
        assert!(!is_article_url("http://news.hada.io/topic?id=1"));
        assert!(!is_article_url("https://news.hada.io.example.com/"));
        assert!(!is_article_url("file:///C:/Windows/System32/calc.exe"));
        assert!(!is_article_url("not a url"));
    }
}
