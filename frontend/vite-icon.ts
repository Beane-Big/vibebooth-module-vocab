import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";
import type { Plugin, ResolvedConfig } from "vite";

// 模块图标只有一份：模块根目录的 icon.svg（module.yaml 里的 icon，平台主页显示它）。
// 这个插件在构建时把它复制成页面的 icon.svg（浏览器页签），再画成 180px 的 apple-touch-icon.png
// （iOS 添加到主屏幕只认 PNG），并在 index.html 里写上这两个图标；npm run dev 时也按同样的网址提供。
const source = fileURLToPath(new URL("../icon.svg", import.meta.url));

function read() {
  const svg = readFileSync(source, "utf8");
  // 文字的样子取决于电脑上装了什么字体，平台、浏览器和 iOS 上会不一样，所以要求先转成路径。
  if (/<text[\s>]/.test(svg)) throw new Error("icon.svg 里有 <text>，请先把文字转成路径");
  return svg;
}

// iOS 会自己切圆角（主屏幕、锁屏和控制中心的“正在播放”都是），透明的地方会变成黑色。
// 所以 PNG 要铺满整个方块：把铺满画布的那块底色的圆角去掉，再铺一层白底兜底。
// 不去圆角的话，iOS 切的圆角比图标自己的小，四个角会露出白边。
function touchIcon(svg: string) {
  return new Resvg(squareBackground(svg), { fitTo: { mode: "width", value: 180 }, background: "#ffffff" }).render().asPng();
}

// 找出和 viewBox 一样大、从左上角画起的 <rect>（图标的底色），去掉它的 rx、ry。
function squareBackground(svg: string) {
  const box = svg.match(/viewBox="\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*"/);
  if (!box) return svg;
  const [, w, h] = box;
  return svg.replace(/<rect\b[^>]*>/g, (tag) => {
    const attr = (name: string) => tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];
    const full = attr("width") === w && attr("height") === h && Number(attr("x") ?? 0) === 0 && Number(attr("y") ?? 0) === 0;
    return full ? tag.replace(/\s(rx|ry)="[^"]*"/g, "") : tag;
  });
}

export default function moduleIcon(): Plugin {
  let config: ResolvedConfig;
  return {
    name: "vibebooth-module-icon",
    configResolved(resolved) {
      config = resolved;
    },
    configureServer(server) {
      server.watcher.add(source);
      server.middlewares.use((req, res, next) => {
        const path = req.url?.split("?")[0];
        if (path === config.base + "icon.svg") {
          res.setHeader("Content-Type", "image/svg+xml");
          res.end(read());
        } else if (path === config.base + "apple-touch-icon.png") {
          res.setHeader("Content-Type", "image/png");
          res.end(touchIcon(read()));
        } else {
          next();
        }
      });
    },
    buildStart() {
      this.addWatchFile(source);
    },
    generateBundle() {
      const svg = read();
      this.emitFile({ type: "asset", fileName: "icon.svg", source: svg });
      this.emitFile({ type: "asset", fileName: "apple-touch-icon.png", source: touchIcon(svg) });
    },
    transformIndexHtml() {
      return [
        { tag: "link", attrs: { rel: "icon", type: "image/svg+xml", href: config.base + "icon.svg" }, injectTo: "head" },
        { tag: "link", attrs: { rel: "apple-touch-icon", href: config.base + "apple-touch-icon.png" }, injectTo: "head" },
      ];
    },
  };
}
