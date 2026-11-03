// 音标：美音和英音各用一份开源发音词典，不自己猜读音。
//   - 美音：CMUdict（BSD，卡内基梅隆大学的美音发音词典），取每个词的第一个读音。
//   - 英音：Britfone（MIT，人工整理的标准英音词典），取每个词的第一个读音。
// 两份词典给出的是音素和每个元音的重音，这里只换成牛津学习词典的写法，不改读音：
//   - 符号一一对应：CMUdict 的 ARPAbet 换成 IPA（长元音标 ː，r 音化元音写成 ɜːr、ər）；
//     Britfone 的 ɛ 写成 e、ɛə 写成 eə、ɐ 写成 ʌ、ɹ 写成 r、g 写成 ɡ。
//   - 重音号：词典把重音记在元音上，显示时放到这个音节开头（取元音前面英语允许的最长词首辅音丛）。
//     单音节词不标重音；CMUdict 一个词里有几个主重音时（复合词），只有最后一个算主重音，前面的算次重音；
//     主重音后面的次重音不标（CMUdict 标得很多，学习词典一般不标），这样的 iː、uː 也按非重读写成 i、u。
//   - 多读音的词：一般取词典的第一个读音（弱读排在后面，见 add）。只有重音位置不同的名词动词同形词（record、present）按释义第一个词性挑：
//     名词、形容词取重音靠前的读音，动词取重音靠后的。CMUdict 里有不少不常用的异读（effect 也收了 ˈiːfekt），
//     所以只有美音、英音两份词典都收了这种读音对的词才这样挑（isHeteronym），其他词一律取第一个读音。
import { readFileSync } from "node:fs";

export const sources = {
  "cmudict.dict": "https://raw.githubusercontent.com/cmusphinx/cmudict/master/cmudict.dict",
  "britfone.csv": "https://raw.githubusercontent.com/JoseLlarena/Britfone/master/britfone.main.3.0.1.csv",
};

// 英语词首允许的辅音丛；单个辅音除了 ŋ、ʒ 都可以。sm、sf 不算：词中间的 s 一般归前一个音节（dismiss dɪsˈmɪs）。
const onsets = new Set(
  "p r|p l|p j|b r|b l|b j|t r|t j|t w|d r|d j|d w|k r|k l|k w|k j|ɡ r|ɡ l|ɡ w|f r|f l|f j|v j|θ r|θ w|θ j|ʃ r|h j|m j|n j|l j|s p|s t|s k|s n|s l|s w|s j|s p l|s p r|s p j|s t r|s t j|s k r|s k w|s k j|s k l".split(
    "|",
  ),
);
const legalOnset = (cs) => cs.length === 0 || (cs.length === 1 ? cs[0] !== "ŋ" && cs[0] !== "ʒ" : onsets.has(cs.join(" ")));

// phones：IPA 符号列表；stress：和 phones 对齐，元音是 "ˈ"、"ˌ" 或 ""，辅音是 null。
function render(phones, stress) {
  const vowels = stress.filter((s) => s !== null).length;
  const marks = new Map();
  let primarySeen = false;
  phones.forEach((_, i) => {
    const s = stress[i];
    if (s === "ˈ") primarySeen = true;
    if (!s || vowels < 2 || (s === "ˌ" && primarySeen)) return;
    let j = i;
    while (j > 0 && stress[j - 1] === null) j--; // j..i-1 是前一个元音和这个元音之间的辅音
    let start = j;
    if (j > 0) while (start < i && !legalOnset(phones.slice(start, i))) start++;
    marks.set(start, s);
  });
  return phones.map((p, i) => (marks.get(i) ?? "") + p).join("");
}

// ---- 美音：CMUdict ----

const arpaVowel = { AA: "ɑː", AE: "æ", AO: "ɔː", AW: "aʊ", AY: "aɪ", EH: "e", EY: "eɪ", IH: "ɪ", OW: "oʊ", OY: "ɔɪ", UH: "ʊ" };
const arpaConsonant = {
  B: "b", CH: "tʃ", D: "d", DH: "ð", F: "f", G: "ɡ", HH: "h", JH: "dʒ", K: "k", L: "l", M: "m", N: "n",
  NG: "ŋ", P: "p", R: "r", S: "s", SH: "ʃ", T: "t", TH: "θ", V: "v", W: "w", Y: "j", Z: "z", ZH: "ʒ",
};

function arpaToIpa(arpa) {
  const phones = [];
  const stress = [];
  const parts = arpa.split(" ").map((x) => x.match(/^([A-Z]+)([012])?$/)).filter(Boolean);
  const lastPrimary = parts.findLastIndex((m) => m[2] === "1");
  parts.forEach(([, p, s], k) => {
    if (s === undefined) {
      phones.push(arpaConsonant[p]);
      stress.push(null);
      return;
    }
    if (s === "1" && k < lastPrimary) s = "2";
    const weak = s === "0" || (s === "2" && k > lastPrimary);
    let v = arpaVowel[p];
    if (p === "AH") v = weak ? "ə" : "ʌ";
    if (p === "IY") v = weak ? "i" : "iː";
    if (p === "UW") v = weak ? "u" : "uː";
    // r 音化元音拆成元音加 r，r 后面紧跟元音时归到下一个音节（directly dəˈrektli）。
    if (p === "ER") v = weak ? "ə" : "ɜː";
    phones.push(v);
    stress.push(s === "1" ? "ˈ" : s === "2" ? "ˌ" : "");
    if (p === "ER") phones.push("r"), stress.push(null);
  });
  return render(phones, stress);
}

