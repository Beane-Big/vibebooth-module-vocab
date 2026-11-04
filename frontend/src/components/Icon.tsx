// 模块里用到的线条图标，24×24，颜色跟着文字颜色走。
const paths = {
  book: "M4 5.5A1.5 1.5 0 0 1 5.5 4H10a2 2 0 0 1 2 2v13a1.5 1.5 0 0 0-1.5-1.5h-5A1.5 1.5 0 0 1 4 16zM20 5.5A1.5 1.5 0 0 0 18.5 4H14a2 2 0 0 0-2 2v13a1.5 1.5 0 0 1 1.5-1.5h5a1.5 1.5 0 0 0 1.5-1.5z",
  review: "M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4v4h-4M12 8.5V12l2.5 1.5",
  test: "M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2M9 5a1.5 1.5 0 0 0 1.5 1.5h3A1.5 1.5 0 0 0 15 5a1.5 1.5 0 0 0-1.5-1.5h-3A1.5 1.5 0 0 0 9 5zM8.5 13l2.5 2.5 4.5-5",
  wrong: "M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17zM9 9l6 6M15 9l-6 6",
  history: "M4 6h16M4 12h16M4 18h10",
  settings:
    "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 13.5a7.6 7.6 0 0 0 0-3l2-1.6-2-3.4-2.4.9a7.5 7.5 0 0 0-2.6-1.5L14 2.5h-4l-.4 2.4A7.5 7.5 0 0 0 7 6.4l-2.4-.9-2 3.4 2 1.6a7.6 7.6 0 0 0 0 3l-2 1.6 2 3.4 2.4-.9a7.5 7.5 0 0 0 2.6 1.5l.4 2.4h4l.4-2.4a7.5 7.5 0 0 0 2.6-1.5l2.4.9 2-3.4z",
  play: "M8 5.5v13l10.5-6.5z",
  pause: "M8 5v14M16 5v14",
  replay: "M4.5 12a7.5 7.5 0 1 0 2.2-5.3M4.5 4v4h4",
  sound: "M4 9.5h3.5L12 5.5v13l-4.5-4H4zM15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11",
  mute: "M4 9.5h3.5L12 5.5v13l-4.5-4H4zM16 9.5l5 5M21 9.5l-5 5",
  prev: "M14.5 6l-6 6 6 6",
  next: "M9.5 6l6 6-6 6",
  check: "M5 12.5l4.5 4.5L19 7.5",
  cross: "M6.5 6.5l11 11M17.5 6.5l-11 11",
  // 题型：看词、听音、开口说、听写。
  eye: "M2.5 12s3.5-6.5 9.5-6.5S21.5 12 21.5 12s-3.5 6.5-9.5 6.5S2.5 12 2.5 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  ear: "M4 15v-3a8 8 0 0 1 16 0v3M4 15a2 2 0 0 1 2-2h1v7H6a2 2 0 0 1-2-2zM20 15a2 2 0 0 0-2-2h-1v7h1a2 2 0 0 0 2-2z",
  mic: "M12 3.5a3 3 0 0 0-3 3V12a3 3 0 0 0 6 0V6.5a3 3 0 0 0-3-3zM5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3",
  keyboard: "M3.5 7h17v10h-17zM7 10.5h.01M10.5 10.5h.01M14 10.5h.01M17 10.5h.01M8 14h8",
  translate: "M4 5h7M7.5 3.5V5M5.5 5c0 3 2 5.5 5 6.5M9.5 5c0 3-2 6-5.5 7.5M13 20l3.5-9 3.5 9M14.3 17h4.4",
  trash: "M4 7h16M9 7V4.5h6V7M6.5 7l1 13h9l1-13M10 11v6M14 11v6",
  pen: "M4 20l4-1 10.5-10.5a2.1 2.1 0 0 0-3-3L5 16zM14 7l3 3",
  // 检测范围：最近、序号范围、全部。
  clock: "M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17zM12 7.5V12l3 2",
  hash: "M5 9h15M4 15h15M10 4L8 20M16 4l-2 16",
  layers: "M12 3.5l-9 5 9 5 9-5zM3 12.5l9 5 9-5M3 16.5l9 5 9-5",
  trophy: "M8 4h8v5a4 4 0 0 1-8 0zM8 6H5a3 3 0 0 0 3 4M16 6h3a3 3 0 0 1-3 4M12 13v4M8.5 20.5h7M10 17h4v3.5h-4z",
};

export type IconName = keyof typeof paths;

export default function Icon({ name, size = 24 }: { name: IconName; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={paths[name]} fill={name === "play" ? "currentColor" : "none"} />
    </svg>
  );
}
