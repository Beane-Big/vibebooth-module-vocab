import { useEffect, useRef } from "react";
import Icon, { type IconName } from "./Icon";
import styles from "./Nav.module.css";

export const root = "/apps/vocab/";

// 模块的导航，一份数据两种样子：宽屏是顶部居中的玻璃胶囊，手机是底部悬浮的玻璃标签栏。不显示模块名，平台门户里已经有了。
// 当前页面的标签下面垫着一块玻璃滑块：点别的标签，滑块先滑过去再换页；按住滑块（或栏上任意位置）左右拖，滑块跟着手指走，
// 松手停在最近的标签上并打开那一页。学习计划这类从首页进的页面算在“学习”下。“已学习”（做完的计划和检测记录）只在宽屏的导航里，手机上从首页进。
const tabs: { page: string; label: string; icon: IconName; wide?: boolean }[] = [
  { page: "", label: "学习", icon: "book" },
  { page: "review", label: "复习", icon: "review" },
  { page: "test", label: "检测", icon: "test" },
  { page: "wrong", label: "错题本", icon: "wrong" },
  { page: "history", label: "已学习", icon: "history", wide: true },
  { page: "settings", label: "设置", icon: "settings" },
];

const slideMs = 220; // 滑块滑到点中的标签用的时间，滑完再换页
const dragStart = 6; // 移动超过这么多像素才算拖动，否则是点击

export default function Nav({ current }: { current: string }) {
  const active = tabs.some((t) => t.page === current) ? current : "";
  const bar = useRef<HTMLElement>(null);
  const pill = useRef<HTMLSpanElement>(null);
  const drag = useRef<{ id: number; x: number; left: number; moved: boolean } | null>(null);
  const dragged = useRef(false); // 刚拖完：吞掉松手时浏览器补发的那次点击

  // 看得见的标签（手机上“已学习”是隐藏的）。
  const links = () => [...(bar.current?.querySelectorAll<HTMLAnchorElement>("a") ?? [])].filter((a) => a.offsetWidth > 0);

  // 把滑块放到某个标签上（animate 为假时直接跳过去，比如刚打开页面、窗口变大小）。
  function moveTo(a: HTMLAnchorElement | undefined, animate: boolean) {
    const p = pill.current;
    if (!a || !p) return;
    p.style.transition = animate ? `transform ${slideMs}ms cubic-bezier(0.2, 0.8, 0.2, 1), width ${slideMs}ms cubic-bezier(0.2, 0.8, 0.2, 1)` : "none";
    p.style.width = `${a.offsetWidth}px`;
    p.style.transform = `translateX(${a.offsetLeft}px)`;
    highlight(a);
  }
  // 滑块停在哪个标签上，哪个标签的字变成强调色。
  function highlight(a: HTMLAnchorElement | undefined) {
    for (const l of links()) l.classList.toggle(styles.on, l === a);
  }
  const activeLink = () => links().find((a) => a.dataset.page === active);
  // 离滑块中心最近的标签。
  function nearest(center: number) {
    let best: HTMLAnchorElement | undefined;
    for (const a of links()) if (!best || Math.abs(a.offsetLeft + a.offsetWidth / 2 - center) < Math.abs(best.offsetLeft + best.offsetWidth / 2 - center)) best = a;
    return best;
  }

  function open(a: HTMLAnchorElement | undefined) {
    if (!a) return;
    moveTo(a, true);
    if (a.dataset.page !== active) setTimeout(() => (location.href = a.href), slideMs);
  }

  useEffect(() => {
    moveTo(activeLink(), false);
    const onResize = () => moveTo(activeLink(), false);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || !pill.current) return;
    drag.current = { id: e.pointerId, x: e.clientX, left: pill.current.offsetLeft + new DOMMatrix(getComputedStyle(pill.current).transform).m41, moved: false };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    const p = pill.current;
    if (!d || d.id !== e.pointerId || !p || !bar.current) return;
    const dx = e.clientX - d.x;
    if (!d.moved) {
      if (Math.abs(dx) < dragStart) return;
      d.moved = true;
      bar.current.setPointerCapture(e.pointerId);
      p.classList.add(styles.dragging);
    }
    // 滑块中心跟着手指，不拖出第一个和最后一个标签。
    const list = links();
    const w = p.offsetWidth;
    const min = list[0].offsetLeft;
    const max = list[list.length - 1].offsetLeft + list[list.length - 1].offsetWidth - w;
    const left = Math.max(min, Math.min(max, d.left + dx));
    p.style.transition = "none";
    p.style.transform = `translateX(${left}px)`;
    highlight(nearest(left + w / 2));
  };
  const onPointerEnd = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    if (!d.moved) return; // 点击交给标签的 onClick
    pill.current?.classList.remove(styles.dragging);
    dragged.current = true;
    setTimeout(() => (dragged.current = false), 0);
    const p = pill.current!;
    const left = new DOMMatrix(getComputedStyle(p).transform).m41;
    if (e.type === "pointerup") open(nearest(left + p.offsetWidth / 2));
    else moveTo(activeLink(), true);
  };

  return (
    <nav ref={bar} className={styles.bar} aria-label="页面" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerEnd} onPointerCancel={onPointerEnd}>
      <span ref={pill} className={styles.pill} aria-hidden="true" />
      {tabs.map((t) => (
        <a
          key={t.page}
          data-page={t.page}
          href={root + (t.page ? t.page + "/" : "")}
          className={[styles.tab, t.page === active && styles.on, t.wide && styles.wide].filter(Boolean).join(" ")}
          aria-current={t.page === active ? "page" : undefined}
          draggable={false}
          onClick={(e) => {
            // 普通点击：滑块先滑过去再换页；按着 Ctrl/⌘ 等新开标签页的点击照常。
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
            e.preventDefault();
            if (!dragged.current) open(e.currentTarget);
          }}
        >
          <Icon name={t.icon} size={20} />
          <span>{t.label}</span>
        </a>
      ))}
    </nav>
  );
}