// 返回 单词 → 读音列表。列表按词典里的顺序，只是把弱读（整个词没有重读元音，比如 to 的 tə）挪到后面：
// 卡片、气泡和整句音标都显示单念时的读音，两份词典的处理一致。
function add(map, w, ipa, stressed) {
  if (!map.has(w)) map.set(w, { strong: [], weak: [] });
  map.get(w)[stressed ? "strong" : "weak"].push(ipa);
}
function flatten(map) {
  const out = new Map([...map].map(([w, x]) => [w, [...x.strong, ...x.weak]]));
  out.weak = new Map([...map].filter(([, x]) => x.weak.length).map(([w, x]) => [w, x.weak]));
  return out;
}

export function loadUS(file) {
  const us = new Map();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^(\S+?)(\(\d+\))?\s+([^#]+)/);
    if (m) add(us, m[1], arpaToIpa(m[3].trim()), /[12]/.test(m[3]));
  }
  return flatten(us);
}

// ---- 英音：Britfone ----

const ukVowel = /[aeiouæɑɒɔəɛɜɪʊʌɐ]/;
const ukSymbol = (p) => p.replace(/ɹ/g, "r").replace(/g/g, "ɡ").replace(/ɛə/g, "eə").replace(/ɛ/g, "e").replace(/ɐ/g, "ʌ");

// Britfone 的一个读音：音标符号用空格隔开，重音号贴在元音前面，比如 "ə b ˈɪ l ɪ t i"。
function britfoneToIpa(text) {
  const raw = text.trim().split(/\s+/);
  const stress = raw.map((p) => (ukVowel.test(p) ? (p.match(/[ˈˌ]/)?.[0] ?? "") : null));
  return render(
    raw.map((p) => ukSymbol(p.replace(/[ˈˌ]/g, ""))),
    stress,
  );
}

export function loadUK(file) {
  const uk = new Map();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^([^,(]+)(\(\d+\))?,\s*(.+)$/);
    if (!m) continue;
    add(uk, m[1].toLowerCase().replace(/_/g, " "), britfoneToIpa(m[3]), /[ˈˌ]/.test(m[3]));
  }
  return flatten(uk);
}

// 查一个词的音标；词典里没有就返回空，不拼也不猜。pos 是释义的第一个词性（n.、v. 等），只用来挑同形词的读音。
export function phoneticOf(map, w, pos = "") {
  const list = map.get(w.toLowerCase().replace(/^'+|'+$/g, "")) ?? [];
  if (list.length < 2 || !pos) return list[0] ?? "";
  // 只看和第一个读音音素一样、只是重音位置不同的读音。
  const plain = (p) => p.replace(/[ˈˌ]/g, "");
  const same = list.filter((p) => plain(p) === plain(list[0]) || sameButStress(p, list[0]));
  if (same.length < 2) return list[0];
  const at = (p) => (p.includes("ˈ") ? p.indexOf("ˈ") : 0);
  const sorted = [...same].sort((a, b) => at(a) - at(b));
  if (/^(n|a|adj)\./.test(pos)) return sorted[0];
  if (/^v[it]?\./.test(pos)) return sorted.at(-1);
  return list[0];
}

// 两份词典都收了“音素差不多、只是重音位置不同”的读音对，才算名词动词同形词。
export function isHeteronym(maps, w) {
  return maps.every((m) => {
    const list = m.get(w) ?? [];
    return list.some((p, i) => list.some((q, j) => i !== j && sameButStress(p, q) && p.indexOf("ˈ") !== q.indexOf("ˈ")));
  });
}

// 名词动词同形词重音一变，非重读元音也跟着变（ˈrekɔːd / rɪˈkɔːd），只比辅音。
const consonants = (p) => p.replace(/[ˈˌː]|aɪ|aʊ|eɪ|oʊ|əʊ|ɔɪ|eə|ɪə|ʊə|[aeiouæɑɒɔəɛɜɪʊʌ]/g, "");
const sameButStress = (a, b) => consonants(a) === consonants(b) && a !== b;

// 有弱读的虚词，取自 Roach《English Phonetics and Phonology》的弱读词表；
// that、some、there 有重读的用法（指示代词、“一些”、“那里”），光看句子分不清，不算在内。
const weakWords = new Set(
  "the a an and but than his her your she he we you him them us at for from of to as can could have has had shall should must do does am are was were".split(" "),
);

// 整句音标：每个词的词典读音按顺序连起来；查不到的词（多是人名）和数字原样保留。
// 上面这些虚词在句子中间用词典里的弱读（a ə、to tə，有带 ə 的弱读就用它），在句末用重读；词典没收弱读的照常显示。
// 没有连读，也不处理强调时的重读。
export function sentencePhonetic(map, en) {
  const words = en.match(/[A-Za-z][A-Za-z']*|\d+/g) ?? [];
  return words
    .map((w, i) => {
      const weak = i < words.length - 1 && weakWords.has(w.toLowerCase()) ? map.weak?.get(w.toLowerCase()) : undefined;
      if (weak) return weak.find((p) => p.includes("ə")) ?? weak[0];
      return phoneticOf(map, w) || w;
    })
    .join(" ");
}
