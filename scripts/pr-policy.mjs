#!/usr/bin/env node
// What a pull request may touch (D5a, single-entry PR CI). Reads the files the
// PR changes against its base and refuses (the workflow runs this file from the
// BASE commit, so a pull request cannot edit its own judge):
//   - an entry that is not under entries/<area>/<id>.json,
//   - an outside contribution, which is a pull request from a fork (only
//     someone with write access can open one from a branch of this repository;
//     GitHub's author_association is not used because it reads CONTRIBUTOR for
//     a private organization member), or any PR that adds a community-tier
//     entry: it is ONE entry file (no second entry, no deletion), at most one
//     new starter set, and nothing that changes how the registry is checked
//     or signed (scripts, workflows, keys); an outside author's entry must say
//     tier "community", never "official" or nothing.
// Maintainer and curator PRs may touch several entries.
// It prints the changed entry files, one per line, for the workflow to hand to
// validate.mjs --entry.
//
// Run: node scripts/pr-policy.mjs BASE_SHA [HEAD_SHA] [fork]

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { root } from "./tree.mjs";

const entryRe = /^entries\/[a-z0-9-]+\/[a-z0-9][a-z0-9-]{0,39}\.json$/;
const guarded = /^(scripts\/|\.github\/|keys\/|\.gitignore$|package(-lock)?\.json$)/;

// changes: [{ status: "A"|"M"|"D"|"R", path }], tierOf(path) → the head file's tier,
// outside: the pull request comes from a fork.
export function policy(changes, tierOf, outside = false) {
  const problems = [];
  const entries = changes.filter((c) => c.path.startsWith("entries/") && c.status !== "D");
  for (const c of changes) if (c.path.startsWith("entries/") && !entryRe.test(c.path)) problems.push(`${c.path}: entries live in entries/<area>/<id>.json`);
  const community = entries.filter((c) => entryRe.test(c.path) && tierOf(c.path) === "community");
  if (outside) for (const c of entries) if (tierOf(c.path) !== "community") problems.push(`${c.path}: an outside contribution says tier "community"`);
  if (outside || community.length) {
    const entryChanges = changes.filter((c) => c.path.startsWith("entries/"));
    if (entryChanges.length > 1) problems.push(`an outside or community entry is proposed alone: this pull request changes ${entryChanges.length} entry files (deletions count)`);
    const bundles = changes.filter((c) => c.path.startsWith("bundles/"));
    if (bundles.length > 1 || bundles.some((b) => b.status !== "A")) problems.push("an outside contribution brings at most one new starter set and edits no existing one");
    const touched = changes.filter((c) => guarded.test(c.path));
    if (touched.length) problems.push(`an outside or community entry's pull request does not change how the registry is checked or signed: ${touched.map((c) => c.path).join(", ")}`);
  }
  return { problems, entries: entries.filter((c) => entryRe.test(c.path)).map((c) => c.path) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [base, head = "HEAD", origin = ""] = process.argv.slice(2);
  if (!/^[0-9a-f]{7,64}$/.test(base ?? "")) {
    console.error("usage: pr-policy.mjs BASE_SHA [HEAD_SHA]");
    process.exit(2);
  }
  const out = execFileSync("git", ["diff", "--name-status", "--no-renames", `${base}...${head}`], { cwd: root, encoding: "utf8" });
  const changes = out.split("\n").filter(Boolean).map((l) => {
    const [status, ...rest] = l.split("\t");
    return { status: status[0], path: rest.join("\t") };
  });
  // The tier is read from the PR's head commit, whatever tree this script runs in.
  const tierOf = (p) => {
    try {
      return JSON.parse(execFileSync("git", ["show", `${head}:${p}`], { cwd: root, encoding: "utf8" })).tier ?? "";
    } catch {
      return "";
    }
  };
  const { problems, entries } = policy(changes, tierOf, origin === "fork");
  if (problems.length) {
    console.error(`${problems.length} problem(s):`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  for (const e of entries) console.log(e);
}
