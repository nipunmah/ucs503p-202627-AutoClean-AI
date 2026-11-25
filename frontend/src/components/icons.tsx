import type { SVGProps } from "react";

/**
 * Minimal inline icon set (24x24, stroke-based). No icon dependency.
 * Usage: <Icon name="upload" size={16} />
 */
const PATHS = {
  upload: "M12 16V4m0 0-4 4m4-4 4 4M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2",
  download: "M12 4v12m0 0-4-4m4 4 4-4M4 18v0a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2",
  database: "M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3Zm0 0v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3",
  table: "M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5Zm0 4h18M3 15h18M9 3v18",
  columns: "M4 4h4v16H4zM10 4h4v16h-4zM16 4h4v16h-4z",
  gauge: "M12 14l4-4M3.5 18a9 9 0 1 1 17 0",
  sparkles: "M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8L12 3ZM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15Z",
  wand: "M15 4V2m0 14v-2M8 9H6m16 0h-2M17.8 11.8 19 13M17.8 6.2 19 5M12.2 6.2 11 5M3 21l9-9",
  play: "M7 4v16l13-8L7 4Z",
  check: "M5 12.5l4.5 4.5L19 7",
  checkCircle: "M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0ZM8 12.5l2.5 2.5L16 9.5",
  alert: "M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z",
  info: "M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0ZM12 16v-4m0-4h.01",
  x: "M18 6 6 18M6 6l12 12",
  plus: "M12 5v14M5 12h14",
  search: "M21 21l-4.3-4.3M19 11a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z",
  chevronRight: "M9 18l6-6-6-6",
  chevronDown: "M6 9l6 6 6-6",
  chat: "M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z",
  mic: "M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Zm7-3a7 7 0 0 1-14 0m7 7v3",
  speaker: "M11 5 6 9H2v6h4l5 4V5Zm4.5 3.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14",
  send: "M22 2 11 13M22 2l-7 20-4-9-9-4 20-7Z",
  sun: "M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10ZM12 1v2m0 18v2M4.2 4.2l1.4 1.4m12.8 12.8 1.4 1.4M1 12h2m18 0h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4",
  moon: "M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z",
  merge: "M6 3v6a6 6 0 0 0 6 6h6m0 0-3-3m3 3-3 3M6 21v-6",
  flask: "M9 3h6M10 3v6L4.5 18.5A2 2 0 0 0 6.2 21h11.6a2 2 0 0 0 1.7-2.5L14 9V3M7 15h10",
  brain: "M9 4a3 3 0 0 0-3 3v.5A3 3 0 0 0 4 10.3 3 3 0 0 0 5 16a3 3 0 0 0 4 3.8V4Zm6 0a3 3 0 0 1 3 3v.5a3 3 0 0 1 2 2.8A3 3 0 0 1 19 16a3 3 0 0 1-4 3.8V4Z",
  history: "M3 12a9 9 0 1 0 3-6.7L3 8m0-5v5h5m4-1v5l3 2",
  layers: "M12 2 2 7l10 5 10-5-10-5ZM2 17l10 5 10-5M2 12l10 5 10-5",
  file: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6Zm0 0v6h6",
  command: "M9 6a3 3 0 1 0-3 3h3V6Zm0 0v12m0-12h6m-6 12a3 3 0 1 1-3-3h3v3Zm0 0h6m0 0v-3m0 3a3 3 0 1 0 3-3h-3m0-9a3 3 0 1 1 3 3h-3V6Zm0 3v6",
  copy: "M9 9h11v11H9zM5 15H4V4h11v1",
  refresh: "M21 12a9 9 0 0 1-15.5 6.2L3 16m0 5v-5h5M3 12a9 9 0 0 1 15.5-6.2L21 8m0-5v5h-5",
  sliders: "M4 21v-7m0-4V3m8 18v-9m0-4V3m8 18v-5m0-4V3M1 14h6m2-6h6m2 8h6",
  target: "M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0ZM18 12a6 6 0 1 1-12 0 6 6 0 0 1 12 0ZM14 12a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z",
  trash: "M3 6h18M8 6V4h8v2m-9 0 1 14h8l1-14",
  arrowRight: "M5 12h14m-6-6 6 6-6 6",
  stop: "M6 6h12v12H6z",
} as const;

export type IconName = keyof typeof PATHS;

interface IconProps extends Omit<SVGProps<SVGSVGElement>, "name"> {
  name: IconName;
  size?: number;
}

export function Icon({ name, size = 16, strokeWidth = 1.8, className, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={className ? `icon ${className}` : "icon"}
      {...rest}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
