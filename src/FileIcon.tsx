// Teams-like file badges: zipped folder for archives, colored page with the extension otherwise.
const KINDS: [string[], string][] = [
  [["xls", "xlsx", "xlsm", "csv"], "#1f8f4e"],
  [["ppt", "pptx"], "#d35230"],
  [["doc", "docx", "rtf"], "#2b6fd6"],
  [["pdf"], "#d13438"],
  [["png", "jpg", "jpeg", "gif", "bmp", "webp", "svg", "heic"], "#8a5cd1"],
  [["mp4", "mov", "avi", "mkv", "wmv"], "#c2398a"],
  [["txt", "log", "md", "json", "xml"], "#6b7a8c"],
];
const ARCHIVES = ["zip", "7z", "rar", "tar", "gz", "tgz"];

export default function FileIcon({ name, size = 28 }: { name: string; size?: number }) {
  const extension = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  if (ARCHIVES.includes(extension)) {
    return <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <path d="M3 8a2 2 0 0 1 2-2h7l3 3h12a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" fill="#e8a317" />
      <path d="M3 12h26v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" fill="#ffc83d" />
      <path d="M17 12h2v2h-2zM19 14h2v2h-2zM17 16h2v2h-2zM19 18h2v2h-2z" fill="#9c6500" />
      <rect x="16.5" y="20" width="5" height="4" rx="1" fill="#9c6500" />
    </svg>;
  }
  const color = KINDS.find(([extensions]) => extensions.includes(extension))?.[1] ?? "#7a8594";
  const label = extension.slice(0, 4).toUpperCase();
  return <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
    <path d="M7 2h12l7 7v19a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z" fill="#f4f5f7" />
    <path d="M19 2l7 7h-5a2 2 0 0 1-2-2z" fill="#c9ced6" />
    <rect x="2" y="16" width="22" height="10" rx="2" fill={color} />
    {label && <text x="13" y="23.6" textAnchor="middle" fontSize={label.length > 3 ? 6.4 : 7.4} fontWeight="700"
      fontFamily="Segoe UI, sans-serif" fill="#fff">{label}</text>}
  </svg>;
}
