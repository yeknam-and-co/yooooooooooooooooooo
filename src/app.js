import { createMcpServer, startMcpHttpServer, mcpEvents, getMcpHitCount } from "./mcp-server.js";
import { PokeClient } from "./poke-client.js";
import { startTUI, tuiEvents } from "./tui.js";
import { startPublicTunnel, stopPublicTunnel } from "./public-tunnel.js";
import {
  loadConfig,
  updateConfig,
  clearConfig,
  resolveNgrokCreds,
  integrationsUrl,
  openInBrowser,
  ensureMcpToken,
} from "./config.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

function resolveToken() {
  if (process.env.POKE_API_KEY) return process.env.POKE_API_KEY;

  const configDir = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");

  try {
    const cfg = JSON.parse(readFileSync(join(configDir, "poke-tui", "config.json"), "utf-8"));
    if (cfg.apiKey) return cfg.apiKey;
  } catch {}

  try {
    const creds = JSON.parse(readFileSync(join(configDir, "poke", "credentials.json"), "utf-8"));
    if (creds.token) return creds.token;
  } catch {}

  return null;
}

const cfgBoot = loadConfig();
const AUTH_MODE =
  process.env.POKE_TUI_AUTH_MODE || cfgBoot.authMode || "api-key";

const POKE_API_KEY = resolveToken();

// Only the ngrok path is publicly exposed; login mode stays on localhost
// behind Poke's own tunnel, which doesn't carry our token.
const MCP_TOKEN = AUTH_MODE === "api-key" ? ensureMcpToken() : null;

const REPLY_TIMEOUT_MS = 90_000;
let replyTimer = null;

function clearReplyTimer() {
  if (replyTimer) {
    clearTimeout(replyTimer);
    replyTimer = null;
  }
}

if (!POKE_API_KEY) {
  console.error("No credentials found. Run: npx poke-tui-ngrok");
  process.exit(1);
}

startTUI();

const client = new PokeClient({
  apiKey: POKE_API_KEY,
  authMode: AUTH_MODE,
  onEvent: (type, data) => {
    switch (type) {
      case "mcp-connected":
      case "tunnel-connected":
        tuiEvents.emit("connected", true);
        break;
      case "mcp-disconnected":
      case "tunnel-disconnected":
        tuiEvents.emit("connected", false);
        tuiEvents.emit("system", "Connection lost.");
        break;
      case "tunnel-error":
        tuiEvents.emit("error", `Tunnel error: ${data}`);
        break;
      case "error":
        tuiEvents.emit("error", data);
        break;
    }
  },
});

mcpEvents.on("reply", (text) => {
  clearReplyTimer();
  tuiEvents.emit("thinking", false);
  tuiEvents.emit("message", "poke", text);
});

mcpEvents.on("notification", (message) => {
  tuiEvents.emit("system", message);
});

mcpEvents.on("error", (message) => {
  tuiEvents.emit("error", message);
});

tuiEvents.on("user-input", async (text) => {
  if (text.toLowerCase() === "link") {
    const url = client.mcpUrl ? integrationsUrl(client.mcpUrl, MCP_TOKEN) : null;
    if (!url) {
      tuiEvents.emit("error", "No link yet. Wait for MCP setup, or use /mcp.");
      return;
    }
    tuiEvents.emit("command", "Link");
    tuiEvents.emit("result", "Copy/paste this URL:");
    tuiEvents.emit("result", url);
    openInBrowser(url);
    return;
  }

  if (text.startsWith("/")) {
    await handleCommand(text);
    return;
  }

  tuiEvents.emit("message", "you", text);
  tuiEvents.emit("thinking", true);

  try {
    const res = await client.sendChat(text);
    if (res.success === false) {
      clearReplyTimer();
      tuiEvents.emit("thinking", false);
      tuiEvents.emit("error", res.message || "Failed to send.");
      return;
    }
    // Poke has no reply API — if it answers in chat instead of calling
    // reply_to_terminal, the answer lands in the user's messaging app, not here.
    clearReplyTimer();
    replyTimer = setTimeout(() => {
      replyTimer = null;
      tuiEvents.emit("thinking", false);
      tuiEvents.emit("system", "No reply in 90s — check your messaging app, or run /doctor.");
    }, REPLY_TIMEOUT_MS);
  } catch (err) {
    clearReplyTimer();
    tuiEvents.emit("thinking", false);
    tuiEvents.emit("error", err.message);
  }
});

