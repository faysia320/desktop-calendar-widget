const PATHS = {
  chevronLeft: "M15 5l-7 7 7 7",
  chevronRight: "M9 5l7 7-7 7",
  plus: "M12 5v14M5 12h14",
  refresh: "M20 11a8 8 0 0 0-14.3-4.3L4 8.5M4 4v4.5h4.5M4 13a8 8 0 0 0 14.3 4.3l1.7-1.8M20 20v-4.5h-4.5",
  settings: "M4 7h9M17 7h3M4 17h3M11 17h9M15 4.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5zM9 14.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5z",
  chat: "M5 5h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H10l-4 3.5V16H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z",
  pin: "M12 21s7-6.2 7-11.5A7 7 0 0 0 5 9.5C5 14.8 12 21 12 21zM12 12a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z",
};

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
