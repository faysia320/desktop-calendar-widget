import { memo, type CSSProperties, type ReactNode } from "react";
import { CardHtml, safeMessageUrl } from "./MessageBody";

// Minimal Adaptive Card / legacy MessageCard renderer for Workflows/bot posts. Unknown elements are skipped;
// inputs and submit actions need Teams, so the card offers "Teams에서 보기" for those.
type Element = Record<string, any>;
type Open = (url: string) => void;

const SIZES: Record<string, string> = { small: "0.92em", default: "1em", medium: "1.12em", large: "1.3em", extralarge: "1.5em" };
const COLORS: Record<string, string> = { accent: "var(--accent)", good: "#3fa760", warning: "#d39b28", attention: "#d74c4c", light: "var(--muted)" };

function inline(text: string, onOpen: Open, key = 0): ReactNode[] {
  // Card markdown: **bold**, _italic_, [label](url). Everything else stays text.
  const parts: ReactNode[] = [];
  let previous = 0;
  for (const match of text.matchAll(/\*\*(.+?)\*\*|(?<!\w)_(.+?)_(?!\w)|\[([^\]]+)\]\(([^)\s]+)\)/g)) {
    const start = match.index ?? 0;
    if (start > previous) parts.push(text.slice(previous, start));
    const id = `${key}-${start}`;
    if (match[1] != null) parts.push(<strong key={id}>{inline(match[1], onOpen, start)}</strong>);
    else if (match[2] != null) parts.push(<em key={id}>{inline(match[2], onOpen, start)}</em>);
    else {
      const url = safeMessageUrl(match[4]);
      parts.push(url ? <a key={id} href={url} data-tooltip={url} onClick={event => { event.preventDefault(); onOpen(url); }}>{match[3]}</a> : match[3]);
    }
    previous = start + match[0].length;
  }
  if (previous < text.length) parts.push(text.slice(previous));
  return parts;
}

function textStyle(element: Element): CSSProperties {
  const style: CSSProperties = {};
  const size = SIZES[String(element.size ?? "").toLowerCase()];
  if (size) style.fontSize = size;
  const weight = String(element.weight ?? "").toLowerCase();
  if (weight === "bolder") style.fontWeight = 700;
  if (weight === "lighter") style.fontWeight = 300;
  const color = COLORS[String(element.color ?? "").toLowerCase()];
  if (color) style.color = color;
  if (element.isSubtle) style.opacity = 0.72;
  if (element.italic) style.fontStyle = "italic";
  if (element.strikethrough) style.textDecorationLine = "line-through";
  const align = String(element.horizontalAlignment ?? "").toLowerCase();
  if (["left", "center", "right"].includes(align)) style.textAlign = align as CSSProperties["textAlign"];
  return style;
}

function spacing(element: Element, index: number): string {
  if (element.separator) return " separator";
  if (index === 0) return "";
  const value = String(element.spacing ?? "default").toLowerCase();
  return value === "none" ? " spacing-none" : value === "small" ? " spacing-small" : ["large", "extralarge", "padding"].includes(value) ? " spacing-large" : "";
}

function items(list: unknown, onOpen: Open, depth: number): ReactNode[] {
  if (!Array.isArray(list) || depth > 12) return [];
  return list.filter(item => item && typeof item === "object" && item.isVisible !== false)
    .map((item, index) => <div key={index} className={`adaptive-item${spacing(item, index)}`}>{element(item, onOpen, depth)}</div>);
}

function columnStyle(width: unknown): CSSProperties {
  if (width === "auto") return { flex: "0 0 auto" };
  if (typeof width === "number" || /^\d+$/.test(String(width))) return { flex: `${Number(width)} 1 0` };
  const pixels = /^(\d+)px$/.exec(String(width ?? ""));
  return pixels ? { flex: `0 0 ${Math.min(Number(pixels[1]), 400)}px` } : { flex: "1 1 0" };
}