tuiEvents.on("user-quit", async () => {
  try {
    await stopPublicTunnel();
    await client.stop();
  } catch {}
  process.exit(0);
});

function showMcpSetup(mcpUrl) {
  const setupUrl = integrationsUrl(mcpUrl, MCP_TOKEN);

  tuiEvents.emit("command", "MCP setup");
  tuiEvents.emit("link", {
    url: setupUrl,
    label: "Click here to add integration",
  });
  if (MCP_TOKEN) {
    tuiEvents.emit("result", `API Key field: ${MCP_TOKEN}`);
    tuiEvents.emit("result", "(paste it if the form didn't prefill — without it Poke gets 401)");
  }
  tuiEvents.emit("result", "Ctrl+click · or type link · then /mcp done");
}

function markMcpDone() {
  if (!client.mcpUrl) {
    tuiEvents.emit("error", "No MCP URL yet. Wait for the tunnel to start.");
    return;
  }

  updateConfig({
    mcpUrl: client.mcpUrl,
    mcpSetupComplete: true,
  });
  client.setConnected(true);
  tuiEvents.emit("command", "MCP done");
  tuiEvents.emit("result", "Marked complete. You’re good to chat.");
}

async function handleCommand(text) {
  const parts = text.slice(1).split(" ");
  const cmd = parts[0]?.toLowerCase();

  if (cmd === "help") {
    tuiEvents.emit("command", "Help");
    if (AUTH_MODE === "api-key") {
      tuiEvents.emit("result", "/mcp              Show MCP URL and setup status");
      tuiEvents.emit("result", "/mcp done         Mark MCP setup complete");
      tuiEvents.emit("result", "link              Print Integrations URL (copy/paste)");
    }
    tuiEvents.emit("result", "/webhook create <when> | <do what>");
    tuiEvents.emit("result", '/webhook fire <#> {"data":"here"}');
    tuiEvents.emit("result", "/webhooks");
    tuiEvents.emit("result", "/status");
    tuiEvents.emit("result", "/doctor           Diagnose the reply round-trip");
    tuiEvents.emit("result", "/clear            Clear the chat");
    tuiEvents.emit("result", "/logout           Clear config and quit");
    return;
  }

  if (cmd === "doctor") {
    tuiEvents.emit("command", "Doctor");
    const cfg = loadConfig();
    const ok = (pass, text) => tuiEvents.emit("result", `${pass ? "✓" : "✗"} ${text}`);

    tuiEvents.emit("result", `Mode: ${AUTH_MODE === "login" ? "poke login" : "API key + ngrok"}`);
    ok(Boolean(client.mcpUrl), client.mcpUrl || "No MCP URL — tunnel never started");

    if (AUTH_MODE === "api-key") {
      const confirmed = Boolean(cfg.mcpSetupComplete && cfg.mcpUrl === client.mcpUrl);
      ok(confirmed, confirmed ? "Integration confirmed for this URL" : "Integration not confirmed for this URL — run /mcp");
      ok(
        Boolean(MCP_TOKEN),
        MCP_TOKEN ? "Endpoint auth on" : "Endpoint auth OFF — anyone with the URL can post replies"
      );
      ok(Boolean(client.terminalWebhook), client.terminalWebhook ? "Terminal webhook ready" : "No terminal webhook");

      if (client.mcpUrl) {
        // Proves the tunnel round-trips from the public internet, not just locally.
        try {
          const res = await fetch(client.mcpUrl.replace(/\/mcp$/, "/health"), {
            headers: { "ngrok-skip-browser-warning": "1" },
            signal: AbortSignal.timeout(8000),
          });
          const body = res.ok ? await res.json() : null;
          ok(res.ok, res.ok ? `Tunnel reachable from outside (${body.hits} hits)` : `Tunnel returned HTTP ${res.status}`);
        } catch (err) {
          ok(false, `Tunnel unreachable: ${err.message}`);
        }
      }
    }

    const hits = getMcpHitCount();
    ok(hits > 0, hits > 0 ? `${hits} MCP calls this session` : "Poke has never called this server");
    return;
  }

  if (cmd === "clear") {
    tuiEvents.emit("clear");
    return;
  }

  if (cmd === "logout") {
    tuiEvents.emit("command", "Logout");
    tuiEvents.emit("result", "Clearing saved config…");
    try {
      await stopPublicTunnel();
      await client.stop();
    } catch {}
    clearConfig();
    tuiEvents.emit("result", "Done. Run poke-tui again to set up.");
    setTimeout(() => process.exit(0), 400);
    return;
  }

  if (cmd === "status") {
    tuiEvents.emit("command", "Status");
    tuiEvents.emit("result", `Mode: ${AUTH_MODE === "login" ? "poke login" : "API key + ngrok"}`);
    if (client.connected) {
      tuiEvents.emit(
        "result",
        AUTH_MODE === "login" ? "Poke tunnel connected" : "Tunnel up · MCP marked done"
      );
      if (client.mcpUrl) tuiEvents.emit("result", client.mcpUrl);
    } else if (AUTH_MODE === "api-key") {
      tuiEvents.emit("result", "Not marked done yet — add Integrations, then /mcp done");
      if (client.mcpUrl) tuiEvents.emit("result", client.mcpUrl);
    } else {
      tuiEvents.emit("result", "Not connected");
    }
    if (AUTH_MODE === "api-key") {
      tuiEvents.emit(
        "result",
        client.terminalWebhook
          ? `Webhook ${client.terminalWebhook.triggerId || "saved"}`
          : "Terminal webhook not ready"
      );
      tuiEvents.emit("result", `MCP hits: ${getMcpHitCount()}`);
    }
    tuiEvents.emit("result", `Session webhooks: ${client.webhooks.length}`);
    return;
  }

  if (cmd === "mcp") {
    if (AUTH_MODE === "login") {
      tuiEvents.emit("command", "MCP");
      tuiEvents.emit("result", "Using official Poke tunnel — no Integrations URL needed.");
      return;
    }

    const sub = parts[1]?.toLowerCase();
    const cfg = loadConfig();

    if (sub === "done") {
      markMcpDone();
      return;
    }

    if (!client.mcpUrl) {
      tuiEvents.emit("command", "MCP");
      tuiEvents.emit("result", "Tunnel not running yet.");
      return;
    }

    tuiEvents.emit("command", "MCP");
    tuiEvents.emit("result", client.mcpUrl);
    if (cfg.mcpSetupComplete && cfg.mcpUrl === client.mcpUrl) {
      tuiEvents.emit("result", "Already marked done.");
    } else {
      showMcpSetup(client.mcpUrl);
    }
    return;
  }

  if (cmd === "webhooks") {
    tuiEvents.emit("command", "Webhooks");
    if (client.webhooks.length === 0) {
      tuiEvents.emit("result", "None yet. /webhook create <when> | <do what>");
      return;
    }
    client.webhooks.forEach((wh, i) => {
      tuiEvents.emit("result", `#${i}  ${wh.triggerId}`);
    });
    return;
  }

  if (cmd === "webhook") {
    const sub = parts[1]?.toLowerCase();

    if (sub === "create") {
      const rest = parts.slice(2).join(" ");
      const pipeIdx = rest.indexOf("|");
      if (pipeIdx === -1) {
        tuiEvents.emit("error", "Usage: /webhook create <when> | <do what>");
        return;
      }
      const condition = rest.slice(0, pipeIdx).trim();
      const action = rest.slice(pipeIdx + 1).trim();
      tuiEvents.emit("command", "Create webhook");
      try {
        await client.createWebhook({ condition, action });
        tuiEvents.emit("result", `Created #${client.webhooks.length - 1}`);
      } catch (err) {
        tuiEvents.emit("error", err.message);
      }
      return;
    }

    if (sub === "fire") {
      const index = parseInt(parts[2], 10);
      const jsonStr = parts.slice(3).join(" ");
      if (isNaN(index) || !jsonStr) {
        tuiEvents.emit("error", 'Usage: /webhook fire <#> {"data":"here"}');
        return;
      }
      let data;
      try {
        data = JSON.parse(jsonStr);
      } catch {
        tuiEvents.emit("error", "Invalid JSON.");
        return;
      }
      tuiEvents.emit("command", "Fire webhook", `#${index}`);
      try {
        await client.fireWebhook(index, data);
        tuiEvents.emit("result", "Fired.");
      } catch (err) {
        tuiEvents.emit("error", err.message);
      }
      return;
    }

    tuiEvents.emit("error", "Try: /webhook create or /webhook fire");
    return;
  }

  tuiEvents.emit("error", "Unknown command. Type /help");
}

