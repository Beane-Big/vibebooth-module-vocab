// us、uk 是美音、英音音标，按口音设置显示其中一个（phOf）。
export type Phonetic = { us: string; uk: string };
export type Example = Phonetic & { en: string; zh: string; src: string };
export type Word = Phonetic & { n: number; w: string; zh: string[]; forms: string[]; ex: Example[] };

export type Settings = {
  planWords: number;
  examples: number;
  sentencePh: boolean;
  accent: "en-US" | "en-GB";
  rate: number;
  autoRepeat: number;
  autoPause: number;
  autoZh: boolean;
  reviewMode: "listen" | "look" | "mix";
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
};

export type Test = {
  id: number;
  scope: TestScope;
  mode: Mode;
  words: string[];
  createdAt: string;
  finishedAt: string | null;
  correct: number;
  total: number;
};

export type Stats = { learned: number; due: number; wrong: number; streak: number; today: number };
export type Home = { settings: Settings; deck: { name: string; total: number }; nextN: number; plan: Plan | null; stats: Stats };

// 题型：听音想意思、看词想意思、看中文说英文、听写。
export type Mode = "listen" | "look" | "speak" | "dictation";
export type TestScope = "recent" | "range" | "all" | "wrong";
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
  saveSettings: (s: Settings) => request<Settings>(`${base}/settings`, { method: "PUT", body: JSON.stringify(s) }),
  lookup: (w: string) => request<Entry>(`${base}/lookup?w=${encodeURIComponent(w)}`),
  words: (from: number, count: number) => request<Word[]>(`${base}/words?from=${from}&count=${count}`),

  createPlan: (from: number, count: number, examples: number) => request<WithWords<Plan>>(`${base}/plans`, post({ from, count, examples })),
  plan: (id: number) => request<WithWords<Plan>>(`${base}/plans/${id}`),
  plans: () => request<Plan[]>(`${base}/plans`),
  savePlanPos: (id: number, pos: number, learned = false) => request<void>(`${base}/plans/${id}`, { method: "PUT", body: JSON.stringify({ pos, learned }) }),
  finishPlan: (id: number) => request<WithWords<Plan>>(`${base}/plans/${id}/finish`, { method: "POST" }),

  answer: (a: AnswerIn) => request<void>(`${base}/answers?${tz}`, post(a)),
  review: () => request<{ total: number; words: Word[] }>(`${base}/review?${tz}`),

  wrongs: (cleared: boolean) => request<Wrong[]>(`${base}/wrongs?cleared=${cleared ? 1 : 0}`),
  clearWrong: (word: string) => request<void>(`${base}/wrongs/${encodeURIComponent(word)}`, { method: "DELETE" }),

  createTest: (t: { scope: TestScope; from?: number; to?: number; count: number; mode: Mode }) => request<WithWords<Test>>(`${base}/tests`, post(t)),
  test: (id: number) => request<WithWords<Test>>(`${base}/tests/${id}`),
  tests: () => request<Test[]>(`${base}/tests`),
  finishTest: (id: number) => request<WithWords<Test>>(`${base}/tests/${id}/finish`, { method: "POST" }),
};

export const modeNames: Record<Mode, string> = { listen: "听音想意思", look: "看词想意思", speak: "看中文说英文", dictation: "听写" };
export const scopeNames: Record<TestScope, string> = { recent: "最近 7 天学的", range: "按序号范围", all: "全部学过的", wrong: "错题本" };

// 按口音取音标：英音显示 Britfone 的读音，美音显示 CMUdict 的读音。
export const phOf = (x: Phonetic, accent: string) => (accent === "en-GB" ? x.uk : x.us);

export function errorText(err: unknown) {
  return err instanceof Error ? err.message : "操作失败";
}
