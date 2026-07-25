#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import {
  loadConfig,
  saveConfig,
  resolveNgrokCreds,
  hyperlink,
  openInBrowser,
} from "../src/config.js";

const INDENT = "  ";
const PREVIEW_CHARS = 20;

function loadPokeCreds() {
  try {
    const configDir = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
    const creds = JSON.parse(
      readFileSync(join(configDir, "poke", "credentials.json"), "utf-8")
    );
    if (creds.token) return creds.token;
  } catch {}
  return null;
}

function clearScreen() {
  process.stdout.write("\x1B[2J\x1B[3J\x1B[H");
}

function termSize() {
  return {
    cols: process.stdout.columns || 80,
    rows: process.stdout.rows || 24,
  };
}

function printFrame(lines, { vertical = true } = {}) {
  const { rows } = termSize();
  const block = Array.isArray(lines) ? lines : [lines];
  if (vertical) {
    const topPad = Math.max(2, Math.floor((rows - block.length) / 2) - 1);
    for (let i = 0; i < topPad; i++) console.log();
  } else {
    console.log();
    console.log();
  }
  for (const line of block) {
    console.log(INDENT + line);
  }
}

function showFrame(lines) {
  clearScreen();
  printFrame(lines, { vertical: true });
  console.log();
}

function link(url, label = "Click here") {
  return hyperlink(url, label);
}

function linkHint() {
  return 'Type "link" if you can\'t click, then copy/paste the URL.';
}

/** Print plain URL for terminals without OSC 8 hyperlinks; try opening browser. */
function revealLink(url) {
  console.log();
  console.log(INDENT + "Open this URL (copy/paste):");
  console.log(INDENT + url);
  console.log();
  openInBrowser(url);
}

function maskSecret(value, preview = PREVIEW_CHARS) {
  if (!value) return "";
  if (value.length <= preview) return value;
  return value.slice(0, preview) + "...";
}

function ask(question, { linkUrl } = {}) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    const prompt = () => {
      rl.question(INDENT + question, (answer) => {
        const trimmed = answer.trim();
        if (linkUrl && trimmed.toLowerCase() === "link") {
          revealLink(linkUrl);
          prompt();
          return;
        }
        rl.close();
        resolve(trimmed);
      });
    };
    prompt();
  });
}

function askSecret(question, { preview = PREVIEW_CHARS, linkUrl } = {}) {
  const stdin = process.stdin;
  const stdout = process.stdout;

  return new Promise((resolve) => {
    let value = "";
    const prompt = INDENT + question;

    const redraw = () => {
      stdout.write("\r\x1B[2K");
      stdout.write(prompt + maskSecret(value, preview));
    };

    stdout.write(prompt);

    if (typeof stdin.setRawMode === "function") {
      stdin.setRawMode(true);
    }
    stdin.resume();
    stdin.setEncoding("utf8");

    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          const trimmed = value.trim();
          if (linkUrl && trimmed.toLowerCase() === "link") {
            value = "";
            stdout.write("\n");
            revealLink(linkUrl);
            redraw();
            continue;
          }
          cleanup();
          stdout.write("\n");
          resolve(trimmed);
          return;
        }
        if (ch === "\u0003") {
          cleanup();
          stdout.write("\n");
          process.exit(1);
        }
        if (ch === "\u007f" || ch === "\b") {
          value = value.slice(0, -1);
          redraw();
          continue;
        }
        if (ch < " " && ch !== "\t") continue;
        value += ch;
      }
      redraw();
    };

    function cleanup() {
      stdin.off("data", onData);
      if (typeof stdin.setRawMode === "function") {
        stdin.setRawMode(false);
      }
      stdin.pause();
    }

    stdin.on("data", onData);
  });
}

async function chooseAuthMode(config) {
  if (config.authMode === "login" || config.authMode === "api-key") {
    return config.authMode;
  }

  showFrame([
    "🌴  Welcome to Poke TUI",
    "",
    "your AI assistant in the terminal",
    "by Interaction Company of California",
    "",
    "────────────────────────────",
    "",
    "How do you want to connect?",
    "",
    "  1. poke login",
    "     Official Poke tunnel via browser login",
    "",
    "  2. API key + ngrok",
    "     Kitchen API key (bypasses Poke tunnel;",
    "     needs ngrok for a public MCP URL)",
    "",
  ]);

  const choice = await ask("Choice [1/2]: ");
  if (choice === "1") return "login";
  if (choice === "2") return "api-key";

  console.error(INDENT + "error: pick 1 or 2");
  process.exit(1);
}

