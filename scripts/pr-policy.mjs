#!/usr/bin/env node
// What a pull request may touch (D5a, single-entry PR CI). Reads the files the
// PR changes against its base and refuses:
//   - an entry that is not under entries/<area>/<id>.json,
//   - a community-tier entry changed together with anything else that is an
//     entry, a script, a workflow or a key: an outside contribution is one
//     entry (and, if it needs one, its starter set), nothing that changes how
//     the registry is checked or signed,
//   - a community-tier PR that edits the check scripts or workflows at all.
// Maintainer and curator PRs (tier official) may touch several entries.
// It prints the changed entry files, one per line, for the workflow to hand to
// validate.mjs --entry.
//
// Run: node scripts/pr-policy.mjs BASE_SHA [HEAD_SHA]   (default HEAD)

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { root } from "./tree.mjs";

const entryRe = /^entries\/[a-z0-9-]+\/[a-z0-9][a-z0-9-]{0,39}\.json$/;
const guarded = /^(scripts\/|\.github\/|keys\/|\.gitignore$|package(-lock)?\.json$)/;

// changes: [{ status: "A"|"M"|"D"|"R", path }], tierOf(path) → "official"|"community"|"".
export function policy(changes, tierOf) {
  const problems = [];
  const entries = changes.filter((c) => c.path.startsWith("entries/") && c.status !== "D");
  for (const c of changes) if (c.path.startsWith("entries/") && !entryRe.test(c.path)) problems.push(`${c.path}: entries live in entries/<area>/<id>.json`);
  const community = entries.filter((c) => entryRe.test(c.path) && tierOf(c.path) === "community");
  if (community.length) {
    if (entries.length > 1) problems.push(`a community entry (${community.map((c) => c.path).join(", ")}) is proposed alone: this pull request changes ${entries.length} entries`);
    const touched = changes.filter((c) => guarded.test(c.path));
    if (touched.length) problems.push(`a community entry's pull request does not change how the registry is checked or signed: ${touched.map((c) => c.path).join(", ")}`);
  }
  return { problems, entries: entries.filter((c) => entryRe.test(c.path)).map((c) => c.path) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [base, head = "HEAD"] = process.argv.slice(2);
  if (!/^[0-9a-f]{7,64}$/.test(base ?? "")) {
    console.error("usage: pr-policy.mjs BASE_SHA [HEAD_SHA]");
    process.exit(2);
  }
  const out = execFileSync("git", ["diff", "--name-status", "--no-renames", `${base}...${head}`], { cwd: root, encoding: "utf8" });
  const changes = out.split("\n").filter(Boolean).map((l) => {
    const [status, ...rest] = l.split("\t");
    return { status: status[0], path: rest.join("\t") };
  });
  const tierOf = (p) => {
    const abs = join(root, p);
    if (!existsSync(abs)) return "";
    try {
      return JSON.parse(readFileSync(abs, "utf8")).tier ?? "";
    } catch {
      return "";
    }
  };
  const { problems, entries } = policy(changes, tierOf);
  if (problems.length) {
    console.error(`${problems.length} problem(s):`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  for (const e of entries) console.log(e);
}
