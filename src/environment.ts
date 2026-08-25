import { UsageError } from "./errors.js";

export interface CobaltEnvironment {
  name: "prod" | "dev" | "demo";
  apiBase: URL;
  oauthResource: URL;
  identityIssuer: URL;
  webFrontend: URL;
  clientId: string;
}

function create(
  name: CobaltEnvironment["name"],
  api: string,
  issuer: string,
  frontend: string,
): CobaltEnvironment {
  const apiBase = new URL(api);
  return {
    name,
    apiBase,
    oauthResource: new URL(apiBase.origin),
    identityIssuer: new URL(issuer),
    webFrontend: new URL(frontend),
    clientId: `cobalt-cli-${name}`,
  };
}

export const environments: readonly CobaltEnvironment[] = [
  create(
    "prod",
    "https://api.cobaltcode.ai/v1",
    "https://identity.cobaltcode.ai",
    "https://app.cobaltcode.ai",
  ),
  create(
    "dev",
    "https://api-dev.cobaltcode.ai/v1",
    "https://identity-dev.cobaltcode.ai",
    "https://app-dev.cobaltcode.ai",
  ),
  create(
    "demo",
    "https://cobalt-api.vasoftware.co.uk/v1",
    "https://cobalt-identity.vasoftware.co.uk",
    "https://cobalt.vasoftware.co.uk",
  ),
];

export function resolveEnvironment(value?: string): CobaltEnvironment {
  if (value !== undefined && value.trim() !== value)
    throw new UsageError(
      "Environment must not contain surrounding whitespace.",
    );
  const name = value ?? "prod";
  const result = environments.find((item) => item.name === name.toLowerCase());
  if (!result)
    throw new UsageError("Environment must be one of: prod, dev, demo.");
  return result;
}
