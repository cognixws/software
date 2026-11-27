// node --test scripts/: what a pull request may touch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { policy } from "./pr-policy.mjs";

const c = (status, path) => ({ status, path });
const tiers = (m) => (p) => m[p] ?? "official";

test("one new community entry passes and is listed for the online check", () => {
  const r = policy([c("A", "entries/data/x.json")], tiers({ "entries/data/x.json": "community" }));
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.entries, ["entries/data/x.json"]);
});

test("a community entry with a second entry is refused", () => {
  const r = policy([c("A", "entries/data/x.json"), c("M", "entries/data/y.json")], tiers({ "entries/data/x.json": "community" }));
  assert.match(r.problems[0], /alone/);
});

test("a community entry that edits the scripts, a workflow or the key is refused", () => {
  for (const p of ["scripts/validate.mjs", ".github/workflows/publish.yml", "keys/index.pub", "package.json"]) {
    const r = policy([c("A", "entries/data/x.json"), c("M", p)], tiers({ "entries/data/x.json": "community" }));
    assert.match(r.problems.join(), /checked or signed/, p);
  }
});

test("a community entry may bring its starter set", () => {
  assert.deepEqual(policy([c("A", "entries/data/x.json"), c("A", "bundles/k.json")], tiers({ "entries/data/x.json": "community" })).problems, []);
});

test("a maintainer PR may change several entries and the scripts", () => {
  const r = policy([c("M", "entries/data/a.json"), c("M", "entries/data/b.json"), c("M", "scripts/curate.mjs")], tiers({}));
  assert.deepEqual(r.problems, []);
  assert.equal(r.entries.length, 2);
});

test("a deletion is not checked online; a stray path under entries/ is refused", () => {
  const r = policy([c("D", "entries/data/a.json"), c("A", "entries/oops.json")], tiers({}));
  assert.deepEqual(r.entries, []);
  assert.match(r.problems[0], /entries\/<area>\/<id>\.json/);
});

test("an outside author's entry must say community; no tier or official is refused", () => {
  for (const tier of ["official", ""]) assert.match(policy([c("A", "entries/data/x.json")], () => tier, true).problems.join(), /tier "community"/);
  assert.deepEqual(policy([c("A", "entries/data/x.json")], () => "community", true).problems, []);
});

test("an outside PR cannot delete an entry or edit an existing starter set", () => {
  const t = () => "community";
  assert.match(policy([c("A", "entries/data/x.json"), c("D", "entries/agent-clis/pi.json")], t, true).problems.join(), /alone/);
  assert.match(policy([c("A", "entries/data/x.json"), c("M", "bundles/office-pdf-kit.json")], t, true).problems.join(), /starter set/);
  assert.deepEqual(policy([c("A", "entries/data/x.json"), c("A", "bundles/k.json")], t, true).problems, []);
});

test("a trusted author with an official entry is unrestricted", () => {
  assert.deepEqual(policy([c("M", "entries/data/a.json"), c("M", "entries/data/b.json")], () => "", false).problems, []);
});
