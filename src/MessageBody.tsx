import { createElement, memo, useCallback, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import LinkPreview from "./LinkPreview";
import HostedImage from "./HostedImage";

type Content = { tag: string; text?: string; url?: string; children?: Content[]; style?: CSSProperties; span?: { colSpan?: number; rowSpan?: number }; start?: number; size?: { width: number; height: number } };
type Link = { url: string; label: string };

export function safeMessageUrl(value: string): string | null {
  if (value.length > 8192 || /[\u0000-\u001f\u007f]/.test(value)) return null;
  try {
    const url = new URL(/^www\./i.test(value) ? `https://${value}` : value);
    return ["http:", "https:"].includes(url.protocol) && url.hostname && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

function linkedText(text: string, links: Map<string, Link>): Content[] {
  const parts: Content[] = [];
  let previous = 0;
  for (const match of text.matchAll(/(?:https?:\/\/|www\.)[^\s<>"\u0000-\u001f]+/gi)) {
    let value = match[0].replace(/[.,!?;:。。，！]+$/, "");
    for (const [open, close] of [["(", ")"], ["[", "]"], ["{", "}"]]) {
      while (value.endsWith(close) && value.split(close).length > value.split(open).length) value = value.slice(0, -1);
    }
    const url = safeMessageUrl(value);
    if (!url) continue;
    const start = match.index ?? 0;
    if (start > previous) parts.push({ tag: "text", text: text.slice(previous, start) });
    parts.push({ tag: "a", url, children: [{ tag: "text", text: value }] });
    links.set(url, { url, label: value });
    previous = start + value.length;
  }
  if (previous < text.length) parts.push({ tag: "text", text: text.slice(previous) });
  return parts;
}

const allowed = new Set(["div", "p", "span", "strong", "b", "em", "i", "u", "s", "del", "strike", "br", "hr",
  "ul", "ol", "li", "blockquote", "pre", "code", "h1", "h2", "h3", "h4", "h5", "h6", "table", "thead", "tbody", "tfoot", "tr", "td", "th", "caption", "sub", "sup"]);
const skipped = new Set(["script", "style", "iframe", "object", "embed", "svg", "math", "template", "form", "input", "button", "select", "textarea", "video", "audio", "attachment"]);

// Rebuild allowlisted React elements; never insert HTML or copy arbitrary attributes/styles.
export function parseMessageBody(body: string, html: boolean): { content: Content[]; links: Link[] } {
  const links = new Map<string, Link>();
  if (!html) return { content: linkedText(body, links), links: [...links.values()].slice(0, 2) };
  const template = document.createElement("template");
  template.innerHTML = body;
  let count = 0;
  function walk(node: Node, depth = 0, literal = false): Content[] {
    if (++count > 20_000 || depth > 60) return [];
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent ?? "";
      return literal ? [{ tag: "text", text }] : linkedText(text, links);
    }
    if (!(node instanceof HTMLElement)) return [];
    const tag = node.tagName.toLowerCase();
    if (skipped.has(tag)) return [];
    if (tag === "img") {
      const src = node.getAttribute("src") ?? "";
      if (/^https:\/\/graph\.microsoft\.com\/(v1\.0|beta)\/(teams|chats)\/[^?#]+\/hostedContents\/[^/?#]+\/\$value$/.test(src)) {
        const [width, height] = (["width", "height"] as const).map(key => Number(node.getAttribute(key)) || parseFloat(node.style[key]));
        const size = width > 0 && height > 0 && width <= 10_000 && height <= 10_000 ? { width, height } : undefined;
        return [{ tag: "image", url: src, text: node.getAttribute("alt") ?? "", size }];
      }
    }
    if (tag === "img") return node.getAttribute("alt") ? [{ tag: "span", children: [{ tag: "text", text: `[${node.getAttribute("alt")}]` }] }] : [];
    if (tag === "at") return [{ tag: "mention", text: node.textContent ?? "" }];
    if (tag === "a") {
      const url = safeMessageUrl(node.getAttribute("href") ?? "");
      const label = node.textContent || url || "";
      if (!url) return [{ tag: "text", text: label }];
      links.set(url, { url, label });
      return [{ tag: "a", url, children: [{ tag: "text", text: label }] }];
    }
    const children = [...node.childNodes]
      .filter(child => !(["table", "thead", "tbody", "tfoot", "tr"].includes(tag) && child.nodeType === Node.TEXT_NODE && !child.textContent?.trim()))
      .flatMap(child => walk(child, depth + 1, literal || tag === "pre" || tag === "code"));
    if (!allowed.has(tag)) return children;
    const style: CSSProperties = {};
    if (["bold", "bolder", "600", "700", "800", "900"].includes(node.style.fontWeight)) style.fontWeight = 700;
    if (node.style.fontStyle === "italic") style.fontStyle = "italic";
    if (node.style.textDecorationLine.includes("underline")) style.textDecorationLine = "underline";
    if (node.style.textDecorationLine.includes("line-through")) style.textDecorationLine = "line-through";
    if (["left", "center", "right"].includes(node.style.textAlign)) style.textAlign = node.style.textAlign as CSSProperties["textAlign"];
    const span: Content["span"] = {};
    if (tag === "td" || tag === "th") {
      for (const [attribute, prop] of [["colspan", "colSpan"], ["rowspan", "rowSpan"]] as const) {
        const value = Number(node.getAttribute(attribute));
        if (Number.isInteger(value) && value > 1 && value <= 20) span[prop] = value;
      }
    }
    const start = tag === "ol" ? Number(node.getAttribute("start") || 1) : undefined;
    return [{ tag, children, style, span, start: start !== undefined && Number.isInteger(start) && Math.abs(start) < 10_000 ? start : undefined }];
  }
  const content = [...template.content.childNodes].flatMap(node => walk(node));
  return { content, links: [...links.values()].slice(0, 2) };
}

type Channel = { teamId: string; channelId: string; chatId: string | null };

function renderContent(content: Content[], onOpen: (url: string) => void, channel: Channel): ReactNode[] {
  return content.map((part, index) => {
    if (part.tag === "text") return part.text;
    if (part.tag === "mention") return <span className="teams-inline-mention" key={index}>{part.text}</span>;
    if (part.tag === "image") return <HostedImage key={index} {...channel} url={part.url!} alt={part.text ?? ""} {...part.size} />;
    const children = renderContent(part.children ?? [], onOpen, channel);
    if (part.tag === "a") return <a key={index} href={part.url} data-tooltip={part.url} target="_blank" rel="noopener noreferrer"
      onClick={event => { event.preventDefault(); onOpen(part.url!); }}
      onAuxClick={event => { event.preventDefault(); if (event.button === 1) onOpen(part.url!); }}
      onDragStart={event => event.preventDefault()}>{children}</a>;
    const element = createElement(part.tag, { key: index, style: part.style, ...part.span, start: part.start },
      part.tag === "br" || part.tag === "hr" ? undefined : children);
    return part.tag === "table" ? <div className="teams-table-scroll" tabIndex={0} role="region" aria-label="메시지 표" key={index}>{element}</div> : element;
  });
}

// Sanitized HTML fragment inside cards: no link previews, no hosted images.
export function CardHtml({ html, onOpen }: { html: string; onOpen: (url: string) => void }) {
  const content = useMemo(() => renderContent(parseMessageBody(html, true).content, onOpen, { teamId: "", channelId: "", chatId: null }), [html, onOpen]);
  return <>{content}</>;
}

export default memo(function MessageBody({ body, bodyType, deleted, teamId, channelId, chatId }:
  { body: string; bodyType: string; deleted: boolean; teamId: string; channelId: string; chatId: string | null }) {
  const parsed = useMemo(() => parseMessageBody(deleted ? "" : body, bodyType.toLowerCase() === "html"), [body, bodyType, deleted]);
  const [error, setError] = useState("");
  const open = useCallback((url: string) => {
    setError(""); void invoke("teams_open_message_url", { url }).catch(reason => setError(String(reason)));
  }, []);
  const content = useMemo(() => renderContent(parsed.content, open, { teamId, channelId, chatId }), [parsed, open, teamId, channelId, chatId]);
  if (deleted) return <p className="muted">삭제된 메시지입니다.</p>;
  return <><div className={`teams-message-body${bodyType.toLowerCase() === "html" ? "" : " plain-text"}`}>{content}</div>
    {parsed.links.length > 0 && <div className="teams-message-previews">{parsed.links.map(link => <LinkPreview key={link.url} {...link} onOpen={open} />)}</div>}
    {error && <p className="error" role="alert">{error}</p>}</>;
});
