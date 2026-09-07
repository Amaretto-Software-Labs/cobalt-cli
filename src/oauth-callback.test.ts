import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  oauthCallbackResponseHeaders,
  renderOAuthCallbackPage,
} from "./oauth-callback.js";

describe("shared OAuth callback pages", () => {
  it.each([
    "success",
    "cancelled",
    "waiting",
    "invalid",
    "timeout",
    "failed",
  ] as const)(
    "renders the MCP %s state with desktop guidance and valid CSP",
    (kind) => {
      const html = renderOAuthCallbackPage(kind, undefined, "mcp");
      expect(html).toContain("Cobalt MCP");
      expect(html).toContain("desktop app");
      expect(html).not.toContain("cobalt auth login");
      expect(html).not.toContain("cobalt auth status");
      expect(html).not.toContain("return to your terminal");
      expect(html).toContain(
        kind === "success"
          ? "You're connected"
          : kind === "waiting"
            ? "Finish signing in"
            : 'role="alert"',
      );
      const style = html.match(/<style>([\s\S]*?)<\/style>/)![1]!;
      const hash = createHash("sha256").update(style).digest("base64");
      expect(oauthCallbackResponseHeaders["content-security-policy"]).toContain(
        `style-src 'sha256-${hash}'`,
      );
      expect(oauthCallbackResponseHeaders["cache-control"]).toBe("no-store");
    },
  );
  it("keeps CLI success guidance in the default surface", () => {
    const html = renderOAuthCallbackPage("success");
    expect(html).toContain("return to your terminal");
    expect(html).toContain("cobalt auth status");
  });
});
