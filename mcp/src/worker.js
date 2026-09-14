/**
 * Cloudflare Worker entry point — the hosted install.
 *
 * Streamable HTTP can run without a session, and `createMcpHandler` is built
 * for exactly that — so this needs no Durable Object and no session storage:
 * a request arrives, a server is built, the tool runs, the response returns.
 * (`McpAgent`, the predecessor that did need a Durable Object, is deprecated.)
 *
 * On versions: the spec is at 2026-07-28, but SDK 2.0.0 negotiates 2025-11-25
 * at the highest — that is what this server actually speaks. Verified, not
 * assumed: asking for 2026-07-28 gets 2025-11-25 back.
 *
 * Everything expensive is already shared — kb.js caches the index at module
 * level, so a warm isolate serves requests without refetching, and the edge
 * collapses what would otherwise be one GitHub Pages request per user per hour
 * into one per isolate.
 *
 * Deploy with `npm run deploy`; clients then point at https://<host>/mcp.
 */

import { createMcpHandler } from "agents/mcp/server";

import { createServer } from "./server.js";
import { config } from "./kb.js";

// Built once per isolate rather than per request — the factory inside is what
// runs per request.
//
// Host validation (DNS-rebinding protection) is on by default and already
// covers localhost and *.workers.dev. A custom domain needs an explicit
// `allowedHostnames: [...]` here, or requests arrive rejected.
const handler = createMcpHandler(createServer, { route: "/mcp" });

// Anyone who opens the bare host in a browser gets the setup snippet instead of
// a 404. Pasting the wrong URL into a client is the likeliest failure here, so
// it is worth answering properly.
const LANDING = `台灣建築師知識庫 MCP server

MCP 端點：/mcp

在 MCP client 設定中加入：

{
  "mcpServers": {
    "tw-architect-kb": {
      "url": "<本站網址>/mcp"
    }
  }
}

索引來源：${config.indexUrl}
專案：https://github.com/h30190/HJPLUS_Taiwan_Architect_KB
`;

export default {
  fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (pathname === "/" || pathname === "") {
      return new Response(LANDING, {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    return handler(request, env, ctx);
  },
};