async function fetchUserName() {
  const base = process.env.POKE_API ?? "https://poke.com/api/v1";
  try {
    const res = await fetch(`${base}/user/profile`, {
      headers: { Authorization: `Bearer ${POKE_API_KEY}` },
    });
    if (res.ok) {
      const data = await res.json();
      const full = data.name || data.email || data.id || null;
      if (!full) return null;
      return full.split(/[\s@]/)[0];
    }
  } catch {}
  return null;
}

async function bootLoginMode(port) {
  tuiEvents.emit("command", "Boot");
  tuiEvents.emit("result", "Mode: poke login");
  tuiEvents.emit("result", "Starting official Poke tunnel…");
  await client.init(port);
  await client.startPokeTunnel();
  tuiEvents.emit("result", "Poke tunnel connected");
}

async function bootApiKeyMode(port) {
  tuiEvents.emit("command", "Boot");
  tuiEvents.emit("result", "Mode: API key + ngrok");

  await client.init(port);

  try {
    await client.ensureTerminalWebhook();
    tuiEvents.emit("result", "Terminal webhook ready");
  } catch (err) {
    tuiEvents.emit("error", `Webhook setup failed: ${err.message}`);
  }

  const cfg = loadConfig();
  const { authtoken, domain } = resolveNgrokCreds(cfg);

  if (!authtoken || !domain) {
    tuiEvents.emit("error", "Missing ngrok credentials. Run /logout and set up again.");
    return;
  }

  tuiEvents.emit("result", "Starting public MCP tunnel…");
  const { mcpUrl } = await startPublicTunnel({ port, authtoken, domain });
  client.setMcpUrl(mcpUrl);

  if (cfg.mcpSetupComplete && cfg.mcpUrl === mcpUrl) {
    client.setConnected(true);
    tuiEvents.emit("result", "MCP ready (already done)");
  } else {
    if (cfg.mcpUrl && cfg.mcpUrl !== mcpUrl) {
      tuiEvents.emit("result", "MCP URL changed — update Integrations, then /mcp done");
    }
    showMcpSetup(mcpUrl);
  }
}

async function main() {
  fetchUserName().then((name) => {
    if (name) tuiEvents.emit("user-name", name);
  });

  try {
    createMcpServer();
    const { port } = await startMcpHttpServer(0, MCP_TOKEN);

    if (AUTH_MODE === "login") {
      await bootLoginMode(port);
    } else {
      await bootApiKeyMode(port);
    }
  } catch (err) {
    tuiEvents.emit("error", err.message);
    tuiEvents.emit("result", "Replies may arrive in your messaging app instead.");
  }
}

main();
