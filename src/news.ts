export type Article = {
  id: string;
  title: string;
  url: string;
  published: string;
  content_html: string;
};

export type NewsFeed = {
  articles: Article[];
  fetched_at: string;
  stale: boolean;
};

// 피드의 제목과 본문은 HTML입니다. 화면에 넣지 않고 글자만 꺼내 쓰며, 목록 항목은 줄을 나눕니다.
export function htmlToText(html: string): string {
  const { body } = new DOMParser().parseFromString(html, "text/html");
  body.querySelectorAll("li, p").forEach((block) => block.append("\n"));
  return (body.textContent ?? "").replace(/\s*\n\s*/g, "\n").trim();
}

export function formatArticleAge(published: string, now: Date): string {
  const minutes = Math.floor((now.getTime() - new Date(published).getTime()) / 60_000);
  if (Number.isNaN(minutes)) return "";
  if (minutes < 1) return "방금";
  if (minutes < 60) return `${minutes}분 전`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}시간 전`;
  return `${Math.floor(minutes / (24 * 60))}일 전`;
}
