import ngrok from "@ngrok/ngrok";

let listener = null;

/**
 * Expose a local port via a sticky ngrok static domain.
 * @param {{ port: number, authtoken: string, domain: string }} opts
 * @returns {Promise<{ publicUrl: string, mcpUrl: string }>}
 */
export async function startPublicTunnel({ port, authtoken, domain }) {
  if (!authtoken) {
    throw new Error(
      "Missing ngrok authtoken. Set NGROK_AUTHTOKEN or add ngrokAuthToken to ~/.config/poke-tui/config.json"
    );
  }
  if (!domain) {
    throw new Error(
      "Missing ngrok domain. Set NGROK_DOMAIN or add ngrokDomain (your free static domain) to config."
    );
  }

  const cleanDomain = domain.replace(/^https?:\/\//, "").replace(/\/$/, "");

  if (listener) {
    await stopPublicTunnel();
  }

  listener = await ngrok.forward({
    addr: `127.0.0.1:${port}`,
    authtoken,
    domain: cleanDomain,
  });

  const publicUrl = listener.url().replace(/\/$/, "");
  const mcpUrl = `${publicUrl}/mcp`;

  return { publicUrl, mcpUrl };
}

export async function stopPublicTunnel() {
  if (!listener) return;
  try {
    await listener.close();
  } catch {}
  try {
    await ngrok.disconnect();
  } catch {}
  listener = null;
}

export function getPublicMcpUrl() {
  if (!listener) return null;
  return `${listener.url().replace(/\/$/, "")}/mcp`;
}
