#!/usr/bin/env node
/**
 * stdio entry point — the local install (`npx @hjplus/tw-architect-kb-mcp`).
 *
 * `serveStdio` owns the protocol-era decision for the connection: a modern
 * client is served statelessly, while a 2025-era client still gets a pinned
 * instance. That backward compatibility is why upgrading to the v2 SDK does not
 * strand anyone on an older MCP client.
 *
 * See src/worker.js for the same tools over HTTP.
 */

import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { createServer } from "./server.js";

await serveStdio(createServer);
