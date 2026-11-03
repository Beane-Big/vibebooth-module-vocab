// 朗读用浏览器自带的 speechSynthesis（和笔顺模块一样），离线可用，不调外部服务。
// 声音由系统提供：iPhone、iPad 和 Mac 的英文声音质量较好，Windows 取决于系统装了哪些语音包。
export const canSpeak = typeof window !== "undefined" && "speechSynthesis" in window;

let voices: SpeechSynthesisVoice[] = [];
function loadVoices() {
  voices = speechSynthesis.getVoices();
}
if (canSpeak) {
  loadVoices();
  speechSynthesis.addEventListener?.("voiceschanged", loadVoices);
}

function pickVoice(lang: string) {
  const exact = voices.filter((v) => v.lang.replace("_", "-") === lang);
  // 同语言里优先用系统的本地声音，断网也能读。
  return exact.find((v) => v.localService) ?? exact[0] ?? voices.find((v) => v.lang.startsWith(lang.slice(0, 2)));
}

// speak 读一段文字，读完（或出错、或被 stop 打断）时返回。有的浏览器不触发 onend，按字数估一个超时兜底。
export function speak(text: string, lang: string, rate = 1): Promise<void> {
  if (!canSpeak || !text) return Promise.resolve();
  return new Promise((resolve) => {
    const u = new SpeechSynthesisUtterance(text);
    const timer = setTimeout(resolve, (1500 + 160 * text.length) / rate);
    u.lang = lang;
    u.rate = rate;
    const voice = pickVoice(lang);
    if (voice) u.voice = voice;
    u.onend = u.onerror = () => {
      clearTimeout(timer);
      resolve();
    };
    speechSynthesis.speak(u);
  });
}

export function stopSpeaking() {
  if (canSpeak) speechSynthesis.cancel();
}

export const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// 中文释义朗读时去掉词性缩写（“v. 包括、组成” → “包括、组成”）。
export const plainZh = (zh: string) => zh.replace(/^[a-z]+\.\s*/, "");
