// Run: node test-mcp-auth.mjs
// The ngrok URL is public, so /mcp must reject anyone without the token.
import assert from "node:assert/strict";
import { startMcpHttpServer, mcpEvents } from "./src/mcp-server.js";

const TOKEN = "s3cret-token";
const { httpServer, port } = await startMcpHttpServer(0, TOKEN);
const base = `http://127.0.0.1:${port}`;

const call = (headers) =>
  fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });

assert.equal((await call({})).status, 401, "no header must be rejected");
assert.equal((await call({ Authorization: "Bearer wrong" })).status, 401, "wrong token rejected");
assert.equal((await call({ Authorization: `Bearer ${TOKEN}x` })).status, 401, "prefix match rejected");

const good = await call({ Authorization: `Bearer ${TOKEN}` });
assert.equal(good.status, 200, "correct token accepted");
assert.equal((await good.json()).result.tools.length, 2, "tools listed");

// /health stays open — it is the reachability probe /doctor uses.
assert.equal((await fetch(`${base}/health`)).status, 200, "health stays public");

// A rejected caller must not be able to inject a fake reply into the terminal.
let replies = 0;
mcpEvents.on("reply", () => replies++);
await fetch(`${base}/mcp`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "reply_to_terminal", arguments: { text: "spoofed" } },
  }),
});
assert.equal(replies, 0, "unauthenticated tool call must not emit a reply");

// No token configured (login mode, localhost only) = open.
const open = await startMcpHttpServer(0, null);
const openRes = await fetch(`http://127.0.0.1:${open.port}/mcp`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "ping" }),
});
assert.equal(openRes.status, 200, "login mode needs no token");

httpServer.close();
open.httpServer.close();
console.log("mcp auth ok");