function element(item: Element, onOpen: Open, depth: number): ReactNode {
  switch (item.type) {
    case "TextBlock":
      return <div className={item.wrap === false ? "adaptive-text nowrap" : "adaptive-text"} style={textStyle(item)}>
        {inline(String(item.text ?? ""), onOpen)}</div>;
    case "RichTextBlock":
      return <div className="adaptive-text" style={textStyle(item)}>{(Array.isArray(item.inlines) ? item.inlines : []).map((run: Element | string, index: number) =>
        typeof run === "string" ? run : <span key={index} style={{ ...textStyle(run), ...(run.underline ? { textDecorationLine: "underline" } : {}) }}>
          {run.selectAction?.type === "Action.OpenUrl" && safeMessageUrl(String(run.selectAction.url ?? ""))
            ? <a href="#" onClick={event => { event.preventDefault(); onOpen(safeMessageUrl(String(run.selectAction.url))!); }}>{String(run.text ?? "")}</a>
            : String(run.text ?? "")}</span>)}</div>;
    case "Container":
      return <div className={item.style && item.style !== "default" ? `adaptive-container emphasis` : "adaptive-container"}>{items(item.items, onOpen, depth + 1)}</div>;
    case "ColumnSet":
      return <div className="adaptive-columns">{(Array.isArray(item.columns) ? item.columns : []).filter((column: Element) => column?.isVisible !== false)
        .map((column: Element, index: number) => <div key={index} className="adaptive-column" style={columnStyle(column.width)}>
          {items(column.items, onOpen, depth + 1)}</div>)}</div>;
    case "FactSet":
      return <dl className="adaptive-facts">{(Array.isArray(item.facts) ? item.facts : []).map((fact: Element, index: number) => <div key={index}>
        <dt>{inline(String(fact.title ?? ""), onOpen)}</dt><dd>{inline(String(fact.value ?? ""), onOpen)}</dd></div>)}</dl>;
    case "Table":
      return <div className="teams-table-scroll" tabIndex={0} role="region" aria-label="카드 표"><table className="adaptive-table"><tbody>
        {(Array.isArray(item.rows) ? item.rows : []).map((row: Element, rowIndex: number) => <tr key={rowIndex}>
          {(Array.isArray(row.cells) ? row.cells : []).map((cell: Element, cellIndex: number) => {
            const header = rowIndex === 0 && item.firstRowAsHeaders !== false;
            const content = items(cell.items, onOpen, depth + 1);
            return header ? <th key={cellIndex}>{content}</th> : <td key={cellIndex}>{content}</td>;
          })}</tr>)}</tbody></table></div>;
    case "Image": {
      const url = safeMessageUrl(String(item.url ?? ""));
      return url?.startsWith("https:") ? <img className="adaptive-image" src={url} alt={String(item.altText ?? "")} referrerPolicy="no-referrer" loading="lazy" /> : null;
    }
    case "ActionSet":
      return actions(item.actions, onOpen);
    default:
      return null;
  }
}

function actions(list: unknown, onOpen: Open): ReactNode {
  const links = (Array.isArray(list) ? list : [])
    .filter((action: Element) => action?.type === "Action.OpenUrl" && safeMessageUrl(String(action.url ?? "")))
    .slice(0, 6);
  return links.length > 0 && <div className="adaptive-actions">{links.map((action: Element, index: number) =>
    <button key={index} type="button" onClick={() => onOpen(safeMessageUrl(String(action.url))!)}>{String(action.title || "열기")} ↗</button>)}</div>;
}

// MessageCard (o365connector) text fields are HTML or markdown; both go through the HTML sanitizer.
function messageCardText(value: unknown, onOpen: Open, className = "adaptive-text html") {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return null;
  const html = /<[a-z][^>]*>|&#?\w+;/i.test(text) ? text : text.replace(/[&<>]/g, char => `&${{ "&": "amp", "<": "lt", ">": "gt" }[char]};`)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/\r?\n/g, "<br>");
  return <div className={className}><CardHtml html={html} onOpen={onOpen} /></div>;
}

function messageCardActions(list: unknown, onOpen: Open): ReactNode {
  const links = (Array.isArray(list) ? list : []).flatMap((action: Element) => {
    if (action?.["@type"] !== "OpenUri") return [];
    const target = (Array.isArray(action.targets) ? action.targets : []).find((item: Element) => !item?.os || item.os === "default");
    const url = safeMessageUrl(String(target?.uri ?? ""));
    return url ? [{ title: String(action.name || "열기"), url }] : [];
  }).slice(0, 6);
  return links.length > 0 && <div className="adaptive-actions">{links.map((link, index) =>
    <button key={index} type="button" onClick={() => onOpen(link.url)}>{link.title} ↗</button>)}</div>;
}

function MessageCard({ card, onOpen }: { card: Element; onOpen: Open }) {
  const color = /^#?[0-9a-f]{6}$/i.test(String(card.themeColor ?? "")) ? `#${String(card.themeColor).replace("#", "")}` : undefined;
  return <div className="adaptive-card" style={color ? { borderTopColor: color } : undefined}>
    {messageCardText(card.title, onOpen, "adaptive-text html message-card-title")}
    {messageCardText(card.text, onOpen)}
    {(Array.isArray(card.sections) ? card.sections : []).slice(0, 20).map((section: Element, index: number) => <div key={index} className="message-card-section">
      {messageCardText(section.activityTitle, onOpen, "adaptive-text html message-card-activity")}
      {messageCardText(section.activitySubtitle, onOpen, "adaptive-text html muted")}
      {messageCardText(section.activityText, onOpen)}
      {messageCardText(section.title, onOpen, "adaptive-text html message-card-activity")}
      {messageCardText(section.text, onOpen)}
      {Array.isArray(section.facts) && section.facts.length > 0 && <dl className="adaptive-facts">{section.facts.slice(0, 50).map((fact: Element, factIndex: number) =>
        <div key={factIndex}><dt>{messageCardText(fact.name, onOpen, "adaptive-text html")}</dt><dd>{messageCardText(fact.value, onOpen)}</dd></div>)}</dl>}
      {messageCardActions(section.potentialAction, onOpen)}
    </div>)}
    {messageCardActions(card.potentialAction, onOpen)}
  </div>;
}

export default memo(function AdaptiveCard({ card, onOpen }: { card: Element; onOpen: Open }) {
  if (card.type === "MessageCard") return <MessageCard card={card} onOpen={onOpen} />;
  return <div className="adaptive-card">{items(card.body, onOpen, 0)}{actions(card.actions, onOpen)}</div>;
});
