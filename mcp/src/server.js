/**
 * The server itself: tool definitions shared by both transports.
 *
 * Exported as a factory because the two transports have different lifetimes:
 * the Cloudflare handler builds a fresh server per request, while stdio pins
 * one for the connection. Neither owns the tools, so they live here.
 *
 * Nothing in here may touch Node built-ins: this same file runs on the Workers
 * runtime. The index cache in kb.js is module-level, so a warm isolate reuses
 * it across requests without any of this code knowing.
 */

import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { config, fetchText, findEntry, getIndex } from "./kb.js";
import { search } from "./search.js";


const REPO = "https://github.com/h30190/HJPLUS_Taiwan_Architect_KB";

// Most of the base is not human-verified yet (the 資料狀況 dashboard tracks
// this). Building-code answers carry real professional liability, so every
// result states its verification state rather than letting the model present
// unverified material as settled.
const TEMPLATE = {
  domain: "知識樣板/domain.md",
  skill: "知識樣板/skill-name-hyphenated/SKILL.md",
};

// Class defaults live in SECTION_CLASS in scripts/update_readme_counts.py — a
// Python constant this server cannot import. Copying it into JS would create a
// second source of truth that silently drifts, so infer the convention from
// what the category's existing entries actually carry instead. That reading is
// current by construction.
function suggestKlass(entries, category) {
  const tally = {};
  for (const e of entries) {
    if (e.category !== category || !e.klass) continue;
    tally[e.klass] = (tally[e.klass] || 0) + 1;
  }
  const ranked = Object.entries(tally).sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return null;
  const total = ranked.reduce((n, [, c]) => n + c, 0);
  return {
    klass: ranked[0][0],
    detail: ranked.map(([k, c]) => `${k} ${c} 筆`).join("、"),
    confident: ranked[0][1] / total >= 0.6,
  };
}

function stateNote(entry) {
  if (entry.verified) {
    const by = entry.verifiedBy?.join(", ") || "未具名";
    return `已查證（${by}${entry.verifiedAt ? `，${entry.verifiedAt}` : ""}）`;
  }
  return `${entry.stateLabel || "狀態未標示"} — 需自行核對法規原文`;
}

function formatHit(entry, score) {
  const lines = [
    `### ${entry.title}`,
    `- \`name\`: \`${entry.name}\`（用於 get_skill）`,
    `- 分類：${entry.breadcrumb?.join(" / ") || entry.category || "—"}`,
    `- 類別：${entry.klassLabel || entry.klass || "—"}`,
    `- 查證狀態：${stateNote(entry)}`,
  ];
  if (entry.regulation) lines.push(`- 法規：${entry.regulation}`);
  if (entry.dataCurrency) lines.push(`- 資料時效：${entry.dataCurrency}`);
  if (entry.isPlanned) lines.push(`- ⚠️ 此條目為籌備中，內容尚未撰寫`);
  if (entry.hasTodo) lines.push(`- ⚠️ 標記為待台灣適配（TODO）`);
  lines.push(`- 說明：${entry.description || entry.summary || "—"}`);
  // Repo-relative path first: an agent working in a clone should read the file
  // with its own tools, which can grep and read a line range instead of pulling
  // the whole entry into context. Entries run to 52k characters at the top end,
  // so that difference is large. get_skill stays for callers with no clone.
  lines.push(`- 檔案：\`${entry.skillPath}\``);
  if (entry.domainPath) lines.push(`- 知識說明：\`${entry.domainPath}\``);
  lines.push(`- GitHub：${entry.skillUrl || `${REPO}/blob/main/${entry.skillPath}`}`);
  if (score) lines.push(`- 相關度：${score.toFixed(1)}`);
  return lines.join("\n");
}

function text(s) {
  return { content: [{ type: "text", text: s }] };
}

function fail(err) {
  return {
    isError: true,
    content: [{ type: "text", text: `查詢失敗：${err.message}` }],
  };
}

