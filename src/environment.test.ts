import { describe, expect, it } from "vitest";
import { resolveEnvironment } from "./environment.js";

describe("resolveEnvironment", () => {
  it("resolves the standard local Aspire endpoints with the development OAuth client", () => {
    const environment = resolveEnvironment("local");

    expect(environment).toMatchObject({
      name: "local",
      clientId: "cobalt-cli-dev",
    });
    expect(environment.apiBase.href).toBe("https://localhost:7295/v1");
    expect(environment.oauthResource.href).toBe("https://localhost:7295/");
    expect(environment.identityIssuer.href).toBe("https://localhost:7270/");
    expect(environment.webFrontend.href).toBe("https://localhost:7250/");
  });
});
