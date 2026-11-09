import { ttsUrl } from "./api";

// 朗读：用模块自带的语音（英文 Kokoro，中文 Piper；后端合成 MP3 并存起来，全家共用）。
// 语音容器不可用时（独立模式没有语音容器，或者语音容器出错）退回浏览器自带的 speechSynthesis。
// 语速在播放时调（playbackRate，浏览器默认保持音调不变），同一句只存一份音频。
export const canSpeak = typeof window !== "undefined" && ("speechSynthesis" in window || "Audio" in window);
const canBrowserSpeak = typeof window !== "undefined" && "speechSynthesis" in window;

// 语言（口音）对应的模块声音，要和 tts/voices.py 一致。
const ttsVoice: Record<string, string> = { "en-US": "af_heart", "en-GB": "bf_emma", "zh-CN": "zh_chaowen" };

// 语音容器不可用（503、断网）后这段时间内直接用浏览器朗读，不再每句都等它报错。
let ttsDownUntil = 0;

// 整个页面共用一个 audio 元素：iPhone 上只有在点击里播放过的元素，之后才能在自动播放里继续出声。
const audio = typeof Audio !== "undefined" ? new Audio() : null;
const silentMp3 =
  "data:audio/mpeg;base64,//OExAAAAAAAAAAAAFhpbmcAAAAPAAAABQAAATgAMzMzMzMzMzMzMzMzMzMzMzMzM2ZmZmZmZmZmZmZmZmZmZmZmZmZmmZmZmZmZmZmZmZmZmZmZmZmZmZnMzMzMzMzMzMzMzMzMzMzMzMzMzP//////////////////////////AAAAPExBTUUzLjEwMAR4AAAAAAAAAAAVCCQEUCEAAcwAAAE4P2jxnwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//MUxAAAAANIAAAAAExBTUUzLjEwMFVV//MUxAsAAANIAAAAAFVVVVVVVVVVVVVV//MUxBYAAANIAAAAAFVVVVVVVVVVVVVV//MUxCEAAANIAAAAAFVVVVVVVVVVVVVV//MUxCwAAANIAAAAAFVVVVVVVVVVVVVV";
// 解锁要在用户手势里调 play()。iPhone 上触摸时 pointerdown 不一定算手势，所以 click、touchend 也听；
// 某一次没解锁成功（play 被拒）就等下一次手势再试，成功后才移除监听。正在读的时候不动它（那次播放本身就解锁了）。
if (audio) {
  const events = ["pointerdown", "touchend", "click", "keydown"] as const;
  let unlocked = false;
  const unlock = () => {
    if (unlocked) return;
    if (current || !audio.paused) return;
    audio.src = silentMp3;
    audio
      .play()
      .then(() => {
        unlocked = true;
        for (const e of events) window.removeEventListener(e, unlock, true);
      })
      .catch(() => {});
  };
  for (const e of events) window.addEventListener(e, unlock, true);
}

let voices: SpeechSynthesisVoice[] = [];
function loadVoices() {
  voices = speechSynthesis.getVoices();
}
if (canBrowserSpeak) {
  loadVoices();
  speechSynthesis.addEventListener?.("voiceschanged", loadVoices);
}

function pickVoice(lang: string) {
  const exact = voices.filter((v) => v.lang.replace("_", "-") === lang);
  // 同语言里优先用系统的本地声音，断网也能读。
  return exact.find((v) => v.localService) ?? exact[0] ?? voices.find((v) => v.lang.startsWith(lang.slice(0, 2)));
}

// 正在读的这一句；stopSpeaking 调它提前结束。
let current: (() => void) | null = null;

// speak 读一段文字，读完（或出错、或被 stop 打断）时返回，结果是从开始出声到读完用了几秒（自动播放按它定停顿）。
// 最近一次开始朗读的时刻（performance.now），学习计时用它判断人还在不在（自动播放时不用碰屏幕）。
export let lastSpokenAt = 0;

export function speak(text: string, lang: string, rate = 1): Promise<number> {
  if (!text) return Promise.resolve(0);
  lastSpokenAt = performance.now();
  current?.();
  const voice = ttsVoice[lang];
  const spoken = voice && audio && Date.now() >= ttsDownUntil ? speakTts(text, voice, lang, rate) : speakBrowser(text, lang, rate);
  return spoken.then((start) => (start ? (performance.now() - start) / 1000 : 0));
}

// 下面两个函数在读完时返回开始出声的时刻（performance.now），没出声时返回 0。

