// 生成内置词库 backend/deck/core.json：node scripts/build-deck.mjs（npm run deck）。
// 只在更新词库时运行，平时构建镜像不需要；生成的文件提交到仓库里。
// 数据来源（许可证见 backend/deck/NOTICE.md）：
//   - 单词、释义、词形变化：ECDICT（MIT），按词频字段 frq 取前 3000 名里的纯字母词
//   - 音标：美音 CMUdict，英音 Britfone，见 scripts/phonetics.mjs
//   - 例句：Tatoeba 的中英句对（CC BY 2.0 FR），中文统一转成简体
//   - 例句里点词弹出的小词典 backend/deck/dict.json：例句里出现的每个词的音标和 ECDICT 释义
//   - Tatoeba 凑不够的例句：deck/extra.json，人工整理（AI 生成后抽查），来源记为 extra
// 下载的原始数据放在 .cache/deck/，已在 .gitignore 里。
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as OpenCC from "opencc-js";
import bz2 from "unbzip2-stream";
import { isHeteronym, loadUK, loadUS, phoneticOf, sentencePhonetic, sources as phoneticSources } from "./phonetics.mjs";

const root = resolve(import.meta.dirname, "..");
const cache = join(root, ".cache", "deck");
const out = join(root, "backend", "deck", "core.json");
const dictOut = join(root, "backend", "deck", "dict.json");
const extraFile = join(root, "deck", "extra.json");

const TOP = 3000; // 词频前多少名
const PER_WORD = 5; // 每个词存几条例句，用户在 2–5 条之间选
const tatoeba = "https://downloads.tatoeba.org/exports/per_language";
const sources = {
  "ecdict.csv": "https://raw.githubusercontent.com/skywind3000/ECDICT/master/ecdict.csv",
  "eng_sentences.tsv": `${tatoeba}/eng/eng_sentences.tsv.bz2`,
  "cmn_sentences.tsv": `${tatoeba}/cmn/cmn_sentences.tsv.bz2`,
  "eng-cmn_links.tsv": `${tatoeba}/eng/eng-cmn_links.tsv.bz2`,
  ...phoneticSources,
};

