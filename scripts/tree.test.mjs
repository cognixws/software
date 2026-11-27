// node --test scripts/: the tree (D5a) is placed, named and assembled as the build expects.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTree, placementProblems, assemble } from "./tree.mjs";
import { buildCatalog } from "./build.mjs";

const entry = (id, category = "dev-tools") => ({
  id, name: id, category, summary: "s", license: "MIT", publisher: { name: "P", url: "https://p.example" }, homepage: "https://p.example",
  detect: { command: id, version: [id, "--version"] }, platforms: { wsl: { driver: "npm-global", account: "user", package: id } },
});
function tree(files) {
  const dir = mkdtempSync(join(tmpdir(), "tree-"));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), typeof body === "string" ? body : JSON.stringify(body));
  }
  return dir;
}

test("the repository's own tree builds", () => {
  const { doc, problems } = buildCatalog();
  assert.deepEqual(problems, []);
  assert.ok(doc.entries.length > 0);
});

test("a well-placed tree assembles by category order then id", () => {
  const dir = tree({ "entries/dev-tools/b.json": entry("b"), "entries/dev-tools/a.json": entry("a"), "entries/documents/z.json": entry("z", "documents") });
  try {
    const { doc, problems } = buildCatalog(dir);
    assert.deepEqual(problems, []);
    assert.deepEqual(doc.entries.map((e) => e.id), ["z", "a", "b"]);
  } finally { rmSync(dir, { recursive: true }); }
});

for (const [name, files, want] of [
  ["an entry in the wrong area", { "entries/data/a.json": entry("a") }, /the directory is the category/],
  ["a file not named for its id", { "entries/dev-tools/x.json": entry("a") }, /named for the id/],
  ["a file straight under entries/", { "entries/a.json": entry("a"), "entries/dev-tools/b.json": entry("b") }, /entries\/<area>\/<id>\.json/],
  ["a stray file in an area", { "entries/dev-tools/README.md": "x", "entries/dev-tools/a.json": entry("a") }, /only <id>\.json/],
  ["broken JSON", { "entries/dev-tools/a.json": "{", "entries/dev-tools/b.json": entry("b") }, /not valid JSON/],
  ["an id listed in two areas", { "entries/dev-tools/a.json": entry("a"), "entries/data/a.json": entry("a") }, /directory is the category|listed twice/],
  ["no entries", { "bundles/x.json": { id: "x" } }, /holds no entry/],
]) {
  test(`refuses: ${name}`, () => {
    const dir = tree(files);
    try {
      assert.match(buildCatalog(dir).problems.join("\n"), want);
    } finally { rmSync(dir, { recursive: true }); }
  });
}

test("a bundle naming an unknown entry is refused", () => {
  const dir = tree({ "entries/dev-tools/a.json": entry("a"), "bundles/k.json": { id: "k", name: "K", area: "dev-tools", summary: "s", items: ["a", "nope"] } });
  try { assert.match(buildCatalog(dir).problems.join("\n"), /unknown "nope"/); } finally { rmSync(dir, { recursive: true }); }
});

test("assemble leaves out bundles when there are none", () => {
  assert.equal(assemble([{ kind: "entry", doc: entry("a") }]).bundles, undefined);
  assert.equal(readTree(tree({})).files.length, 0);
});
