#!/usr/bin/env node
/* global process, URL */
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const source = JSON.parse(
  await readFile(new URL("package.json", root), "utf8"),
);
const staged = JSON.parse(
  await readFile(new URL("release/npm/package/package.json", root), "utf8"),
);
const fields = [
  "name",
  "description",
  "license",
  "repository",
  "homepage",
  "bugs",
  "bin",
  "engines",
  "dependencies",
  "keywords",
];
const mismatches = fields.filter(
  (field) => JSON.stringify(source[field]) !== JSON.stringify(staged[field]),
);
if (mismatches.length) {
  process.stderr.write(
    `Packed npm metadata drifted for: ${mismatches.join(", ")}\n`,
  );
  process.exit(1);
}
process.stdout.write(
  "Packed npm metadata matches the public package manifest.\n",
);