export function createServer() {
  const server = new McpServer(
    { name: "tw-architect-kb", version: "0.1.0" },
    {
      instructions: [
        "台灣建築師知識庫（OKF bundle）的檢索與貢獻介面。",
        "",
        "查詢：先以 search_kb 找到相關條目。取全文時，若你能存取這個 repo 的本機",
        "clone，優先用回傳的「檔案」路徑以自己的檔案工具讀取 —— 可先 grep 定位再讀",
        "需要的行段，比整篇載入省得多（條目最長超過 50000 字元）。沒有 clone 時才用",
        "get_skill。list_domains 可瀏覽分類結構。",
        "",
        "貢獻：要新增知識條目時，先用 check_name_available 確認 name 未被使用，",
        "再用 get_contribution_template 取得符合 OKF 規範的範本 —— 不要自行臆測",
        "frontmatter 欄位。本 server 不做規範驗證，寫完必須實際執行",
        "`python scripts/validate_okf.py`。",
        "",
        "重要：本庫多數條目尚未經人工查證。回答涉及法規判斷時，必須向使用者",
        "說明條目的查證狀態，並提醒核對法規原文；不要將未查證內容陳述為定論。",
      ].join("\n"),
    },
  );

  server.registerTool(
    "search_kb",
    {
      title: "檢索知識庫",
      description:
        "以自然語言檢索台灣建築師知識庫，回傳最相關的條目、其 `name` 與 repo 相對路徑。" +
        "支援中文查詢與法規條號（例如「陽臺容積計算」、「§162」、「第33條 樓梯寬度」）。" +
        "可用 klass / category / region / verifiedOnly 縮小範圍。" +
        "取全文時：若你在這個 repo 的本機 clone 中工作，優先用回傳的「檔案」路徑" +
        "以自己的檔案工具讀取 —— 可以先 grep 定位再讀需要的行段，比整篇載入省得多。" +
        "沒有本機 clone 時才用 get_skill。",
      inputSchema: {
        query: z
          .string()
          .describe("查詢字串，中文或英文皆可；可含法規條號如 §162 或 第33條"),
        klass: z
          .enum(["A", "B", "C"])
          .optional()
          .describe("類別篩選：A 通用技能、B 待台灣適配、C 台灣法規"),
        category: z.string().optional().describe("分類名稱篩選，如「建築法規」"),
        region: z.string().optional().describe("地區篩選，如 taiwan"),
        verifiedOnly: z
          .boolean()
          .optional()
          .describe("僅回傳已經人工查證的條目"),
        limit: z.number().int().min(1).max(20).optional().describe("回傳筆數，預設 5"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ query, klass, category, region, verifiedOnly, limit = 5 }) => {
      try {
        const { entries } = await getIndex();
        const hits = search(entries, query, { klass, category, region, verifiedOnly });
        if (!hits.length) {
          return text(
            `找不到符合「${query}」的條目。可試著放寬關鍵字，或用 list_domains 瀏覽分類。`,
          );
        }
        const shown = hits.slice(0, limit);
      const header = [
        `找到 ${hits.length} 筆，顯示前 ${shown.length} 筆：`,
        "",
        "（在本機 clone 中工作時，用下列「檔案」路徑以自己的工具讀取；" +
          "沒有 clone 時用 get_skill。）",
      ].join("\n");
        return text(
          [header, ...shown.map((h) => formatHit(h.entry, h.score))].join("\n\n"),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "get_skill",
    {
      title: "取回條目全文",
      description:
        "依 `name` 取回條目的 SKILL.md 全文（即時抓取 main 最新版）。" +
        "可加 includeDomain 一併取回該條目的 domain.md 知識說明。" +
        "注意這會回傳整篇（中位數約 3500 字元，最長超過 50000）。" +
        "若你能存取本機 clone，改用 search_kb 回傳的「檔案」路徑自行讀取會精確得多；" +
        "這個工具是給沒有 clone 的呼叫端用的。",
      inputSchema: {
        name: z.string().describe("條目的 `name`，由 search_kb 取得"),
        includeDomain: z
          .boolean()
          .optional()
          .describe("是否一併回傳 domain.md（知識背景說明），預設 false"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ name, includeDomain = false }) => {
      try {
        const entry = await findEntry(name);
        if (!entry) {
          return text(`找不到 name 為「${name}」的條目。請先用 search_kb 確認正確的 name。`);
        }
        if (entry.isPlanned) {
          return text(
            `「${entry.title}」目前標記為籌備中，尚無內容。\n分類：${entry.breadcrumb?.join(" / ")}`,
          );
        }

        const parts = [
          `# ${entry.title}`,
          `查證狀態：${stateNote(entry)}`,
          `原文：${entry.skillUrl || `${REPO}/blob/main/${entry.skillPath}`}`,
        ];

        if (includeDomain && entry.domainPath) {
          const domain = await fetchText(entry.domainPath);
          parts.push("---", "## domain.md", domain);
        }
        const skill = await fetchText(entry.skillPath);
        parts.push("---", "## SKILL.md", skill);

        return text(parts.join("\n\n"));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "list_domains",
    {
      title: "瀏覽分類結構",
      description:
        "列出知識庫的所有分類、各分類條目數與查證情況，用於在不確定關鍵字時瀏覽。",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      try {
        const index = await getIndex();
        const { summary } = index;
        const rows = Object.entries(summary?.categories || {})
          .sort((a, b) => b[1].total - a[1].total)
          .map(([name, s]) => {
            const flags = [];
            if (s.verified) flags.push(`已查證 ${s.verified}`);
            if (s.todo) flags.push(`待適配 ${s.todo}`);
            if (s.planned) flags.push(`籌備中 ${s.planned}`);
            return `| ${name} | ${s.total} | ${flags.join("、") || "—"} |`;
          });

        return text(
          [
            `知識庫共 ${summary?.total ?? index.entries.length} 筆條目（OKF v${index.okfVersion || "0.2"}）。`,
            "",
            "| 分類 | 條目數 | 備註 |",
            "| --- | --- | --- |",
            ...rows,
            "",
            `索引來源：${config.indexUrl}`,
          ].join("\n"),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "get_contribution_template",
    {
      title: "取得貢獻範本",
      description:
        "取回 知識樣板/ 的 domain.md 與 SKILL.md 範本全文（即時抓取 main 最新版），" +
        "附上目錄放置規則與合併前必須完成的步驟。" +
        "給 category 時，會依該分類現有條目統計建議 metadata.class。" +
        "要新增知識條目時應先呼叫這個工具，不要自行臆測 frontmatter 欄位。",
      inputSchema: {
        category: z
          .string()
          .optional()
          .describe("預定投稿的分類，如「建築法規」。用 list_domains 可查看有哪些分類"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ category }) => {
      try {
        const { entries } = await getIndex();
        const parts = ["# 新增知識條目範本"];

        if (category) {
          const known = new Set(entries.map((e) => e.category));
          if (!known.has(category)) {
            parts.push(
              `⚠️ 分類「${category}」不在現有分類中。若確定要新增分類，需一併建立` +
                `該層的 index.md；請先用 list_domains 確認。`,
            );
          }
          const hint = suggestKlass(entries, category);
          if (hint) {
            parts.push(
              `## 分類：${category}\n\n` +
                `- 建議 metadata.class：**${hint.klass}**` +
                `（該分類現有 ${hint.detail}${hint.confident ? "" : "；分布分散，請自行判斷"}）`,
            );
          }
        }

        parts.push(
          [
            "## 目錄結構（nested layout）",
            "",
            "```",
            `raw/${category || "<分類>"}/<中文知識入口>/domain.md`,
            `raw/${category || "<分類>"}/<中文知識入口>/<english-skill-name>/SKILL.md`,
            "```",
            "",
            "`domain.md` 與 `SKILL.md` 必須成對出現。`<english-skill-name>` 就是",
            "SKILL.md frontmatter 的 `name`，兩者必須一致（英文小寫連字號）。",
            "投稿前請用 check_name_available 確認該 name 未被使用。",
          ].join("\n"),
        );

        const [domain, skill] = await Promise.all([
          fetchText(TEMPLATE.domain),
          fetchText(TEMPLATE.skill),
        ]);
        parts.push("---", `## domain.md 範本（${TEMPLATE.domain}）`, domain);
        parts.push("---", `## SKILL.md 範本（${TEMPLATE.skill}）`, skill);

        parts.push(
          [
            "---",
            "## 寫完之後",
            "",
            "1. 同步父層 `index.md` 的 `## Skills` 清單",
            "2. 於 `raw/log.md` 以 `## YYYY-MM-DD` 標題加一筆 `**Creation**`",
            "3. 在 repo 根目錄執行 `python scripts/validate_okf.py`，必須 0 errors",
            "4. 執行 `python scripts/update_readme_counts.py` 更新計數表",
            "5. 若新條目的 class 與該分類預設不同，需同步",
            "   `scripts/update_readme_counts.py` 的 `SECTION_CLASS`",
            "",
            "步驟 3 的 validate_okf.py 是規範的唯一權威 —— 本工具只提供範本，",
            "不做驗證，請務必實際執行它。",
          ].join("\n"),
        );

        return text(parts.join("\n\n"));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "check_name_available",
    {
      title: "檢查 name 是否可用",
      description:
        "檢查 SKILL.md frontmatter 的 `name` 是否已被現有條目使用，並列出主題相似的條目。" +
        "用於投稿前避免撞名或重複貢獻。",
      inputSchema: {
        name: z
          .string()
          .describe("預定使用的 name，英文小寫連字號，如 balcony-lobby-far-recalculation"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ name }) => {
      try {
        const { entries } = await getIndex();
        const wanted = String(name).trim().toLowerCase();
        const lines = [];

        if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(wanted)) {
          lines.push(
            `⚠️ \`${wanted}\` 不符合命名慣例（英文小寫、數字，以連字號分隔）。` +
              `目錄名必須與這個 name 完全一致。`,
          );
        }

        const taken = entries.find((e) => e.name?.toLowerCase() === wanted);
        if (taken) {
          lines.push(
            `❌ 已被使用：**${taken.title}**`,
            `- 分類：${taken.breadcrumb?.join(" / ") || taken.category}`,
            `- 路徑：${taken.skillPath}`,
            "",
            "請改用其他 name；若目的是補充既有條目，應直接修改該檔案而非新增。",
          );
        } else {
          lines.push(`✅ \`${wanted}\` 尚未被使用。`);
        }

        // Hyphens hold the words apart; the scorer wants them as separate terms.
        const ranked = search(entries, wanted.replace(/-/g, " ")).filter(
          (h) => h.entry.name?.toLowerCase() !== wanted,
        );
        // Measured on this corpus: a genuinely on-topic hit scores 100+, while
        // incidental matches sit around 9–18. Listing that tail would tell a
        // contributor their topic is already covered when it is not, so cut it.
        // The relative half of the floor keeps a weak-but-best match from being
        // dropped when nothing scores high.
        const floor = ranked.length ? Math.max(30, ranked[0].score * 0.3) : 0;
        const similar = ranked.filter((h) => h.score >= floor).slice(0, 5);
        if (similar.length) {
          lines.push("", "### 主題相似的現有條目（確認是否重複）");
          for (const h of similar) {
            lines.push(`- **${h.entry.title}**（\`${h.entry.name}\`）— ${h.entry.category}`);
          }
          lines.push("", "若其中已有條目涵蓋你要寫的主題，建議改為補充該條目。");
        }

        return text(lines.join("\n"));
      } catch (err) {
        return fail(err);
      }
    },
  );

  return server;
}
