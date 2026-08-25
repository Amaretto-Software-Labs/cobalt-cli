import { readFileSync } from "node:fs";

export function packageVersion(): string {
  try {
    return (
      JSON.parse(
        readFileSync(new URL("../package.json", import.meta.url), "utf8"),
      ) as { version: string }
    ).version;
  } catch {
    return "0.0.0";
  }
}
