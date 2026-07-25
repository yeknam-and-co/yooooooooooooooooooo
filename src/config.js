import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

const CONFIG_DIR = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
export const CONFIG_DIR_PATH = join(CONFIG_DIR, "poke-tui");
export const CONFIG_PATH = join(CONFIG_DIR_PATH, "config.json");

export function loadConfig() {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    return {};
  }
}

export function saveConfig(config) {
  mkdirSync(CONFIG_DIR_PATH, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

export function updateConfig(patch) {
  const next = { ...loadConfig(), ...patch };
  saveConfig(next);
  return next;
}

/** Wipe all poke-tui config (logout). */
export function clearConfig() {
  if (!existsSync(CONFIG_DIR_PATH)) return;
  rmSync(CONFIG_DIR_PATH, { recursive: true, force: true });
}

export function resolveNgrokCreds(config = loadConfig()) {
  const authtoken =
    process.env.NGROK_AUTHTOKEN || config.ngrokAuthToken || null;
  const domain = process.env.NGROK_DOMAIN || config.ngrokDomain || null;
  return { authtoken, domain };
}

export function integrationsUrl(mcpUrl, apiKey) {
  const params = new URLSearchParams({
    name: "Poke TUI Terminal",
    url: mcpUrl,
  });
  // ponytail: `apiKey` is the field name the poke CLI posts to /mcp/connections/cli.
  // Undocumented as a web query param — harmless if ignored, paste it manually then.
  if (apiKey) params.set("apiKey", apiKey);
  return `https://poke.com/integrations/new?${params.toString()}`;
}

/**
 * Sticky bearer token Poke must present to our MCP server.
 * Stable across launches so the integration keeps working; generating a new
 * one clears mcpSetupComplete because the integration must be re-added.
 */
export function ensureMcpToken() {
  const cfg = loadConfig();
  if (cfg.mcpToken) return cfg.mcpToken;
  const token = randomBytes(24).toString("hex");
  updateConfig({ mcpToken: token, mcpSetupComplete: false });
  return token;
}

/** OSC 8 terminal hyperlink — clickable in Windows Terminal, iTerm, etc. */
export function hyperlink(url, label) {
  return `\u001B]8;;${url}\u0007${label}\u001B]8;;\u0007`;
}

/** Open a URL in the default browser (best-effort). */
export function openInBrowser(url) {
  try {
    if (process.platform === "win32") {
      spawn("cmd", ["/c", "start", "", url], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      }).unref();
    } else if (process.platform === "darwin") {
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    }
    return true;
  } catch {
    return false;
  }
}
