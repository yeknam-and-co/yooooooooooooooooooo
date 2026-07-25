import { Poke, PokeTunnel, getToken } from "poke";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { loadConfig, updateConfig } from "./config.js";

const REPLY_INSTRUCTION =
  "[TERMINAL SESSION — MANDATORY]\n" +
  "The user is in a TERMINAL-ONLY session. This is non-negotiable.\n" +
  "DO NOT reply via iMessage. DO NOT reply via SMS. DO NOT reply via Telegram.\n" +
  "DO NOT write ANY text in your chat response. Leave it completely empty.\n" +
  "Your ONLY action is to call the reply_to_terminal tool with your full answer.\n" +
  "If you write anything in the chat message, the user will receive a duplicate and be confused.\n" +
  "ONLY call reply_to_terminal. NOTHING else. No chat message. Zero words in chat.\n" +
  "[END TERMINAL SESSION]\n\n";

const TERMINAL_WEBHOOK_CONDITION =
  "When a message arrives from poke-tui terminal (source=poke-tui)";

const TERMINAL_WEBHOOK_ACTION =
  "The user is chatting from their TERMINAL ONLY (poke-tui). " +
  "Read `message` from the webhook payload. " +
  "Respond ONLY by calling the reply_to_terminal MCP tool with your full answer. " +
  "DO NOT reply via iMessage, SMS, Telegram, or any chat text. " +
  "Leave the chat/message reply completely empty. " +
  "ONLY call reply_to_terminal — nothing else.";

const CONFIG_DIR = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
const STATE_PATH = join(CONFIG_DIR, "poke-tui", "state.json");

function loadState() {
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function saveState(state) {
  mkdirSync(join(CONFIG_DIR, "poke-tui"), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

export class PokeClient {
  constructor({ apiKey, authMode = "api-key", onEvent }) {
    this.apiKey = apiKey;
    this.authMode = authMode; // "login" | "api-key"
    this.onEvent = onEvent || (() => {});
    this.poke = null;
    this.mcpUrl = null;
    this.localMcpUrl = null;
    this.connected = false;
    this.webhooks = [];
    this.terminalWebhook = null;
    this.tunnel = null;
    this.tunnelInfo = null;
  }

  async init(mcpPort) {
    this.poke = new Poke({ apiKey: this.apiKey });
    this.localMcpUrl = `http://localhost:${mcpPort}/mcp`;
    this.onEvent("status", "SDK initialized");
  }

  setMcpUrl(url) {
    this.mcpUrl = url;
  }

  setConnected(connected) {
    this.connected = connected;
    this.onEvent(connected ? "mcp-connected" : "mcp-disconnected");
  }

  async cleanupOldConnection() {
    const state = loadState();
    if (!state.connectionId) return;
    const token = getToken() || this.apiKey;
    const base = process.env.POKE_API ?? "https://poke.com/api/v1";
    try {
      await fetch(`${base}/mcp/connections/${state.connectionId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch {}
  }

  /** Official Poke tunnel (requires poke login session). */
  async startPokeTunnel() {
    const token = getToken() || this.apiKey;
    if (!token) {
      throw new Error("Not logged in. Run poke login or choose API key mode.");
    }

    await this.cleanupOldConnection();

    this.tunnel = new PokeTunnel({
      url: this.localMcpUrl,
      name: "Poke TUI Terminal",
      token,
      cleanupOnStop: false,
    });

    this.tunnel.on("connected", (info) => {
      this.tunnelInfo = info;
      this.mcpUrl = info.tunnelUrl || this.localMcpUrl;
      saveState({ connectionId: info.connectionId });
      this.setConnected(true);
      this.onEvent("tunnel-connected", info);
    });

    this.tunnel.on("disconnected", () => {
      this.tunnelInfo = null;
      this.setConnected(false);
      this.onEvent("tunnel-disconnected");
    });

    this.tunnel.on("error", (err) => {
      this.onEvent("tunnel-error", err.message);
    });

    const info = await this.tunnel.start();
    return info;
  }

  async ensureTerminalWebhook() {
    if (!this.poke) throw new Error("SDK not initialized");

    const cfg = loadConfig();
    const saved = cfg.terminalWebhook;
    if (saved?.webhookUrl && saved?.webhookToken) {
      this.terminalWebhook = saved;
      return saved;
    }

    const webhook = await this.poke.createWebhook({
      condition: TERMINAL_WEBHOOK_CONDITION,
      action: TERMINAL_WEBHOOK_ACTION,
    });

    const stored = {
      triggerId: webhook.triggerId,
      webhookUrl: webhook.webhookUrl,
      webhookToken: webhook.webhookToken,
    };

    updateConfig({ terminalWebhook: stored });
    this.terminalWebhook = stored;
    return stored;
  }

  /** Chat: webhook for api-key mode, sendMessage for login mode. */
  async sendChat(text) {
    if (!this.poke) throw new Error("SDK not initialized");

    if (this.authMode === "login") {
      return this.poke.sendMessage(REPLY_INSTRUCTION + text);
    }

    if (!this.terminalWebhook) {
      await this.ensureTerminalWebhook();
    }

    return this.poke.sendWebhook({
      webhookUrl: this.terminalWebhook.webhookUrl,
      webhookToken: this.terminalWebhook.webhookToken,
      data: {
        source: "poke-tui",
        channel: "terminal",
        message: text,
      },
    });
  }

  async createWebhook({ condition, action }) {
    if (!this.poke) throw new Error("SDK not initialized");
    const webhook = await this.poke.createWebhook({
      condition,
      action:
        action +
        " [TERMINAL SESSION: Call reply_to_terminal with your full answer. DO NOT write any chat message. Leave chat reply empty. ONLY use the tool.]",
    });
    this.webhooks.push(webhook);
    return webhook;
  }

  async fireWebhook(index, data) {
    const webhook = this.webhooks[index];
    if (!webhook) throw new Error(`No webhook at index ${index}`);
    return this.poke.sendWebhook({
      webhookUrl: webhook.webhookUrl,
      webhookToken: webhook.webhookToken,
      data,
    });
  }

  async stop() {
    if (this.tunnel) {
      try {
        await this.tunnel.stop();
      } catch {}
      this.tunnel = null;
    }
    this.connected = false;
    this.mcpUrl = null;
  }
}
