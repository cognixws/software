#!/usr/bin/env node
// Assembles catalog.json from entries/<area>/<id>.json and bundles/<id>.json
// (D5a), after checking the tree: every file valid, in its area, named for
// its id. publish.yml runs it before signing; a developer runs it to see the
// catalog the app will get.
//
// Run: node scripts/build.mjs [--out catalog.json] [--check]
//   --check   build in memory and print the summary; write nothing

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { readTree, placementProblems, assemble, serialize, root } from "./tree.mjs";
import { validateCatalog } from "./validate.mjs";

export function buildCatalog(dir) {
  const { files, problems } = readTree(dir);
  const out = [...problems, ...placementProblems(files)];
  const doc = assemble(files);
  if (doc.entries.length) out.push(...validateCatalog(doc));
  else out.push("entries/ holds no entry");
  return { doc, problems: out };
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf("--out");
  const out = i >= 0 ? argv[i + 1] : join(root, "catalog.json");
  const { doc, problems } = buildCatalog();
  if (problems.length) {
    console.error(`${problems.length} problem(s):`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  if (!argv.includes("--check")) writeFileSync(out, serialize(doc));
  console.log(`${argv.includes("--check") ? "checked" : `wrote ${out}:`} ${doc.entries.length} entries, ${(doc.bundles ?? []).length} bundles`);
}
