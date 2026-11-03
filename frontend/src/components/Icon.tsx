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
};

export type IconName = keyof typeof paths;

export default function Icon({ name, size = 24 }: { name: IconName; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={paths[name]} fill={name === "play" ? "currentColor" : "none"} />
    </svg>
  );
}
