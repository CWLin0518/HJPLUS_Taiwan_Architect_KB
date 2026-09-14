/**
 * Cloudflare Worker check, without deploying.
 *
 * The Worker entry is plain web-standard fetch, so it can be driven straight
 * from Node with a Request object — the same shape the Workers runtime hands
 * it. That keeps the hosted transport under test for anyone without a
 * Cloudflare account.
 *
 * Requires network access (the tools read the live index).
 *
 *   node test/worker.js
 */

import worker from "../src/worker.js";

// Stateless Streamable HTTP: the client identity travels in per-request _meta
// instead of an initialize round trip, which is what lets the Worker answer
// without any session storage.
//
// Note the SDK does not validate this version string — a bogus value is served
// just the same — so it documents intent here rather than pinning behaviour.
// 2025-11-25 is what SDK 2.0.0 actually negotiates.
const META = {
  "io.modelcontextprotocol/protocol-version": "2025-11-25",
  "io.modelcontextprotocol/client-info": { name: "worker-test", version: "1" },
  "io.modelcontextprotocol/client-capabilities": {},
};

const HOST = "tw-architect-kb.example.workers.dev";
const ctx = { waitUntil() {}, passThroughOnException() {} };
let id = 0;

async function rpc(method, params = {}) {
  const req = new Request(`https://${HOST}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      // Node's Request omits Host; the Workers runtime always sets it, and the
      // SDK rejects its absence as DNS-rebinding protection.
      host: HOST,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params: { ...params, _meta: META } }),
  });
  const res = await worker.fetch(req, {}, ctx);
  const raw = await res.text();
  // The handler answers in SSE framing; pull the one data line back out.
  const line = raw.split("\n").find((l) => l.startsWith("data:"));
  return { status: res.status, body: line ? JSON.parse(line.slice(5)) : raw };
}

let failures = 0;
function check(label, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? " — " + detail : ""}`);
  if (!ok) failures++;
}

// Landing page: the likeliest user error is pasting the bare host.
const landing = await worker.fetch(new Request("https://x/"), {}, ctx);
check("根路徑回傳設定說明", landing.status === 200 && /\/mcp/.test(await landing.text()));

const list = await rpc("tools/list");
const names = (list.body.result?.tools || []).map((t) => t.name);
console.log("tools:", names.join(", "));
check("五個 tool 都註冊", names.length === 5, names.join(","));

const domains = await rpc("tools/call", { name: "list_domains", arguments: {} });
check("list_domains 讀到 Pages 索引", /條目數/.test(domains.body.result?.content?.[0]?.text || ""));

const search = await rpc("tools/call", {
  name: "search_kb",
  arguments: { query: "陽臺容積計算", limit: 2 },
});
const sText = search.body.result?.content?.[0]?.text || "";
check("中文查詢命中", /陽臺/.test(sText));
console.log("   " + sText.split("\n").slice(0, 3).join("\n   "));

const skill = await rpc("tools/call", {
  name: "get_skill",
  arguments: { name: "balcony-lobby-far-recalculation" },
});
const gText = skill.body.result?.content?.[0]?.text || "";
check("取回 SKILL.md 全文", /## SKILL\.md/.test(gText) && gText.length > 500, `${gText.length} 字元`);
check("附上查證狀態", /查證狀態/.test(gText));

console.log(`\n${failures === 0 ? "全部通過" : `${failures} 項失敗`}`);
process.exit(failures === 0 ? 0 : 1);
