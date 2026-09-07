import crypto from "node:crypto";
import type { OAuthPageKind } from "./oauth-session.js";

export function renderOAuthCallbackPage(
  kind: OAuthPageKind,
  retryPath?: string,
  surface: "cli" | "mcp" = "cli",
): string {
  const desktop = surface === "mcp";
  const clientLabel = desktop ? "MCP" : "CLI";
  const success = kind === "success";
  const waiting = kind === "waiting";
  const status = success ? "success" : waiting ? "waiting" : "error";
  const title = success
    ? "Authorization complete"
    : kind === "cancelled"
      ? "Sign-in cancelled"
      : waiting
        ? "Waiting for sign-in"
        : "Authorization failed";
  const heading = success
    ? "You're connected"
    : kind === "cancelled"
      ? "Sign-in cancelled"
      : waiting
        ? "Finish signing in"
        : kind === "timeout"
          ? "Sign-in timed out"
          : kind === "invalid"
            ? "This sign-in link is no longer valid"
            : "Sign-in wasn't completed";
  const cliDescription = success
    ? "Cobalt CLI is connected. You can close this window and return to your terminal."
    : kind === "cancelled"
      ? "You cancelled authorization. No access was granted to the CLI. Try again, or sign in with a different account."
      : waiting
        ? retryPath
          ? "Complete authorization in your browser. If you closed the page or chose the wrong account, you can restart below."
          : "Finishing sign-in and saving your credentials securely. Please wait, or press Ctrl+C in your terminal to stop."
        : kind === "invalid"
          ? "This response does not match the active sign-in attempt. Your CLI is still waiting. Start a fresh attempt below."
          : kind === "timeout"
            ? "This sign-in attempt expired. Your CLI is still running and ready for a fresh attempt."
            : "We couldn't finish signing you in. No new credentials were saved. Try again without restarting the CLI.";
  const description = desktop
    ? success
      ? "Cobalt MCP is connected. You can close this window and return to your desktop app."
      : kind === "cancelled"
        ? "You cancelled authorization. Return to your desktop app to try again."
        : waiting
          ? "Complete authorization in your browser, then return to your desktop app."
          : kind === "timeout"
            ? "This sign-in attempt expired. Start a fresh connection from your desktop app."
            : "This sign-in attempt could not be completed. Return to your desktop app to reconnect."
    : cliDescription;
  const command = desktop
    ? "Return to your desktop app"
    : success
      ? "cobalt auth status"
      : retryPath
        ? "Press Enter in your terminal to retry"
        : waiting
          ? "Finishing sign-in…"
          : "cobalt auth login";
  const statusLabel = success
    ? "Secure authorization complete"
    : waiting
      ? "Waiting for secure authorization"
      : "Authorization needs attention";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark light">
  <title>${title} · Cobalt ${clientLabel}</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #09090b;
      --panel: #18181b;
      --panel-elevated: #1f1f23;
      --border: #27272a;
      --text: #d4d4d8;
      --text-muted: #a1a1aa;
      --text-bright: #fafafa;
      --accent: #22d3ee;
      --accent-hover: #06b6d4;
      --accent-contrast: #083344;
      --success: #22c55e;
      --error: #ef4444;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
    }

    * { box-sizing: border-box; }

    body {
      min-height: 100vh;
      margin: 0;
      display: grid;
      place-items: center;
      padding: 24px;
      overflow-x: hidden;
      background:
        radial-gradient(circle at 12% 5%, rgb(34 211 238 / 18%), transparent 34%),
        radial-gradient(circle at 88% 18%, rgb(56 189 248 / 15%), transparent 31%),
        var(--bg);
      color: var(--text);
      font-size: 14px;
      line-height: 1.6;
      text-rendering: optimizeLegibility;
    }

    .glow {
      position: fixed;
      width: 340px;
      height: 340px;
      border-radius: 999px;
      background: rgb(34 211 238 / 8%);
      filter: blur(72px);
      pointer-events: none;
    }

    .glow-one { top: -180px; left: -120px; }
    .glow-two { right: -180px; bottom: -220px; }

    .card {
      position: relative;
      width: min(100%, 480px);
      overflow: hidden;
      border: 1px solid var(--border);
      border-radius: 12px;
      background: rgb(24 24 27 / 92%);
      box-shadow: 0 24px 72px rgb(0 0 0 / 42%);
      backdrop-filter: blur(18px);
    }

    .accent-line {
      height: 2px;
      background: linear-gradient(90deg, transparent, var(--accent), transparent);
    }

    .content { padding: 32px; }

    .brand {
      display: flex;
      align-items: center;
      gap: 11px;
      margin-bottom: 34px;
      color: var(--text-bright);
      font-size: 15px;
      font-weight: 650;
      letter-spacing: -0.01em;
    }

    .logo { width: 30px; height: 30px; flex: none; }

    .cli-label {
      margin-left: 2px;
      padding-left: 11px;
      border-left: 1px solid var(--border);
      color: var(--text-muted);
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 12px;
      font-weight: 500;
    }

    .status-icon {
      display: grid;
      width: 48px;
      height: 48px;
      place-items: center;
      margin-bottom: 22px;
      border: 1px solid var(--border);
      border: 1px solid color-mix(in srgb, var(--status-color) 32%, transparent);
      border-radius: 12px;
      background: var(--panel-elevated);
      background: color-mix(in srgb, var(--status-color) 12%, transparent);
      color: var(--status-color);
      box-shadow: 0 0 32px color-mix(in srgb, var(--status-color) 12%, transparent);
    }

    [data-status="success"] { --status-color: var(--success); }
    [data-status="waiting"] { --status-color: var(--accent); }
    [data-status="error"] { --status-color: var(--error); }

    h1 {
      margin: 0 0 10px;
      color: var(--text-bright);
      font-size: clamp(24px, 7vw, 30px);
      line-height: 1.2;
      letter-spacing: -0.035em;
    }

    .description { margin: 0; color: var(--text-muted); }

    .terminal {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-top: 27px;
      padding: 12px 14px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--bg);
      color: var(--text);
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 12px;
      overflow-wrap: anywhere;
    }

    .prompt { color: var(--accent); user-select: none; }

    .actions { display: grid; gap: 10px; margin-top: 24px; }
    .actions form { margin: 0; }
    .actions button {
      width: 100%; min-height: 44px; padding: 10px 16px;
      border: 1px solid var(--accent); border-radius: 8px;
      background: var(--accent); color: var(--accent-contrast);
      font: inherit; font-weight: 650; cursor: pointer;
    }
    .actions button:hover { background: var(--accent-hover); }
    .actions .secondary { color: var(--text-bright); background: transparent; border-color: var(--border); }
    .actions .secondary:hover { background: var(--panel-elevated); }
    .actions button:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
    .hint { color: var(--text-muted); font-size: 12px; margin: 12px 0 0; }

    .footer {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-top: 27px;
      padding-top: 20px;
      border-top: 1px solid var(--border);
      color: var(--text-muted);
      font-size: 12px;
    }

    .status-dot {
      width: 7px;
      height: 7px;
      flex: none;
      border-radius: 999px;
      background: var(--status-color);
      box-shadow: 0 0 10px color-mix(in srgb, var(--status-color) 70%, transparent);
    }

    @media (prefers-color-scheme: light) {
      :root {
        color-scheme: light;
        --bg: #f8fafc;
        --panel: #ffffff;
        --panel-elevated: #ffffff;
        --border: #cbd5e1;
        --text: #0f172a;
        --text-muted: #475569;
        --text-bright: #020617;
        --success: #15803d;
        --error: #b91c1c;
      }

      body {
        background:
          radial-gradient(circle at 12% 5%, rgb(34 211 238 / 17%), transparent 34%),
          radial-gradient(circle at 88% 18%, rgb(56 189 248 / 12%), transparent 31%),
          var(--bg);
      }

      .card {
        background: rgb(255 255 255 / 94%);
        box-shadow: 0 24px 72px rgb(15 23 42 / 14%);
      }

      .terminal { background: #f1f5f9; }
    }

    @media (max-width: 520px) {
      body { padding: 16px; }
      .content { padding: 26px 22px; }
      .brand { margin-bottom: 28px; }
    }

    @media (prefers-reduced-motion: no-preference) {
      .card { animation: arrive 360ms ease-out both; }
      .status-icon { animation: settle 420ms 100ms ease-out both; }

      @keyframes arrive {
        from { opacity: 0; transform: translateY(10px) scale(0.985); }
        to { opacity: 1; transform: translateY(0) scale(1); }
      }

      @keyframes settle {
        from { opacity: 0; transform: scale(0.82); }
        to { opacity: 1; transform: scale(1); }
      }
    }
  </style>
</head>
<body data-status="${status}">
  <div class="glow glow-one" aria-hidden="true"></div>
  <div class="glow glow-two" aria-hidden="true"></div>
  <main class="card" aria-labelledby="page-title" role="${success || waiting ? "status" : "alert"}">
    <div class="accent-line" aria-hidden="true"></div>
    <div class="content">
      <header class="brand">
        <svg class="logo" viewBox="0 0 49 48" role="img" aria-label="Cobalt">
          <path d="M1.984 29.29a17.21 17.21 0 0 1 17.21-17.21v17.21H1.984Z" fill="#0f766e"/>
          <path d="M1.984 29.29A17.21 17.21 0 0 0 19.194 46.5V29.29H1.984Z" fill="#14b8a6"/>
          <path d="M36.404 29.29A17.21 17.21 0 0 1 19.194 46.5V29.29h17.21Z" fill="#5eead4"/>
          <path d="M47.016 14.422a12.922 12.922 0 0 1-12.922 12.922H21.172V14.422a12.922 12.922 0 1 1 25.844 0Z" fill="#22d3ee"/>
        </svg>
        <span>Cobalt</span>
        <span class="cli-label">${clientLabel}</span>
      </header>

      <div class="status-icon" aria-hidden="true">
        ${
          success
            ? '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 4 4L19 6"/></svg>'
            : '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round"><path d="M12 8v5"/><path d="M12 17.01v.01"/><circle cx="12" cy="12" r="9"/></svg>'
        }
      </div>
      <h1 id="page-title">${heading}</h1>
      <p class="description">${description}</p>
${
  !success && retryPath
    ? `<div class="actions">
        <form action="${retryPath.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;")}" method="post"><button type="submit">Try again</button></form>
        <form action="${retryPath.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;")}?account=change" method="post"><button class="secondary" type="submit">Use another account</button></form>
      </div><p class="hint">Using another account signs you out of Cobalt in this browser. ${desktop ? "Keep your desktop app open while reconnecting." : "Keep the CLI open; press Enter there to retry, or Ctrl+C to stop."}</p>`
    : ""
}

      <div class="terminal" aria-label="${desktop ? "Desktop app guidance" : "Terminal guidance"}">
        <span class="prompt" aria-hidden="true">${!desktop && (success || (!retryPath && !waiting)) ? "$" : "›"}</span>
        <span>${command}</span>
      </div>

      <footer class="footer">
        <span class="status-dot" aria-hidden="true"></span>
        <span>${statusLabel}</span>
      </footer>
    </div>
  </main>
</body>
</html>`;
}

export const oauthCallbackResponseHeaders = Object.freeze({
  "cache-control": "no-store",
  "content-security-policy": `default-src 'none'; style-src 'sha256-${crypto
    .createHash("sha256")
    .update(
      renderOAuthCallbackPage("success").match(
        /<style>([\s\S]*?)<\/style>/,
      )![1]!,
    )
    .digest(
      "base64",
    )}'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
  "content-type": "text/html; charset=utf-8",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
});
