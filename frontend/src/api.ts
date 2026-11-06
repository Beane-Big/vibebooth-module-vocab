// us、uk 是美音、英音音标，按口音设置显示其中一个（phOf）。
export type Phonetic = { us: string; uk: string };
export type Example = Phonetic & { en: string; zh: string; src: string };
// n 是序号（按字母顺序），f 是词频名次（1 最常用）。
export type Word = Phonetic & { n: number; f: number; w: string; zh: string[]; forms: string[]; ex: Example[] };
// 选择题的干扰项（后端挑好的）：meaning 是同词性、词频相近、意思不重叠的词，prefix 是开头字母相同的词（看中文选英文用），spelling 是拼写相近、读音不同的词。
export type Option = { w: string; zh: string };
export type Choices = { meaning: Option[]; prefix: Option[]; spelling: Option[] };
export type Order = "alpha" | "frq" | "random";

export type Settings = {
  planWords: number;
  startN: number; // 下一个计划从学习顺序的第几个词开始，0 表示从第一个没学过的词开始；建计划时用掉就回到 0
  order: Order; // 学习顺序：按字母、按词频、随机打乱（每个人固定的一种顺序）
  examples: number;
  sentencePh: boolean;
  accent: "en-US" | "en-GB";
  rate: number;
  wordRepeat: number; // 自动播放时单词的英文读几遍（中文先读一遍）
  sentRepeat: number; // 自动播放时例句的英文读几遍
  spellOut: boolean; // 例句第二遍拼读：一个词一个词地读
  pauseBy: "audio" | "fixed"; // 自动播放每句后的停顿：按这句的朗读时长，或固定秒数
  pauseRatio: number; // 按朗读时长时是几倍
  autoPause: number; // 固定秒数
  autoZh: boolean;
  reviewMode: "listen" | "look" | "mix";
  reviewBy: "choice" | "rate"; // 复习怎么作答：四选一，或看答案后四档自评
  wrongClear: number;
};

export type Plan = {
  id: number;
  firstN: number;
  words: string[];
  examples: number;
  pos: number;
  createdAt: string;
  learnedAt: string | null;
  finishedAt: string | null;
  correct: number;
  total: number;
  studySecs: number; // 学习时长（秒）
};

export type Test = {
  id: number;
  scope: TestScope;
  planId: number; // scope 为 plan（计划错题检查）时是哪个计划
  mode: string; // 题型，几种时用逗号隔开（look,write），见 modesOf
  words: string[];
  createdAt: string;
  finishedAt: string | null;
  correct: number;
  total: number;
};

export type Stats = { learned: number; due: number; wrong: number; streak: number; today: number };
export type Home = { settings: Settings; deck: { name: string; total: number }; nextN: number; nextWord: string; plan: Plan | null; lastPlan: { id: number; missed: number } | null; stats: Stats };

// 题型：看词选择、听音选择（四选一）、看中文写英文（例句挖空填词）、听写、整句翻译。speak（看中文说英文）是老版本的题型，只出现在老记录里。
export type Mode = "look" | "listen" | "write" | "dictation" | "translate" | "speak";
// plan 是一个学习计划答错过的词（错题检查，从已学习进），不在检测页的范围里选。
export type TestScope = "recent" | "range" | "all" | "wrong" | "plan";
export type Kind = "plan" | "review" | "test";
export type AnswerIn = { word: string; kind: Kind; refId: number; mode: Mode; ok: boolean; rating: number; answer: string };

// 计划或检测连同词条一起返回；missed 是答错的词。
export type WithWords<T> = { item: T; words: Word[]; missed: Word[] };

// 例句里点词时查到的词条；lemma 是变形词的原形，n 是在词库里的序号（不在词库里为 0）。
export type Entry = Phonetic & { w: string; zh: string[]; lemma?: Entry; n: number };

export type Wrong = {
  word: string;
  count: number;
  streak: number;
  lastAt: string;
  lastMode: Mode;
  lastAnswer: string;
  clearedAt: string | null;
  data: Word;
};

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

// 调用本模块后端的对内接口；登录 Cookie 由浏览器自动带上，网关负责校验。
export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (res.status === 401) {
    location.href = "/login?next=" + encodeURIComponent(location.pathname);
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body.error ?? "请求失败");
  }
  return res.status === 204 ? (undefined as T) : res.json();
}

// “今天”按浏览器所在时区算：复习到期、连续天数都用它。
const tz = `tz=${new Date().getTimezoneOffset()}`;
const base = "/api/vocab";

// 朗读音频的网址（GET 返回 MP3，见 speech.ts）。
export const ttsUrl = (text: string, voice: string) => `${base}/tts?voice=${voice}&text=${encodeURIComponent(text)}`;
const post = (body: unknown) => ({ method: "POST", body: JSON.stringify(body) });

