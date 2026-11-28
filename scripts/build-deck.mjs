// 生成内置词库 backend/deck/core.json：node scripts/build-deck.mjs（npm run deck）。
// 只在更新词库时运行，平时构建镜像不需要；生成的文件提交到仓库里。
// 数据来源（许可证见 backend/deck/NOTICE.md）：
//   - 单词、释义、词形变化：ECDICT（MIT），按词频字段 frq 取前 3000 名里的纯字母词，按字母顺序排
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
const wordReplacementsFile = join(root, "deck", "word-replacements.json");

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
  const senses = (text) =>
    text
      .split(/[,，;；]/)
      .map((s) => s.trim())
      .filter((s) => s && !s.startsWith("["))
      .slice(0, 3);
  // 标了词性的行全是专业义（以 [计]、[医] 这类领域标记开头，比如 a 只有“art. [计] 累加器, 加法器…”）、
  // 又有没标词性的普通释义（a 的“第一个字母 A; 一个; 第一的”）时，用普通释义，词性借专业义那行的。
  let general = 0;
  let domainTag = "";
  const untagged = [];
  for (const raw of tr.split("\\n")) {
    const line = raw.replace(/\\r$/, "").trim();
    const m = line.match(/^([a-z]+)\.\s*(.*)$/);
    if (!m) {
      if (line) untagged.push(line);
      continue;
    }
    if (m[2].startsWith("[")) domainTag ||= m[1];
    else general++;
    const list = senses(m[2]);
    if (list.length) items.push({ tag: m[1], text: `${m[1]}. ${list.join("、")}`, w: weight(m[1]) });
  }
  const plain = untagged.map(senses).filter((list) => list.length);
  if (!general && domainTag && plain.length) {
    items.length = 0;
    for (const list of plain) items.push({ tag: domainTag, text: `${domainTag}. ${list.join("、")}`, w: 0 });
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

// 过滤不适合家庭/学习及自媒体发布的例句（色情低俗、自杀自残、恐袭凶杀、毒品赌博、涉政敏感、外网平台、粗口脏话）。
const unsafeExamplePatterns = [
  /(口交|做爱|性交|性传播|强奸|猥亵|妓女|嫖|色情|黄片|裸体|脱衣|内裤|胸罩|乳房|缩胸|高潮|避孕|堕胎|流产|卖淫|荡妇|情妇|婊子|网袜|\b(oral sex|blowjob|porn|rape|raped|prostitute|prostitution|whore|slut|naked|nude|orgasm|condom|abortion|intercourse|sexy|sexually transmitted|breast reduction|stripper|stripped and|stripped to the waist|breasts|nipple|penis|vagina|panties|thong|thongs|fishnet|erotic|masturbat\w*)\b)/i,
  /(自杀|轻生|割腕|上吊|跳楼|切腹|服毒|自残|\b(suicide|kill myself|kill himself|kill herself|commit suicide|hang himself|hang herself|slit.*wrist|seppuku)\b)/i,
  /(恐怖主义|恐怖分子|恐怖份子|恐袭|炸弹|轰炸|催泪弹|爆炸物|原子弹|暗杀|屠杀|大屠杀|连环杀手|杀手|谋杀|枪击|开枪|射杀|砍死|捅死|勒死|毒死|中了枪|\b(terrorist|terrorism|bombs?|bombed|bombing|tear-gas|massacre|assassinate|assassination|serial killer|murder|murderer|murdered|mass shooting|school shooting|shooting victim|shot dead|behead|torture)\b)/i,
  /(毒品|吸毒|贩毒|大麻|可卡因|海洛因|鸦片|冰毒|赌场|赌博|博彩|瘾君子|\b(cocaine|heroin|marijuana|cannabis|opium|opiate|meth|drug dealer|drug problem|selling drugs|addicted to drugs|gamble|gambling|casino)\b)/i,
  /(最高领袖|最高领导人|独裁|政变|政权|抗议|游行示威|示威游行|罢工|推翻|颠覆|纳粹|希特勒|斯大林|毛泽东|习近平|特朗普|川普|拜登|普京|普丁|奥巴马|台湾|台币|西藏|新疆|香港|钓鱼岛|朝鲜|以色列|巴勒斯坦|加沙|乌克兰|俄罗斯|苏联|共产党|国民党|民主党|共和党|自由主义|人权|言论自由|审查|封锁|禁止.*访问|\b(hitler|nazi|stalin|mao|trump|biden|putin|obama|taiwan|taiwanese|tibet|xinjiang|hong kong|north korea|israel|palestine|gaza|ukraine|russia|russian|soviet|communist|protest|protested|protesting|dictator|dictatorship|regime|coup|overthrow|censorship|human rights|free speech|supreme leader|democrat|democrats|republican|republicans)\b)/i,
  /(推特|脸书|油管|谷歌|维基百科|电报|暗网|\b(youtube|twitter|facebook|instagram|tiktok|whatsapp|telegram|google|reddit|netflix|wikipedia|wechat|douyin)\b)/i,
  /(他妈的|混蛋|蠢货|白痴|滚开|去死|闭嘴|婊子|瞎BB|不屌|找个毛|鬼话|\b(fuck|fucking|shit|bullshit|damn|bitch|bastard|asshole|crap|hell|shut up|idiot|moron)\b)/i,
];
const benignExamplePattern = /(with the naked eye|to the naked eye|film crew is shooting|as if to complain)/i;
function isUnsafeExample(en, zh) {
  const text = `${en} || ${zh}`;
  if (benignExamplePattern.test(en) && !/(口交|自杀|婊子|避孕套|堕胎|恐怖|毒品)/.test(text)) return false;
  return unsafeExamplePatterns.some((re) => re.test(text));
}

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

  // 1. 选词（按 deck/word-replacements.json 原位替换敏感词，保持总词数与字母顺序稳定）
  const wordReplacements = existsSync(wordReplacementsFile) ? JSON.parse(readFileSync(wordReplacementsFile, "utf8")) : {};
  const excludedWords = new Set(Object.keys(wordReplacements));
  const includedWords = new Set(Object.values(wordReplacements));
  const words = [];
  const seenWords = new Set();
  for await (const r of ecdict(files["ecdict.csv"])) {
    if (!/^[a-z]+$/.test(r.word) || excludedWords.has(r.word) || seenWords.has(r.word)) continue;
    const frq = Number(r.frq);
    const forced = includedWords.has(r.word);
    if (!forced && (!frq || frq > TOP)) continue;
    const forms = new Set([r.word]);
    for (const x of r.exchange.split("/")) {
      const [k, v] = x.split(":");
      if ("pdi3rst".includes(k) && /^[a-z]+$/.test(v ?? "")) forms.add(v);
    }
    const zh = cleanTranslation(r.translation, r.pos);
    if (!zh.length) continue;
    const pos = isHeteronym([us, uk], r.word) ? zh[0].split(" ")[0] : "";
    seenWords.add(r.word);
    words.push({ frq: frq || 999999, w: r.word, us: phoneticOf(us, r.word, pos), uk: phoneticOf(uk, r.word, pos), zh, forms: [...forms] });
  }
  const missingReplacements = [...includedWords].filter((w) => !seenWords.has(w));
  if (missingReplacements.length) throw new Error(`替换词在 ECDICT 中缺失或无有效释义：${missingReplacements.join(", ")}`);
  words.sort((a, b) => a.frq - b.frq || (a.w < b.w ? -1 : 1));
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

  // 3. 每个词挑例句：长度接近 8 个词、不带常见人名、用原形的优先，过滤敏感句并去掉几乎重复的句子。
  const extra = existsSync(extraFile) ? JSON.parse(readFileSync(extraFile, "utf8")) : {};
  // 按原句来源替换审核过的例句，保留它原来的选句位置。
  const replacements = JSON.parse(readFileSync(join(root, "deck", "example-replacements.json"), "utf8"));
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
      const zh = c.extra ? c.zh : toSimplified(cmn.get(pairs.get(c.id)));
      const src = c.extra ? "extra" : `tatoeba:${c.id}`;
      const overridden = replacements[src];
      const finalEn = overridden ? overridden.en : c.en;
      const finalZh = overridden ? overridden.zh : zh;
      if (!c.extra && !overridden && isUnsafeExample(finalEn, finalZh)) continue;
      const t = tokens(finalEn);
      if (seen.some((s) => similar(s, t))) continue;
      seen.push(t);
      ex.push({ en: finalEn, zh: finalZh, src: overridden ? "extra" : src });
      if (ex.length === PER_WORD) break;
    }
    if (ex.length < PER_WORD) short++;
    return { n: 0, f: i + 1, w: x.w, us: x.us, uk: x.uk, zh: x.zh, forms: x.forms, ex };
  });
  // 学习按字母顺序：n 是字母顺序的序号，f 是词频名次（出选择题时挑词频相近的干扰项）。
  deck.sort((a, b) => (a.w < b.w ? -1 : 1));
  deck.forEach((x, i) => (x.n = i + 1));
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
