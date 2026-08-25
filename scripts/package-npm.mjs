#!/usr/bin/env node
/* global process */
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = JSON.parse(
  readFileSync(path.join(root, "package.json"), "utf8"),
);
const version = (
  process.env.COBALT_CLI_PACKAGE_VERSION || source.version
).trim();
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version))
  throw new Error(`Invalid package version '${version}'.`);
if (!existsSync(path.join(root, "dist", "main.js")))
  throw new Error("dist/main.js does not exist. Run pnpm build first.");

const release = path.join(root, "release", "npm");
const stage = path.join(release, "package");
rmSync(release, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
for (const entry of ["dist", "openapi", "README.md", "LICENSE"])
  cpSync(path.join(root, entry), path.join(stage, entry), { recursive: true });
const runtime = {
  name: source.name,
  version,
  description: source.description,
  license: source.license,
  type: source.type,
  repository: source.repository,
  homepage: source.homepage,
  bugs: source.bugs,
  bin: source.bin,
  engines: source.engines,
  dependencies: source.dependencies,
  keywords: source.keywords,
  publishConfig: { access: "public" },
};
writeFileSync(
  path.join(stage, "package.json"),
  `${JSON.stringify(runtime, null, 2)}\n`,
);
const packed = spawnSync(
  "npm",
  ["pack", "--json", "--pack-destination", release],
  { cwd: stage, encoding: "utf8" },
);
if (packed.status !== 0) {
  process.stderr.write(packed.stderr);
  process.stderr.write(packed.stdout);
  process.exit(packed.status ?? 1);
}
const metadata = JSON.parse(packed.stdout)[0];
writeFileSync(
  path.join(release, "package-metadata.json"),
  `${JSON.stringify({ name: source.name, version, filename: metadata.filename }, null, 2)}\n`,
);
process.stdout.write(
  `Packed ${source.name}@${version} -> ${metadata.filename}\n`,
);