async function download(name, url) {
  const file = join(cache, name);
  if (existsSync(file)) return file;
  console.log(`下载 ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const body = Readable.fromWeb(res.body);
  await pipeline(url.endsWith(".bz2") ? body.pipe(bz2()) : body, createWriteStream(file));
  return file;
}

async function* lines(file) {
  yield* createInterface({ input: createReadStream(file, "utf8"), crlfDelay: Infinity });
}

// 解析 CSV 的一行（ECDICT 的字段里有逗号和引号，没有跨行的字段）。
function parseCsv(line) {
  const cells = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') (cur += '"'), i++;
      else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") cells.push(cur), (cur = "");
    else cur += c;
  }
  cells.push(cur);
  return cells;
}

// 释义：每个词性只留前 3 个义项，最多 3 个词性；有词性比例（pos 字段）时按比例排序，常用的在前。
function cleanTranslation(tr, pos) {
  const share = Object.fromEntries(
    pos
      .split("/")
      .filter(Boolean)
      .map((x) => x.split(":"))
      .map(([k, v]) => [k, Number(v)]),
  );
  const short = { v: ["vt", "vi", "v"], n: ["n"], j: ["a", "adj"], r: ["adv", "ad"], i: ["prep"], c: ["conj"], p: ["pron"], u: ["int", "interj"] };
  const weight = (tag) => {
    for (const [k, tags] of Object.entries(short)) if (tags.includes(tag)) return share[k] ?? 0;
    return 0;
  };
  const items = [];
  for (const line of tr.split("\\n")) {
    const m = line.match(/^([a-z]+)\.\s*(.*)$/);
    if (!m) continue;
    const senses = m[2]
      .split(/[,，;；]/)
      .map((s) => s.trim())
      .filter((s) => s && !s.startsWith("["))
      .slice(0, 3);
    if (senses.length) items.push({ tag: m[1], text: `${m[1]}. ${senses.join("、")}`, w: weight(m[1]) });
  }
  return items
    .map((x, i) => ({ ...x, i }))
    .sort((a, b) => b.w - a.w || a.i - b.i)
    .slice(0, 3)
    .map((x) => x.text);
}

const names = /\b(Tom|Mary|John|Ken|Jack|Mike|Bob|Bill|Jim|Mr|Mrs|Ms)\b/;
const tokens = (t) => new Set(t.toLowerCase().match(/[a-z']+/g) ?? []);
const similar = (a, b) => {
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n / (a.size + b.size - n) > 0.5;
};

// ecdict 逐行读 ECDICT，返回每一行的字段对象。
async function* ecdict(file) {
  let header;
  for await (const line of lines(file)) {
    const cells = parseCsv(line);
    if (!header) {
      header = cells;
      continue;
    }
    yield Object.fromEntries(header.map((h, i) => [h, cells[i] ?? ""]));
  }
}

// 词形变化里的原形（exchange 字段的 0:），例如 comprises → comprise。
const lemmaOf = (r) => r.exchange.split("/").find((x) => x.startsWith("0:"))?.slice(2);

async function main() {
  mkdirSync(cache, { recursive: true });
  const files = {};
  for (const [name, url] of Object.entries(sources)) files[name] = await download(name, url);
  const us = loadUS(files["cmudict.dict"]);
  const uk = loadUK(files["britfone.csv"]);

  // 1. 选词
  const words = [];
  for await (const r of ecdict(files["ecdict.csv"])) {
    const frq = Number(r.frq);
    if (!frq || frq > TOP || !/^[a-z]+$/.test(r.word)) continue;
    const forms = new Set([r.word]);
    for (const x of r.exchange.split("/")) {
      const [k, v] = x.split(":");
      if ("pdi3rst".includes(k) && /^[a-z]+$/.test(v ?? "")) forms.add(v);
    }
    const zh = cleanTranslation(r.translation, r.pos);
    if (!zh.length) continue;
    const pos = isHeteronym([us, uk], r.word) ? zh[0].split(" ")[0] : "";
    words.push({ frq, w: r.word, us: phoneticOf(us, r.word, pos), uk: phoneticOf(uk, r.word, pos), zh, forms: [...forms] });
  }
  words.sort((a, b) => a.frq - b.frq);
  console.log(`选出 ${words.length} 个词`);

  // 2. 中英句对
  const toSimplified = OpenCC.Converter({ from: "tw", to: "cn" });
  const eng = new Map();
  for await (const line of lines(files["eng_sentences.tsv"])) {
    const [id, , text] = line.split("\t");
    eng.set(id, text);
  }
  const cmn = new Map();
  for await (const line of lines(files["cmn_sentences.tsv"])) {
    const [id, , text] = line.split("\t");
    cmn.set(id, text);
  }
  const pairs = new Map();
  for await (const line of lines(files["eng-cmn_links.tsv"])) {
    const [e, c] = line.split("\t");
    if (eng.has(e) && cmn.has(c) && !pairs.has(e)) pairs.set(e, c);
  }
  // 按单词建索引，只收 3 到 20 个词的句子；4 到 14 个词的优先。
  const index = new Map();
  for (const id of pairs.keys()) {
    const n = eng.get(id).split(/\s+/).length;
    if (n < 3 || n > 20) continue;
    for (const t of tokens(eng.get(id))) {
      if (!index.has(t)) index.set(t, []);
      index.get(t).push(id);
    }
  }

  // 3. 每个词挑例句：长度接近 8 个词、不带常见人名、用原形的优先，去掉几乎重复的句子。
  const extra = existsSync(extraFile) ? JSON.parse(readFileSync(extraFile, "utf8")) : {};
  let short = 0;
  const deck = words.map((x, i) => {
    const ids = new Set(x.forms.flatMap((f) => index.get(f) ?? []));
    const scored = [...ids]
      .map((id) => {
        const en = eng.get(id);
        const n = en.split(/\s+/).length;
        let s = Math.abs(n - 8) + (n < 4 || n > 14 ? 10 : 0) + (names.test(en) ? 4 : 0) + (tokens(en).has(x.w) ? 0 : 1);
        return { id, en, s };
      })
      .sort((a, b) => a.s - b.s || a.en.length - b.en.length);
    const ex = [];
    const seen = [];
    for (const c of [...scored, ...(extra[x.w] ?? []).map((e) => ({ ...e, extra: true }))]) {
      const t = tokens(c.en);
      if (seen.some((s) => similar(s, t))) continue;
      seen.push(t);
      ex.push(c.extra ? { en: c.en, zh: c.zh, src: "extra" } : { en: c.en, zh: toSimplified(cmn.get(pairs.get(c.id))), src: `tatoeba:${c.id}` });
      if (ex.length === PER_WORD) break;
    }
    if (ex.length < PER_WORD) short++;
    return { n: i + 1, w: x.w, us: x.us, uk: x.uk, zh: x.zh, forms: x.forms, ex };
  });
  // 4. 小词典：例句里出现的词（和它们的原形）查 ECDICT，点例句里的词时显示。
  const want = new Set(deck.flatMap((x) => x.ex.flatMap((e) => [...tokens(e.en)])));
  const dict = {};
  const lemmas = new Set();
  const add = (r) => {
    const zh = cleanTranslation(r.translation, r.pos);
    const lemma = lemmaOf(r);
    if (lemma && lemma !== r.word) lemmas.add(lemma);
    // 只有“xx 的过去式”这类释义的变形词，记下原形，弹框里显示原形的释义。
    // ECDICT 里专有名词是大写开头（Sunday、English），查的时候统一用小写；小写词条优先。
    const key = r.word.toLowerCase();
    if (dict[key] && r.word !== key) return;
    const ph = [phoneticOf(us, key), phoneticOf(uk, key)];
    dict[key] = lemma && lemma !== r.word ? [...ph, zh, lemma] : [...ph, zh];
  };
  for await (const r of ecdict(files["ecdict.csv"])) if (want.has(r.word.toLowerCase())) add(r);
  for await (const r of ecdict(files["ecdict.csv"])) if (lemmas.has(r.word) && !dict[r.word.toLowerCase()]) add(r);
  writeFileSync(dictOut, JSON.stringify(dict) + "\n");
  console.log(`已写入 ${dictOut}，${Object.keys(dict).length} 个词，例句里有 ${[...want].filter((w) => !dict[w]).length} 个词查不到`);

  // 5. 整句音标：句中每个词的词典读音按顺序连起来，美音、英音各一份。
  for (const x of deck) for (const e of x.ex) Object.assign(e, { us: sentencePhonetic(us, e.en), uk: sentencePhonetic(uk, e.en) });
  mkdirSync(join(root, "backend", "deck"), { recursive: true });
  writeFileSync(out, JSON.stringify({ id: "core", name: "核心 3000 词", words: deck }) + "\n");
  console.log(`已写入 ${out}，${short} 个词例句不足 ${PER_WORD} 条`);

  const missing = deck.filter((x) => x.ex.length < PER_WORD).map((x) => `${x.w}\t${x.ex.length}`);
  writeFileSync(join(cache, "short.tsv"), missing.join("\n") + "\n");
  const noPh = (k) => deck.filter((x) => !x[k]).map((x) => x.w);
  console.log(`词库里没有美音的词：${noPh("us").join(" ") || "无"}；没有英音的词：${noPh("uk").join(" ") || "无"}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
