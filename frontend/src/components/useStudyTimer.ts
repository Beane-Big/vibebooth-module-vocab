import { useEffect } from "react";
import { api } from "../api";
import { lastSpokenAt } from "../speech";

// 一直没碰屏幕、也没在朗读这么久，就当人走开了，不再计时（毫秒）。
const idleAfter = 3 * 60_000;
// 攒够这么多秒报一次；暂停时（退出、切到后台、关掉页面）也把攒下的报上去。
const flushEvery = 30;

// 记学习时长：active 为真、页面在前台、人还在（三分钟内碰过屏幕或在朗读）的每一秒都算，
// 退出学习、锁屏、切到别的应用时就停下，回来接着算。时间记在这个学习计划上（再学一遍、错题学习也算）。
export function useStudyTimer(planId: number | undefined, active: boolean) {
  useEffect(() => {
    if (!planId || !active) return;
    let secs = 0;
    let lastInput = performance.now();
    const flush = () => {
      if (secs > 0) api.studyTime(planId, secs).catch(() => {});
      secs = 0;
    };
    const onInput = () => (lastInput = performance.now());
    const tick = window.setInterval(() => {
      if (document.hidden) return;
      if (performance.now() - Math.max(lastInput, lastSpokenAt) > idleAfter) return;
      if (++secs >= flushEvery) flush();
    }, 1000);
    const onHide = () => document.hidden && flush();
    window.addEventListener("pointerdown", onInput, true);
    window.addEventListener("keydown", onInput, true);
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", flush);
    return () => {
      clearInterval(tick);
      window.removeEventListener("pointerdown", onInput, true);
      window.removeEventListener("keydown", onInput, true);
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [planId, active]);
}
