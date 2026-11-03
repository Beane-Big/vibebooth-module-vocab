import { useEffect, useRef, useState } from "react";
import type { Settings, Word } from "../api";
import { canSpeak, plainZh, speak, stopSpeaking, wait } from "../speech";
import Icon from "./Icon";
import WordCard, { pagesOf } from "./WordCard";
import styles from "./Player.module.css";

type Props = {
  words: Word[];
  examples: number;
  settings: Settings;
  start?: number;
  onPos?: (pos: number) => void; // 翻页时调用，用来记住学到第几页
  onDone: () => void; // 翻过最后一页（或自动播放完）
  doneLabel?: string;
};

// 翻页后等一会儿再读，卡片换完、眼睛先看到字再听到声音；连续快速翻页时只读最后停下的那一页。
const readDelay = 500;

// 学习卡片的播放器。手动模式像翻卡片：左右滑动、方向键或按钮翻页，每进一页读一遍英文；
// 自动模式按“英文（读几遍）→ 中文 → 停顿”一页页往下放，屏幕保持常亮，切到后台就暂停。
// 翻页、自动播放、再读一遍、翻页时朗读的开关都是卡片底部的图标按钮。
export default function Player({ words, examples, settings, start = 0, onPos, onDone, doneLabel = "学完了" }: Props) {
  const pages = pagesOf(words, examples);
  const [pos, setPos] = useState(Math.min(start, Math.max(0, pages.length - 1)));
  const [auto, setAuto] = useState(false);
  const [readOnEnter, setReadOnEnter] = useState(() => localStorage.getItem("vocab.readOnEnter") !== "0");
  const run = useRef(0); // 每次翻页或停止都加 1，正在进行的朗读看到编号变了就停下
  const touch = useRef<number | null>(null);
  const page = pages[pos];
  const last = pos === pages.length - 1;

  const go = (next: number) => {
    if (next < 0) return;
    if (next >= pages.length) {
      stop();
      onDone();
      return;
    }
    setPos(next);
    onPos?.(next);
  };

  const stop = () => {
    run.current++;
    setAuto(false);
    stopSpeaking();
  };

  // 读当前页：英文读 repeat 遍，需要时再读中文。
  async function read(id: number, repeat: number, withZh: boolean) {
    const { accent, rate, autoPause } = settings;
    const en = page.example >= 0 ? page.word.ex[page.example].en : page.word.w;
    const zh = page.example >= 0 ? page.word.ex[page.example].zh : plainZh(page.word.zh[0] ?? "");
    for (let i = 0; i < repeat && run.current === id; i++) {
      if (i > 0) await wait(autoPause * 1000);
      if (run.current === id) await speak(en, accent, rate);
    }
    if (withZh && run.current === id) {
      await wait(400);
      if (run.current === id) await speak(zh, "zh-CN", 1);
    }
  }

  // 进入新的一页：手动模式读一遍；自动模式读完、停顿后翻到下一页。
  useEffect(() => {
    const id = ++run.current;
    stopSpeaking();
    if (auto) {
      (async () => {
        await read(id, settings.autoRepeat, settings.autoZh);
        if (run.current !== id) return;
        await wait(settings.autoPause * 1000);
        if (run.current === id) go(pos + 1);
      })();
    } else if (readOnEnter) {
      wait(readDelay).then(() => {
        if (run.current === id) read(id, 1, false);
      });
    }
    return () => {
      run.current++;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pos, auto]);

  // 自动播放时保持屏幕常亮；切到后台（锁屏、切应用）就停下，回来再点播放。
  useEffect(() => {
    if (!auto) return;
    let lock: WakeLockSentinel | undefined;
    navigator.wakeLock?.request("screen").then((l) => (lock = l)).catch(() => {});
    const onHide = () => document.hidden && stop();
    document.addEventListener("visibilitychange", onHide);
    return () => {
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
        else setAuto(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  useEffect(() => () => stopSpeaking(), []);

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
        <button type="button" className={`${styles.icon} ${styles.main}`} onClick={() => setAuto(true)} disabled={!canSpeak} aria-label="自动播放" title="自动播放">
          <Icon name="play" />
        </button>
      )}
      <button type="button" className={styles.icon} onClick={() => read(++run.current, 1, true)} disabled={!canSpeak || auto} aria-label="再读一遍" title="再读一遍">
        <Icon name="replay" />
      </button>
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
    </div>
  );

  return (
    <div className={styles.player}>
      <div
        className={styles.stage}
        onPointerDown={(e) => (touch.current = (e.target as HTMLElement).closest("button") ? null : e.clientX)}
        onPointerUp={(e) => {
          if (touch.current === null) return;
          const dx = e.clientX - touch.current;
          touch.current = null;
          if (Math.abs(dx) < 40) {
            // 轻点卡片再读一遍；点在例句的词上时是查词，不读整句。
            if (!auto && !(e.target as HTMLElement).closest("[data-w]")) read(++run.current, 1, false);
            return;
          }
          if (auto) stop();
          go(dx < 0 ? pos + 1 : pos - 1);
        }}
      >
        <WordCard
          word={page.word}
          example={page.example}
          accent={settings.accent}
          sentencePh={settings.sentencePh}
          progress={`${wordIndex} / ${words.length}`}
          percent={((pos + 1) / pages.length) * 100}
          footer={controls}
        />
      </div>
      {last && !auto && (
        <div className="actions">
          <button className={styles.done} onClick={() => go(pos + 1)}>
            {doneLabel}
          </button>
        </div>
      )}
      {!canSpeak && <p className="muted">当前浏览器不支持朗读，只能手动翻看。</p>}
    </div>
  );
}
