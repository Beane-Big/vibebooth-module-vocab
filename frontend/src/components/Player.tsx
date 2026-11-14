import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { Settings, Word } from "../api";
import { canSpeak, keepAudioAwake, plainZh, prefetchSpeech, speak, stopSpeaking, wait } from "../speech";
import ExitButton from "./ExitButton";
import Icon from "./Icon";
import { useImmersive } from "./Nav";
import WordCard, { pagesOf, type Page } from "./WordCard";
import styles from "./Player.module.css";

type Props = {
  words: Word[];
  examples: number;
  settings: Settings;
  start?: number;
  onPos?: (pos: number) => void; // 翻页时调用，用来记住学到第几页
  onDone: () => void; // 翻过最后一页（或自动播放完）
  doneLabel?: string;
  onExit: () => void; // 左上角的 × ：不学了（位置已经随翻页记下）
};

// 翻页后等一会儿再读，卡片换完、眼睛先看到字再听到声音；连续快速翻页时只读最后停下的那一页。
const readDelay = 400;

// 翻页动画：旧卡片往翻页方向滑出（out 毫秒），新卡片从另一侧滑进来（in 毫秒），不旋转。
// 拖动超过 swipe 像素（或快速甩一下）就翻页，不到就弹回原位；移动不到 tap 像素算轻点。
const motion = { out: 180, in: 260, swipe: 70, tap: 8 };
const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

// 手机（触屏）上卡片底部多一个“横屏”按钮。iPhone 的网页不能让屏幕真的转过去（Safari 不支持锁定方向），
// 所以是把播放器转 90° 铺满屏幕，人把手机横过来看；手机自己已经转成横屏时不再转，按正常横屏排版。
const touch = matchMedia("(pointer: coarse)").matches;
const portrait = () => matchMedia("(orientation: portrait)").matches;

