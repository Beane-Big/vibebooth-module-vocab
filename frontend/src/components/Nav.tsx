import { useEffect, useRef } from "react";
import Icon, { type IconName } from "./Icon";
import styles from "./Nav.module.css";

export const root = "/apps/vocab/";

// 模块的导航，一份数据两种样子：宽屏是顶部居中的玻璃胶囊，手机是底部悬浮的玻璃标签栏。不显示模块名，平台门户里已经有了。
// 当前页面的标签带一块玻璃高亮；学习计划这类从首页进的页面算在“学习”下。学习记录只在宽屏的导航里，手机上从首页进。
// 玻璃默认是 CSS 的毛玻璃；浏览器支持 WebGL 时换成 liquidglass 渲染的液态玻璃（会折射下面的内容），见 useLiquidGlass。
const tabs: { page: string; label: string; icon: IconName; wide?: boolean }[] = [
  { page: "", label: "学习", icon: "book" },
  { page: "review", label: "复习", icon: "review" },
  { page: "test", label: "检测", icon: "test" },
  { page: "wrong", label: "错题本", icon: "wrong" },
  { page: "history", label: "记录", icon: "history", wide: true },
  { page: "settings", label: "设置", icon: "settings" },
];

export default function Nav({ current }: { current: string }) {
  const active = tabs.some((t) => t.page === current) ? current : "";
  const bar = useRef<HTMLElement>(null);
  useLiquidGlass(bar);
  return (
    <nav ref={bar} className={styles.bar} aria-label="页面">
      {tabs.map((t) => (
        <a
          key={t.page}
          href={root + (t.page ? t.page + "/" : "")}
          className={[styles.tab, t.page === active && styles.on, t.wide && styles.wide].filter(Boolean).join(" ")}
          aria-current={t.page === active ? "page" : undefined}
        >
          <Icon name={t.icon} size={20} />
          <span>{t.label}</span>
        </a>
      ))}
    </nav>
  );
}

const hasWebGL = () => {
  try {
    return !!document.createElement("canvas").getContext("webgl");
  } catch {
    return false;
  }
};

// 用 liquidglass 把导航栏渲染成液态玻璃。它要求玻璃是 root 的直接子元素，root 的其他子元素（背景色块、页面内容）
// 截成图后做折射；截图默认只截一次，所以页面内容变了（翻卡片、答题）要让它重截，这里合并成每 300 毫秒最多一次。
// 下面的字透过玻璃会被虚化（blurAmount），免得和标签的字叠在一起看不清。
// 不支持 WebGL、用户要求减少透明效果、或初始化失败时什么都不做，导航保持 CSS 毛玻璃。
function useLiquidGlass(bar: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = bar.current;
    const host = el?.parentElement;
    if (!el || !host || !hasWebGL() || matchMedia("(prefers-reduced-transparency: reduce)").matches) return;
    let stopped = false;
    let lg: import("../vendor/liquidglass").LiquidGlass | undefined;
    let observer: MutationObserver | undefined;
    let timer = 0;
    const changed = new Set<HTMLElement>();

    const config = () => {
      // 圆角跟着栏高变（宽屏和手机不一样高），保持胶囊形。
      el.dataset.config = JSON.stringify({ cornerRadius: el.offsetHeight / 2, zRadius: 18, refraction: 0.5, blurAmount: 0.55, brightness: 0.1, saturation: 0.2, edgeHighlight: 0.15, specular: 0.3, shadowOpacity: 0.18, shadowSpread: 14 });
    };
    // 正在截图的元素先不重截（liquidglass 会直接忽略），等它截完再来；截图期间内容又变了也会再截一次。
    const flush = () => {
      timer = 0;
      if (!lg) return;
      for (const child of [...changed]) {
        if (lg.capture._capturing.has(child)) continue;
        changed.delete(child);
        lg.capture.captureElement(child, true).finally(later);
      }
      later();
    };
    const later = () => {
      if (changed.size && !timer && !stopped) timer = window.setTimeout(flush, 300);
    };

    import("../vendor/liquidglass")
      .then(async ({ LiquidGlass }) => {
        config();
        const inst = await LiquidGlass.init({ root: host, glassElements: [el] });
        if (stopped) return inst.destroy();
        lg = inst;
        el.classList.add(styles.liquid);
        observer = new MutationObserver((records) => {
          for (const r of records) {
            let node: Node | null = r.target;
            while (node && node.parentNode !== host) node = node.parentNode;
            if (node instanceof HTMLElement && node !== el) changed.add(node);
          }
          later();
        });
        // 不看 style 的变化：拖卡片时每一帧都改 style，没必要每次重截；换页后的内容变化会触发重截。
        observer.observe(host, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["class"] });
      })
      .catch((err) => console.warn("液态玻璃不可用，导航用 CSS 毛玻璃：", err));

    window.addEventListener("resize", config);
    return () => {
      stopped = true;
      clearTimeout(timer);
      observer?.disconnect();
      window.removeEventListener("resize", config);
      el.classList.remove(styles.liquid);
      lg?.destroy();
    };
  }, [bar]);
}
