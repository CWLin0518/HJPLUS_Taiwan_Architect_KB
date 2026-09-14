/**
 * End-to-end check against the live server.
 *
 * Spawns src/index.js over stdio exactly as a client would, then exercises
 * every tool against the real index on GitHub Pages. This is the test that
 * proves the deployment story works — no local clone, no build step, just the
 * published index.
 *
 * Requires network access.
 *
 *   node test/e2e.js
 */

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, "../src/index.js");

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [entry],
});
const client = new Client({ name: "e2e", version: "0.0.0" });

function head(res, n = 6) {
  return (res.content?.[0]?.text || "")
    .split("\n")
    .slice(0, n)
    .join("\n")
    .replace(/^/gm, "   ");
}

let failures = 0;
function check(label, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? " — " + detail : ""}`);
  if (!ok) failures++;
}

await client.connect(transport);
console.log("已連線\n");

const { tools } = await client.listTools();
console.log("tools:", tools.map((t) => t.name).join(", "), "\n");
check("五個 tool 都註冊", tools.length === 5, tools.map((t) => t.name).join(","));

// 1. list_domains — index reachable and parsed
const domains = await client.callTool({ name: "list_domains", arguments: {} });
console.log("── list_domains");
console.log(head(domains, 7), "\n");
check("list_domains 回傳分類表", !domains.isError && /條目數/.test(domains.content[0].text));

// 2. search_kb — Chinese query
const s1 = await client.callTool({
  name: "search_kb",
  arguments: { query: "陽臺容積計算", limit: 2 },
});
console.log("── search_kb 「陽臺容積計算」");
console.log(head(s1, 8), "\n");
check("中文查詢命中陽臺條目", /陽臺/.test(s1.content[0].text));
// The repo-relative path is what lets an agent in a clone read the file with
// its own tools instead of pulling the whole entry through get_skill.
check("回傳 repo 相對路徑", /檔案：`raw\//.test(s1.content[0].text));
check("回傳 domain.md 路徑", /知識說明：`raw\//.test(s1.content[0].text));
check("仍保留 GitHub 連結", /GitHub：https:\/\//.test(s1.content[0].text));

// 3. search_kb — article number
const s2 = await client.callTool({ name: "search_kb", arguments: { query: "§162", limit: 2 } });
check("條號查詢有結果", !/找不到/.test(s2.content[0].text));

// 4. search_kb — filter
const s3 = await client.callTool({
  name: "search_kb",
  arguments: { query: "法規", klass: "C", limit: 3 },
});
check("klass 篩選可用", !s3.isError && /台灣法規/.test(s3.content[0].text));

// 5. get_skill — full text off raw.githubusercontent
const g = await client.callTool({
  name: "get_skill",
  arguments: { name: "balcony-lobby-far-recalculation" },
});
console.log("── get_skill balcony-lobby-far-recalculation");
console.log(head(g, 5), "\n");
const gText = g.content[0].text;
check("取回 SKILL.md 全文", /## SKILL\.md/.test(gText) && gText.length > 500,
  `${gText.length} 字元`);
check("附上查證狀態", /查證狀態/.test(gText));

// 6. get_skill — unknown name degrades gracefully
const g404 = await client.callTool({ name: "get_skill", arguments: { name: "no-such-skill" } });
check("未知 name 給出可行動的訊息", /找不到/.test(g404.content[0].text));

// 7. check_name_available — a taken name must be reported as taken
const taken = await client.callTool({
  name: "check_name_available",
  arguments: { name: "balcony-lobby-far-recalculation" },
});
check("撞名被偵測", /已被使用/.test(taken.content[0].text));

// 8. check_name_available — a free name, and no noise in the similar list
const free = await client.callTool({
  name: "check_name_available",
  arguments: { name: "completely-new-topic-xyz" },
});
const freeText = free.content[0].text;
check("未使用的 name 回報可用", /尚未被使用/.test(freeText));
check("無關的 name 不列相似條目", !/主題相似/.test(freeText));

// 9. check_name_available — naming convention is flagged, not silently accepted
const bad = await client.callTool({
  name: "check_name_available",
  arguments: { name: "Bad_Name" },
});
check("命名不合慣例會警告", /不符合命名慣例/.test(bad.content[0].text));

// 10. get_contribution_template — templates come from the repo, live
const tpl = await client.callTool({
  name: "get_contribution_template",
  arguments: { category: "建築法規" },
});
const tplText = tpl.content[0].text;
console.log("── get_contribution_template 建築法規");
console.log(head(tpl, 5), "\n");
check("回傳兩份範本", /domain\.md 範本/.test(tplText) && /SKILL\.md 範本/.test(tplText),
  `${tplText.length} 字元`);
check("依現有條目建議 class", /建議 metadata\.class/.test(tplText));
check("指向 validate_okf.py 為權威", /validate_okf\.py/.test(tplText));

// 11. unknown category warns rather than inventing a path
const unknown = await client.callTool({
  name: "get_contribution_template",
  arguments: { category: "不存在的分類" },
});
check("未知分類會警告", /不在現有分類中/.test(unknown.content[0].text));


await client.close();
console.log(`\n${failures === 0 ? "全部通過" : `${failures} 項失敗`}`);
process.exit(failures === 0 ? 0 : 1);
