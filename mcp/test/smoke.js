/**
 * Retrieval smoke test.
 *
 * Runs a fixed set of practitioner-shaped queries against a local index and
 * prints the top hits. The point is the ranking, not a pass/fail assertion:
 * a Chinese bigram scorer is only worth keeping if a real question puts the
 * right entry first, and that is a judgement a human has to eyeball.
 *
 * Needs a local index — run `python scripts/kb_index.py` from the repo root
 * first (it writes the gitignored docs/kb.json).
 *
 *   node test/smoke.js
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { search } from "../src/search.js";

const here = dirname(fileURLToPath(import.meta.url));
const indexPath = process.argv[2] || resolve(here, "../../docs/kb.json");

let index;
try {
  index = JSON.parse(readFileSync(indexPath, "utf8"));
} catch {
  console.error(
    `找不到索引：${indexPath}\n請先於 repo 根目錄執行：python scripts/kb_index.py`,
  );
  process.exit(1);
}

const QUERIES = [
  "陽臺容積計算",
  "樓梯寬度規定",
  "§162",
  "第33條",
  "無障礙電梯尺寸",
  "排煙窗",
  "高度比 面前道路",
  "綠建築評估",
  "公共工程招標",
  "Revit",
  "容積免計陷阱",
  "發電機室",
];

console.log(`索引：${indexPath}（${index.entries.length} 筆）\n`);

let misses = 0;
for (const q of QUERIES) {
  const hits = search(index.entries, q).slice(0, 3);
  if (!hits.length) misses++;
  console.log(`── ${q}`);
  if (!hits.length) {
    console.log("   （無結果）");
  } else {
    for (const [i, h] of hits.entries()) {
      // Several skills can share a domain title, so print the unique name too.
      console.log(
        `   ${i + 1}. [${h.score.toFixed(1)}] ${h.entry.title}  (${h.entry.name})`,
      );
    }
  }
  console.log();
}

console.log(`完成：${QUERIES.length} 個查詢，${misses} 個無結果。`);