function speakTts(text: string, voice: string, lang: string, rate: number): Promise<number> {
  return new Promise((resolve) => {
    const ctrl = new AbortController();
    let url = "";
    let done = false;
    let start = 0;
    const finish = () => {
      if (done) return;
      done = true;
      ctrl.abort();
      audio!.onended = audio!.onerror = null;
      audio!.pause();
      if (url) URL.revokeObjectURL(url);
      if (current === finish) current = null;
      resolve(start);
    };
    current = finish;
    // 合成失败就用浏览器把这一句读完，不让自动播放卡住。
    const fallback = () => {
      if (done) return;
      done = true;
      audio!.onended = audio!.onerror = null;
      if (url) URL.revokeObjectURL(url);
      if (current === finish) current = null;
      speakBrowser(text, lang, rate).then(resolve);
    };
    // 先用 fetch 取音频，能看出是语音容器不可用（503）还是只有这一句不行（502 等）；音频本身走浏览器缓存。
    fetch(ttsUrl(text, voice), { signal: ctrl.signal })
      .then(async (res) => {
        if (!res.ok) {
          if (res.status === 503) ttsDownUntil = Date.now() + 60_000;
          return fallback();
        }
        const blob = await res.blob();
        if (done) return;
        url = URL.createObjectURL(blob);
        audio!.src = url;
        audio!.playbackRate = rate;
        audio!.onended = finish;
        audio!.onerror = fallback;
        start = performance.now();
        await audio!.play();
      })
      .catch((err) => {
        if (done) return;
        // 浏览器不让自动出声（还没点过页面）时就当这句读完了；断网等其他错误退回浏览器朗读。
        if (err?.name === "NotAllowedError") finish();
        else {
          ttsDownUntil = Date.now() + 60_000;
          fallback();
        }
      });
  });
}

// 有的浏览器不触发 onend，按字数估一个超时兜底。
function speakBrowser(text: string, lang: string, rate: number): Promise<number> {
  if (!canBrowserSpeak) return Promise.resolve(0);
  return new Promise((resolve) => {
    const u = new SpeechSynthesisUtterance(text);
    const start = performance.now();
    const timer = setTimeout(() => resolve(start), (1500 + 160 * text.length) / rate);
    u.lang = lang;
    u.rate = rate;
    const voice = pickVoice(lang);
    if (voice) u.voice = voice;
    u.onend = u.onerror = () => {
      clearTimeout(timer);
      resolve(start);
    };
    speechSynthesis.speak(u);
  });
}

// prefetch 提前让后端合成接下来要读的句子，读到时不用等；结果留在浏览器缓存里。
export function prefetchSpeech(text: string, lang: string) {
  const voice = ttsVoice[lang];
  if (text && voice && Date.now() >= ttsDownUntil) fetch(ttsUrl(text, voice)).catch(() => {});
}

// 车载蓝牙、蓝牙音箱在一段时间没有声音后会关掉音频通道，下一句开始时重新接上，开头有一段淡入，前几个字听不清；
// 拼读时一个词一个词地放，每个词都会这样。自动播放期间用 Web Audio 一直放一段极轻的噪声（约 -80 dB，听不到），
// 通道就一直开着。用噪声不用纯静音：有的设备检测到全零的数据也会当成没声音。朗读本身还是走 audio 元素，不受影响。
type AudioCtx = typeof AudioContext;
let awakeCtx: AudioContext | null = null;
let awakeNode: AudioBufferSourceNode | null = null;
export function keepAudioAwake(on: boolean) {
  const AC: AudioCtx | undefined = typeof window !== "undefined" ? (window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioCtx }).webkitAudioContext) : undefined;
  if (!AC) return;
  try {
    if (!on) {
      awakeNode?.stop();
      awakeNode?.disconnect();
      awakeNode = null;
      awakeCtx?.suspend().catch(() => {});
      return;
    }
    awakeCtx ??= new AC();
    awakeCtx.resume().catch(() => {});
    if (awakeNode) return;
    const ctx = awakeCtx;
    const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * 1e-4;
    awakeNode = ctx.createBufferSource();
    awakeNode.buffer = buf;
    awakeNode.loop = true;
    awakeNode.connect(ctx.destination);
    awakeNode.start();
  } catch {
    // 不支持 Web Audio 时照常朗读，只是没有这层保护。
  }
}

export function stopSpeaking() {
  current?.();
  if (canBrowserSpeak) speechSynthesis.cancel();
}

export const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// 中文释义朗读时去掉词性缩写（“v. 包括、组成” → “包括、组成”）。
export const plainZh = (zh: string) => zh.replace(/^[a-z]+\.\s*/, "");
