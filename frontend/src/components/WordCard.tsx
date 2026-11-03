import { Fragment } from "react";
import { phOf, type Word } from "../api";
import { showWord } from "./WordPopup";
import styles from "./WordCard.module.css";

// 一张学习卡片，版式照着视频：单词页是居中的大字单词、音标和释义；例句页顶部一行小字写着单词和释义，
// 中间是大字例句（目标词加重），下面是中文。example 为 -1 时是单词页，否则是第几条例句。
// sentencePh 为真时例句下面加一行整句音标（设置里可以关）。
export default function WordCard({
  word,
  example,
  accent,
  sentencePh = false,
  hideText = false,
}: {
  word: Word;
  example: number;
  accent: string;
  sentencePh?: boolean;
  hideText?: boolean;
}) {
  const ex = example >= 0 ? word.ex[example] : undefined;
  const ph = phOf(ex ?? word, accent);
  return (
    <div className={styles.card}>
      <span className={styles.no}>{word.n}</span>
      {ex ? (
        <>
          <span className={styles.head}>
            {word.w} <span className={styles.headZh}>- {word.zh[0]}</span>
          </span>
          <div className={styles.body}>
            <p className={styles.sentence}>{hideText ? "· · ·" : <Highlight text={ex.en} forms={word.forms} accent={accent} />}</p>
            {sentencePh && ph && !hideText && <p className={styles.sentencePh}>[ {ph} ]</p>}
            <p className={styles.zh}>{ex.zh}</p>
          </div>
        </>
      ) : (
        <div className={styles.body}>
          <p className={styles.word}>{hideText ? "· · ·" : word.w}</p>
          {ph && !hideText && <p className={styles.ph}>[ {ph} ]</p>}
          <div className={styles.meaning}>
            {word.zh.map((z) => (
              <p key={z}>{z}</p>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// 把句子里的目标词（含变形）加重显示；每个词都可以点，点了弹出音标、释义和朗读（WordPopup）。
export function Highlight({ text, forms, accent }: { text: string; forms: string[]; accent: string }) {
  const set = new Set(forms);
  return (
    <>
      {text.split(/([A-Za-z][A-Za-z']*)/).map((part, i) => {
        if (i % 2 === 0) return <Fragment key={i}>{part}</Fragment>;
        const Tag = set.has(part.toLowerCase()) ? "strong" : "span";
        return (
          <Tag key={i} className={styles.tok} data-w={part} onClick={(e) => showWord(part, e.currentTarget, accent)}>
            {part}
          </Tag>
        );
      })}
    </>
  );
}

// 页面列表：每个词一张单词页，后面跟 n 条例句页（词库里不够 n 条时有几条算几条）。
export type Page = { word: Word; example: number };
export function pagesOf(words: Word[], examples: number): Page[] {
  return words.flatMap((word) => [{ word, example: -1 }, ...word.ex.slice(0, examples).map((_, i) => ({ word, example: i }))]);
}