const enOf = (p: Page) => (p.example >= 0 ? p.word.ex[p.example].en : p.word.w);
const zhOf = (p: Page) => (p.example >= 0 ? p.word.ex[p.example].zh : plainZh(p.word.zh[0] ?? ""));
const tokensOf = (en: string) => en.match(/(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:st|nd|rd|th)?|[A-Za-z]+(?:['’-][A-Za-z]+)*/gi) ?? [];

// 中文读完到英文开始之间停多久；拼读时词和词之间停多久（毫秒）。
const zhGap = 250;
const spellGap = 180;

// 学习卡片的播放器，卡片撑满播放器的高度。手动模式像翻卡片：卡片跟着手指左右拖、方向键或按钮翻页，每进一页读一遍英文；
// 自动模式按“中文一遍 → 英文读几遍 → 停顿”一页页往下放（单词默认读两遍英文，例句三遍，第二遍拼读：一个词一个词地读），
// 屏幕保持常亮，切到后台、点例句里的词查词时暂停。
// 英文每遍之间的停顿默认和刚读完的英文一样长（乘以设置里的倍数），也可以在设置里改成固定秒数；翻到下一页前的停顿和它一样长。
// 翻页、自动播放、再读一遍、翻页时朗读的开关都是卡片底部的图标按钮；最后一页下面多一个“学完了”。
// 播放器挂着时是专注模式：导航收起，卡片铺满屏幕，左上角 × 退出。
export default function Player({ words, examples, settings, start = 0, onPos, onDone, doneLabel = "学完了", onExit }: Props) {
  useImmersive(true);
  const pages = pagesOf(words, examples);
  const [pos, setPos] = useState(Math.min(start, Math.max(0, pages.length - 1)));
  const [auto, setAuto] = useState(false);
  // 翻页时朗读的开关记在这台设备上，下次学习沿用；默认关，打开过才读。
  const [readOnEnter, setReadOnEnter] = useState(() => localStorage.getItem("vocab.readOnEnter") === "1");
  const [landscape, setLandscape] = useState(false);
  const run = useRef(0); // 每次翻页或停止都加 1，正在进行的朗读看到编号变了就停下
  const stage = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; t: number; dx: number; id: number; moved: boolean } | null>(null);
  // 转了 90° 时，卡片的左右是屏幕的上下：拖动按屏幕的纵坐标算（往下拖是卡片往右）。
  const along = (e: React.PointerEvent) => (landscape && portrait() ? e.clientY : e.clientX);
  const sliding = useRef(0); // 换页动画的定时器，动画进行中为非 0；这时候再翻页或拖动先不理
  const page = pages[pos];
  const last = pos === pages.length - 1;

  const go = (next: number) => {
    if (next < 0) return;
    if (next >= pages.length) {
      stop();
      onDone();
      return;
    }
    slide(next, next > pos ? 1 : -1);
  };

  // 换页动画直接改卡片的 style，不经过 React 渲染：拖动时每一帧都要动，渲染跟不上。
  function setStage(transform: string, opacity: string, ms = 0, ease = "") {
    const el = stage.current;
    if (!el) return;
    el.style.transition = ms ? `transform ${ms}ms ${ease}, opacity ${ms}ms ${ease}` : "none";
    el.style.transform = transform;
    el.style.opacity = opacity;
  }

  function slide(next: number, dir: number) {
    const commit = () => {
      flushSync(() => setPos(next));
      onPos?.(next);
    };
    if (sliding.current) return;
    const el = stage.current;
    if (!el || reduced()) {
      setStage("", "");
      return commit();
    }
    run.current++;
    stopSpeaking();
    const w = el.offsetWidth;
    // 往后翻：旧卡片往左滑出，新卡片从右边进来；往前翻反过来。
    setStage(`translateX(${-dir * w * 0.7}px)`, "0", motion.out, "cubic-bezier(0.4, 0, 1, 1)");
    sliding.current = window.setTimeout(() => {
      commit();
      setStage(`translateX(${dir * w * 0.35}px)`, "0");
      void el.offsetWidth; // 先让新位置生效，再开始滑进来
      setStage("", "", motion.in, "cubic-bezier(0.2, 0.8, 0.2, 1)");
      sliding.current = window.setTimeout(() => {
        sliding.current = 0;
        setStage("", "");
      }, motion.in);
    }, motion.out);
  }

  const stop = () => {
    run.current++;
    setAuto(false);
    stopSpeaking();
  };
  // 开始自动播放要在点击里调（iPhone 只允许在点击里打开 Web Audio），保持蓝牙音频通道的声音也在这里打开。
  const play = () => {
    keepAudioAwake(true);
    setAuto(true);
  };

  // 读完一遍英文后停多久（毫秒）：按刚才读了几秒乘倍数，或者固定秒数。至少停 0.3 秒，听得出句子的边界。
  const pauseAfter = (spoken: number) => 1000 * (settings.pauseBy === "fixed" ? settings.autoPause : Math.max(0.3, spoken * settings.pauseRatio));

  // 读当前页：需要时先读一遍中文，再读 repeat 遍英文；spell 为真时第二遍拼读。返回最后该停多久（和每遍之间的停顿一样）。
  async function read(id: number, repeat: number, withZh: boolean, spell = false) {
    const { accent, rate } = settings;
    const en = enOf(page);
    if (withZh) {
      await speak(zhOf(page), "zh-CN", 1);
      if (run.current !== id) return 0;
      await wait(zhGap);
    }
    let spoken = 0; // 最近一遍正常读的时长，停顿按它算
    for (let i = 0; i < repeat && run.current === id; i++) {
      if (i > 0) await wait(pauseAfter(spoken));
      if (run.current !== id) break;
      if (spell && i === 1) {
        for (const [k, w] of tokensOf(en).entries()) {
          if (run.current !== id) break;
          if (k > 0) await wait(spellGap);
          if (run.current === id) await speak(w, accent, rate);
        }
      } else spoken = await speak(en, accent, rate);
    }
    return pauseAfter(spoken);
  }

  // 进入新的一页：手动模式读一遍英文；自动模式读完、停顿后翻到下一页。
  // 只在真的换了页时才“进页读一遍”：点暂停（auto 变成 false）不算换页，不再重读这一句。
  const shownPos = useRef(-1);
  useEffect(() => {
    const id = ++run.current;
    const entered = shownPos.current !== pos;
    shownPos.current = pos;
    stopSpeaking();
    if (pages[pos + 1]) {
      prefetchSpeech(enOf(pages[pos + 1]), settings.accent);
      if (auto && settings.autoZh) prefetchSpeech(zhOf(pages[pos + 1]), "zh-CN");
    }
    if (auto) {
      const isEx = page.example >= 0;
      const spell = isEx && settings.spellOut;
      if (spell) for (const w of tokensOf(enOf(page))) prefetchSpeech(w, settings.accent);
      (async () => {
        const pause = await read(id, isEx ? settings.sentRepeat : settings.wordRepeat, settings.autoZh, spell);
        if (run.current !== id) return;
        // 翻页动画也算在停顿里，翻到下一页前停的和每遍之间一样长。
        await wait(Math.max(0, pause - (reduced() ? 0 : motion.out)));
        if (run.current === id) go(pos + 1);
      })();
    } else if (readOnEnter && entered) {
      wait(readDelay).then(() => {
        if (run.current === id) read(id, 1, false);
      });
    }
    return () => {
      run.current++;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pos, auto]);

  // 自动播放时保持屏幕常亮、保持蓝牙音频通道不断（见 speech.ts 的 keepAudioAwake）；切到后台（锁屏、切应用）就停下，回来再点播放。
  useEffect(() => {
    if (!auto) return;
    keepAudioAwake(true);
    let lock: WakeLockSentinel | undefined;
    navigator.wakeLock?.request("screen").then((l) => (lock = l)).catch(() => {});
    const onHide = () => document.hidden && stop();
    document.addEventListener("visibilitychange", onHide);
    return () => {
      keepAudioAwake(false);
      lock?.release().catch(() => {});
      document.removeEventListener("visibilitychange", onHide);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      if (e.key === "ArrowRight") go(pos + 1);
      else if (e.key === "ArrowLeft") go(pos - 1);
      else if (e.key === " ") {
        e.preventDefault();
        if (auto) stop();
        else play();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  useEffect(
    () => () => {
      clearTimeout(sliding.current);
      run.current++;
      stopSpeaking();
    },
    [],
  );

  // 拖动：卡片跟着手指走，越远越淡；松手时够远（或甩得快）就翻页，否则弹回。
  // 移动超过 tap 像素后才捕获指针，这样轻点例句里的词仍然是点在那个词上（查词）。
  const onPointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest("button") || drag.current || sliding.current) return;
    drag.current = { x: along(e), t: e.timeStamp, dx: 0, id: e.pointerId, moved: false };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    d.dx = along(e) - d.x;
    if (!d.moved && Math.abs(d.dx) > motion.tap) {
      d.moved = true;
      stage.current?.setPointerCapture(e.pointerId);
    }
    if (!d.moved) return;
    // 第一页往右拖有阻力，提示到头了（最后一页往左拖是学完）。
    const dx = pos === 0 && d.dx > 0 ? d.dx / 3 : d.dx;
    const w = stage.current?.offsetWidth || 1;
    setStage(`translateX(${dx}px)`, String(1 - Math.min(0.5, Math.abs(dx) / w)));
  };
  const onPointerEnd = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    if (!d.moved) {
      // 轻点卡片不朗读（再读一遍用底部按钮）；点在例句的词上是查词，自动播放中就先暂停。
      if (e.type === "pointerup" && auto && (e.target as HTMLElement).closest("[data-w]")) stop();
      return;
    }
    const fast = Math.abs(d.dx) / Math.max(1, e.timeStamp - d.t) > 0.5 && Math.abs(d.dx) > 30;
    const next = d.dx < 0 ? pos + 1 : pos - 1;
    if (e.type === "pointerup" && (Math.abs(d.dx) > motion.swipe || fast) && next >= 0) {
      if (auto) stop();
      go(next);
    } else {
      setStage("", "", 220, "cubic-bezier(0.2, 0.8, 0.2, 1)");
    }
  };

  if (!page) return <p className="muted">没有要学的词。</p>;
  const wordIndex = words.indexOf(page.word) + 1;
  const toggleRead = () => {
    setReadOnEnter(!readOnEnter);
    localStorage.setItem("vocab.readOnEnter", readOnEnter ? "0" : "1");
  };

  const controls = (
    <div className={styles.controls}>
      <button type="button" className={styles.icon} onClick={() => go(pos - 1)} disabled={pos === 0} aria-label="上一页" title="上一页">
        <Icon name="prev" />
      </button>
      {auto ? (
        <button type="button" className={`${styles.icon} ${styles.main}`} onClick={stop} aria-label="暂停" title="暂停">
          <Icon name="pause" />
        </button>
      ) : (
        <button type="button" className={`${styles.icon} ${styles.main}`} onClick={play} disabled={!canSpeak} aria-label="自动播放" title="自动播放">
          <Icon name="play" />
        </button>
      )}
      {!auto && (
        <button type="button" className={styles.icon} onClick={() => read(++run.current, 1, true)} disabled={!canSpeak} aria-label="播放当前卡片" title="播放当前卡片">
          <Icon name="sound" />
        </button>
      )}
      <button
        type="button"
        className={`${styles.icon} ${readOnEnter ? styles.active : ""}`}
        onClick={toggleRead}
        aria-pressed={readOnEnter}
        aria-label="翻页时朗读"
        title={readOnEnter ? "翻页时朗读：开" : "翻页时朗读：关"}
      >
        <Icon name={readOnEnter ? "sound" : "mute"} />
      </button>
      <button type="button" className={styles.icon} onClick={() => go(pos + 1)} aria-label="下一页" title="下一页">
        <Icon name="next" />
      </button>
      {touch && (
        <button
          type="button"
          className={`${styles.icon} ${landscape ? styles.active : ""}`}
          onClick={() => setLandscape(!landscape)}
          aria-pressed={landscape}
          aria-label={landscape ? "退出横屏" : "横屏"}
          title={landscape ? "退出横屏" : "横屏"}
        >
          <Icon name="landscape" />
        </button>
      )}
    </div>
  );
  const footer = (
    <div className={styles.footer}>
      {controls}
      {last && !auto && (
        <button type="button" className={styles.done} onClick={() => go(pos + 1)}>
          {doneLabel}
        </button>
      )}
    </div>
  );

  return (
    <div className={`${styles.player} ${landscape ? styles.landscape : ""}`}>
      <div ref={stage} className={styles.stage} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerEnd} onPointerCancel={onPointerEnd}>
        <WordCard
          word={page.word}
          example={page.example}
          accent={settings.accent}
          sentencePh={settings.sentencePh}
          progress={`${wordIndex} / ${words.length}`}
          percent={((pos + 1) / pages.length) * 100}
          footer={footer}
          corner={
            <ExitButton
              label="退出学习"
              onExit={() => {
                stop();
                onExit();
              }}
            />
          }
        />
      </div>
      {!canSpeak && <p className="muted">当前浏览器不支持朗读，只能手动翻看。</p>}
    </div>
  );
}