async function ensureLogin() {
  const { login, getToken, isLoggedIn } = await import("poke");

  if (isLoggedIn() && getToken()) {
    return getToken();
  }

  const existing = loadPokeCreds();
  if (existing) return existing;

  showFrame([
    "🌴  poke login",
    "",
    "────────────────────────────",
    "",
    "A browser window will open so you can",
    "sign in to Poke (device code login).",
    "",
  ]);

  await ask("Press Enter to continue…");
  clearScreen();
  printFrame(["Opening browser for poke login…"], { vertical: true });

  const result = await login({ openBrowser: true });
  return result.token;
}

async function ensureApiKey(config) {
  if (process.env.POKE_API_KEY) return process.env.POKE_API_KEY;
  if (config.apiKey) return config.apiKey;

  const apiKeysUrl = "https://poke.com/kitchen/api-keys";
  showFrame([
    "🌴  Welcome to Poke TUI",
    "",
    "────────────────────────────",
    "",
    "API key",
    "",
    "This lets poke-tui talk to your agent.",
    `${link(apiKeysUrl, "Click here")} to create an API key`,
    "(or Ctrl+click), then paste it below.",
    linkHint(),
    "",
  ]);

  const key = await askSecret("API key: ", { linkUrl: apiKeysUrl });
  if (!key) {
    showFrame([
      "No API key provided.",
      "",
      `${link(apiKeysUrl, "Click here")} to create one`,
      "(or Ctrl+click), then run poke-tui again.",
      linkHint(),
    ]);
    process.exit(1);
  }
  return key;
}

async function ensureNgrok(config) {
  const existing = resolveNgrokCreds(config);
  let authtoken = existing.authtoken;
  let domain = existing.domain;

  if (authtoken && domain) {
    return {
      authtoken,
      domain: domain.replace(/^https?:\/\//, "").replace(/\/$/, ""),
    };
  }

  if (!authtoken) {
    const tokenUrl = "https://dashboard.ngrok.com/get-started/your-authtoken";
    showFrame([
      "🌴  Welcome to Poke TUI",
      "",
      "────────────────────────────",
      "",
      "ngrok authtoken",
      "",
      "Needed for a sticky public MCP URL.",
      "",
      `${link(tokenUrl, "Click here")} for your authtoken`,
      "(or Ctrl+click), then paste it below.",
      linkHint(),
      "",
    ]);

    authtoken = await askSecret("ngrok authtoken: ", { linkUrl: tokenUrl });
  }

  if (!domain) {
    const domainsUrl = "https://dashboard.ngrok.com/domains";
    showFrame([
      "🌴  Welcome to Poke TUI",
      "",
      "────────────────────────────",
      "",
      "ngrok static domain",
      "",
      "Claim a free static domain so the MCP URL",
      "stays the same every launch.",
      "",
      `${link(domainsUrl, "Click here")} to claim a domain`,
      "(or Ctrl+click), then paste the hostname below",
      "(e.g. your-name.ngrok-free.dev).",
      linkHint(),
      "",
    ]);

    domain = await ask("ngrok domain: ", { linkUrl: domainsUrl });
  }

  if (!authtoken || !domain) {
    showFrame([
      "Both ngrok authtoken and domain are required.",
      "",
      "Run poke-tui again when you have them.",
    ]);
    process.exit(1);
  }

  return {
    authtoken,
    domain: domain.replace(/^https?:\/\//, "").replace(/\/$/, ""),
  };
}

async function main() {
  const config = loadConfig();
  clearScreen();

  const authMode = await chooseAuthMode(config);
  const next = { ...config, authMode };
  let token;

  if (authMode === "login") {
    token = await ensureLogin();
    next.apiKey = undefined; // login uses poke credentials
  } else {
    token = await ensureApiKey(config);
    if (!process.env.POKE_API_KEY) next.apiKey = token;

    const ngrok = await ensureNgrok(config);
    if (!process.env.NGROK_AUTHTOKEN) next.ngrokAuthToken = ngrok.authtoken;
    if (!process.env.NGROK_DOMAIN) next.ngrokDomain = ngrok.domain;
    if (!process.env.NGROK_AUTHTOKEN) process.env.NGROK_AUTHTOKEN = ngrok.authtoken;
    if (!process.env.NGROK_DOMAIN) process.env.NGROK_DOMAIN = ngrok.domain;
  }

  saveConfig(next);
  process.env.POKE_API_KEY = token;
  process.env.POKE_TUI_AUTH_MODE = authMode;

  clearScreen();
  printFrame(["Saved. Starting Poke TUI…"], { vertical: true });
  await new Promise((r) => setTimeout(r, 400));
  clearScreen();

  await import("../src/app.js");
}

main().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});
