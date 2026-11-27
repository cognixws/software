// The registry's source of truth is the tree (D5a): entries/<area>/<id>.json,
// one entry per file, and bundles/<id>.json, one starter set per file. The
// <area> directory is the entry's category. catalog.json is assembled from
// the tree by build.mjs and is not committed; the app reads the signed index
// made from it. Nothing here touches the network.

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { categories as categoriesOrder } from "./categories.mjs";

export const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const entriesDir = join(root, "entries");
export const bundlesDir = join(root, "bundles");

const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// The tree as files: [{ path (relative, "/"), kind, doc }]. A file that is
// not JSON, a stray file, a directory two levels deep: reported, not skipped.
export function readTree(dir = root) {
  const files = [];
  const problems = [];
  const eDir = join(dir, "entries");
  const bDir = join(dir, "bundles");
  const read = (abs) => {
    const rel = relative(dir, abs).split("\\").join("/");
    try {
      return { path: rel, doc: JSON.parse(readFileSync(abs, "utf8")) };
    } catch (err) {
      problems.push(`${rel}: not valid JSON (${err.message})`);
      return null;
    }
  };
  if (existsSync(eDir)) {
    for (const area of readdirSync(eDir).sort()) {
      const aDir = join(eDir, area);
      if (!statSync(aDir).isDirectory()) {
        problems.push(`entries/${area}: entries live in entries/<area>/<id>.json`);
        continue;
      }
      for (const f of readdirSync(aDir).sort()) {
        const abs = join(aDir, f);
        if (!f.endsWith(".json") || !statSync(abs).isFile()) {
          problems.push(`entries/${area}/${f}: only <id>.json files belong here`);
          continue;
        }
        const r = read(abs);
        if (r) files.push({ ...r, kind: "entry", area, file: f });
      }
    }
  }
  if (existsSync(bDir)) {
    for (const f of readdirSync(bDir).sort()) {
      const abs = join(bDir, f);
      if (!f.endsWith(".json") || !statSync(abs).isFile()) {
        problems.push(`bundles/${f}: only <id>.json files belong here`);
        continue;
      }
      const r = read(abs);
      if (r) files.push({ ...r, kind: "bundle", file: f });
    }
  }
  return { files, problems };
}

// Where a file must sit: the area is the category and the name is the id.
export function placementProblems(files) {
  const out = [];
  for (const f of files) {
    const id = f.doc?.id;
    if (f.file !== `${id}.json`) out.push(`${f.path}: the file is named for the id, ${id}.json`);
    if (f.kind === "entry" && f.area !== f.doc?.category) out.push(`${f.path}: the directory is the category, entries/${f.doc?.category}/`);
  }
  return out;
}

// The catalog document the tree assembles: entries by category then id,
// bundles by id. Same shape the app and sign.mjs read.
export function assemble(files) {
  const order = (c) => {
    const i = categoriesOrder.indexOf(c);
    return i < 0 ? categoriesOrder.length : i;
  };
  const entries = files.filter((f) => f.kind === "entry").map((f) => f.doc);
  entries.sort((a, b) => order(a.category) - order(b.category) || byId(a, b));
  const bundles = files.filter((f) => f.kind === "bundle").map((f) => f.doc).sort(byId);
  const doc = { version: 1, entries };
  if (bundles.length) doc.bundles = bundles;
  return doc;
}

export const serialize = (doc) => JSON.stringify(doc, null, 2) + "\n";
