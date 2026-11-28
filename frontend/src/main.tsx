import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

// 兼容旧版 iOS Safari（不支持 100dvh）及外层门户按 100vh 撑高 iframe 导致底部被 Safari 地址栏遮挡的场景。
function installViewportSync() {
  const root = document.documentElement;
  const supportsDvh = typeof CSS !== "undefined" && typeof CSS.supports === "function" && CSS.supports("height", "100dvh");
  const sync = () => {
    let clip = 0;
    if (window.top && window.top !== window.self) {
      try {
        const frame = window.frameElement;
        if (frame) {
          const rect = frame.getBoundingClientRect();
          const topH = window.top.innerHeight;
          if (topH > 0 && rect.bottom > topH + 1) clip = Math.ceil(rect.bottom - topH);
        }
      } catch {
        // 跨域嵌套时忽略
      }
    }
    if (clip > 0) {
      root.style.setProperty("--vb-vh", `${Math.max(240, Math.floor(window.innerHeight - clip))}px`);
      root.style.setProperty("--vb-bottom-clip", `${clip}px`);
    } else {
      root.style.removeProperty("--vb-bottom-clip");
      if (!supportsDvh && window.innerHeight > 0) root.style.setProperty("--vb-vh", `${window.innerHeight}px`);
      else root.style.removeProperty("--vb-vh");
    }
  };
  sync();
  window.addEventListener("resize", sync);
  window.addEventListener("orientationchange", sync);
  window.addEventListener("pageshow", sync);
  if (window.top && window.top !== window.self) {
    try {
      window.top.addEventListener("resize", sync);
      window.top.addEventListener("orientationchange", sync);
    } catch {
      // 跨域嵌套时忽略
    }
  }
}

installViewportSync();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
