#!/usr/bin/env node
import { ConfigStore } from "./config.js";
import { PlatformCredentialStore } from "./credential-store.js";
import { ExitCode } from "./errors.js";
import { runProgram } from "./program.js";
import { Runtime } from "./runtime.js";

try {
  const args = process.argv.slice(2);
  if (args.length === 0 && !process.stdin.isTTY) {
    process.stderr.write(
      "cobalt: a command is required when input is redirected.\n",
    );
    process.exitCode = ExitCode.usage;
  } else {
    if (args.length === 0) args.push("interactive");
    const runtime = new Runtime(
      new ConfigStore(),
      new PlatformCredentialStore(),
    );
    process.exitCode = await runProgram(runtime, args);
  }
} catch (error) {
  process.stderr.write(
    `cobalt: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = ExitCode.failure;
}