export const api = {
  home: () => request<Home>(`${base}/home?${tz}`),
  // 还原：设置回到默认值（返回默认设置），或清空全部学习进度。
  resetSettings: () => request<Settings>(`${base}/reset/settings`, { method: "POST" }),
  resetProgress: () => request<void>(`${base}/reset/progress`, { method: "POST" }),
  saveSettings: (s: Settings) => request<Settings>(`${base}/settings`, { method: "PUT", body: JSON.stringify(s) }),
  lookup: (w: string) => request<Entry>(`${base}/lookup?w=${encodeURIComponent(w)}`),
  words: (from: number, count: number) => request<Word[]>(`${base}/words?from=${from}&count=${count}`),
  choices: (words: string[]) => request<Record<string, Choices>>(`${base}/choices`, post({ words })),

  // 不传的项按个人设置（学几个词、几条例句、从第几个开始）。
  createPlan: (p: { from?: number; count?: number; examples?: number } = {}) => request<WithWords<Plan>>(`${base}/plans`, post(p)),
  plan: (id: number) => request<WithWords<Plan>>(`${base}/plans/${id}`),
  plans: () => request<Plan[]>(`${base}/plans`),
  savePlanPos: (id: number, pos: number, learned = false) => request<void>(`${base}/plans/${id}`, { method: "PUT", body: JSON.stringify({ pos, learned }) }),
  // 记学习时长；keepalive 让离开页面时发的这一次也能发完。
  studyTime: (id: number, secs: number) => request<void>(`${base}/plans/${id}/time`, { method: "POST", body: JSON.stringify({ secs }), keepalive: true }),
  finishPlan: (id: number) => request<WithWords<Plan>>(`${base}/plans/${id}/finish`, { method: "POST" }),

  answer: (a: AnswerIn) => request<void>(`${base}/answers?${tz}`, post(a)),
  review: () => request<{ total: number; words: Word[] }>(`${base}/review?${tz}`),

  wrongs: (cleared: boolean) => request<Wrong[]>(`${base}/wrongs?cleared=${cleared ? 1 : 0}`),
  clearWrong: (word: string) => request<void>(`${base}/wrongs/${encodeURIComponent(word)}`, { method: "DELETE" }),

  createTest: (t: { scope: TestScope; from?: number; to?: number; plan?: number; count: number; mode: string }) => request<WithWords<Test>>(`${base}/tests`, post(t)),
  test: (id: number) => request<WithWords<Test>>(`${base}/tests/${id}`),
  tests: () => request<Test[]>(`${base}/tests`),
  finishTest: (id: number) => request<WithWords<Test>>(`${base}/tests/${id}/finish`, { method: "POST" }),
};

export const modeNames: Record<Mode, string> = {
  look: "看词选择",
  listen: "听音选择",
  write: "看中文写英文",
  dictation: "听写",
  translate: "整句翻译",
  speak: "看中文说英文",
};
// 能选的题型（speak 已经不出了）。
export const modes: Mode[] = ["look", "listen", "write", "dictation", "translate"];
// 检测记录里的题型（一种或几种，逗号隔开）。
export const modesOf = (s: string) => s.split(",") as Mode[];
export const modesText = (s: string) => modesOf(s).map((m) => modeNames[m]).join("、");
export const orderNames: Record<Order, string> = { alpha: "按字母顺序", frq: "按词频（常用的先学）", random: "随机打乱" };
export const scopeNames: Record<TestScope, string> = { recent: "最近 7 天学的", range: "按序号范围", all: "全部学过的", wrong: "错题本", plan: "计划错题" };

// 学习时长：不到一分钟、几分钟、几小时几分钟。
export function durationText(secs: number) {
  const m = Math.floor(secs / 60);
  if (m < 1) return "不到 1 分钟";
  if (m < 60) return `${m} 分钟`;
  return `${Math.floor(m / 60)} 小时${m % 60 ? ` ${m % 60} 分钟` : ""}`;
}

// 计划学的是哪些词：第一个到最后一个（学习顺序可能是随机的，所以不用序号）。
export const planSpan = (p: Plan) => (p.words.length > 1 ? `${p.words[0]} – ${p.words[p.words.length - 1]}` : (p.words[0] ?? ""));

// 按口音取音标：英音显示 Britfone 的读音，美音显示 CMUdict 的读音。
export const phOf = (x: Phonetic, accent: string) => (accent === "en-GB" ? x.uk : x.us);

export function errorText(err: unknown) {
  return err instanceof Error ? err.message : "操作失败";
}
