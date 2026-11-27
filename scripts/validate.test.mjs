// node --test scripts/: the validator refuses what the app refuses.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readTree, assemble } from "./tree.mjs";
import { buildPayload } from "./payload.mjs";
import { validateCatalog, validateEntry, validateBundle } from "./validate.mjs";

const catalog = assemble(readTree().files);
const npm = () => ({
  id: "x", name: "X", category: "dev-tools", summary: "s", license: "MIT",
  publisher: { name: "P", url: "https://p.example" }, homepage: "https://p.example",
  detect: { command: "x", version: ["x", "--version"] },
  platforms: { wsl: { driver: "npm-global", account: "user", package: "x" } },
});
const set = (f) => { const e = npm(); f(e, e.platforms.wsl); return e; };

test("the catalog in this repository is valid", () => {
  assert.deepEqual(validateCatalog(catalog), []);
});

test("a good entry passes", () => {
  assert.deepEqual(validateEntry(npm()), []);
});

const refused = {
  "unknown driver": set((e, p) => { p.driver = "brew"; }),
  "bad id": set((e) => { e.id = "../x"; }),
  "unknown category": set((e) => { e.category = "games"; }),
  "unknown field": set((e) => { e.shell = "rm -rf /"; }),
  "http homepage": set((e) => { e.homepage = "http://p.example"; }),
  "detect runs another command": set((e) => { e.detect.version = ["sh", "-c", "x"]; }),
  "npm path trick": set((e, p) => { p.package = "../evil"; }),
  "npm with a version": set((e, p) => { p.package = "x@1; rm -rf /"; }),
  "root account on a user driver": set((e, p) => { p.account = "root"; }),
  "env changes what runs": set((e, p) => { p.env = { NODE_OPTIONS: "1" }; }),
  "env value is free text": set((e, p) => { p.env = { X_TELEMETRY: "$(id)" }; }),
  "script off its hosts": set((e, p) => { Object.assign(p, { driver: "vendor-script", package: undefined, script: "https://evil.example/i.sh", hosts: ["p.example"] }); delete p.package; }),
  "script over http": set((e, p) => { delete p.package; Object.assign(p, { driver: "vendor-script", script: "http://p.example/i.sh", hosts: ["p.example"] }); }),
  "apt-repo without a pinned key": set((e, p) => { delete p.package; Object.assign(p, { driver: "apt-repo", account: "root", hosts: ["r.example"], packages: ["x"], repo: { url: "https://r.example/{base}", key: "https://r.example/gpg", suite: "{codename}", components: "main" } }); }),
  "apt package name with a flag": set((e, p) => { delete p.package; Object.assign(p, { driver: "apt", account: "root", packages: ["--allow-unauthenticated"] }); }),
  "unknown post-step": set((e, p) => { p.after = ["chmod-777"]; }),
  "required not from setup": set((e) => { e.required = true; }),
  "agent CLI not on the cli driver": set((e) => { e.category = "agent-clis"; }),
};
for (const [name, e] of Object.entries(refused)) {
  test(`refuses: ${name}`, () => assert.notDeepEqual(validateEntry(e), []));
}

test("refuses a catalog with a duplicate, an unknown dependency or a serial", () => {
  assert.notDeepEqual(validateCatalog({ version: 1, entries: [npm(), npm()] }), []);
  assert.notDeepEqual(validateCatalog({ version: 1, entries: [set((e) => { e.dependsOn = ["nope"]; })] }), []);
  assert.notDeepEqual(validateCatalog({ version: 1, serial: 9, entries: [npm()] }), []);
  assert.notDeepEqual(validateCatalog({ version: 2, entries: [npm()] }), []);
});

// Schema v2 (ADR-0409 amendment): what internal/software/catalog.go refuses.
const sum = "a".repeat(64);
const pinned = (f) => set((e, p) => {
  delete p.package;
  Object.assign(p, { driver: "github-release", hosts: ["github.com"], release: { repo: "o/x", asset: "x-{target}.tar.xz", binary: "x", version: "1.2.3", path: "x-{target}/x", targets: { amd64: "x86_64-linux" }, sha256: { amd64: sum } } });
  f?.(e, p, p.release);
});

test("a pinned github-release and the v2 words pass", () => {
  assert.deepEqual(validateEntry(pinned((e) => {
    Object.assign(e, { category: "documents", tier: "official", recommended: true, approxSizeMB: 40, updatedAt: "2026-11-26", agent: { summary: "s", commands: ["x a b"], formats: [".pdf"], caveats: "c" } });
    e.platforms.windows = { driver: "winget", id: "Pub.Tool", scope: "user" };
  })), []);
});

const refusedV2 = {
  "pin without a hash": pinned((e, p, r) => { delete r.sha256; }),
  "short hash": pinned((e, p, r) => { r.sha256.amd64 = "abc"; }),
  "upper-case hash": pinned((e, p, r) => { r.sha256.amd64 = "A".repeat(64); }),
  "version that is not one": pinned((e, p, r) => { r.version = "latest"; }),
  "tag without {version}": pinned((e, p, r) => { r.tag = "v1"; }),
  "{target} without a target": pinned((e, p, r) => { delete r.targets; }),
  "path that climbs": pinned((e, p, r) => { r.path = "../x"; }),
  "unknown release field": pinned((e, p, r) => { r.run = "sh"; }),
  "an installer asset": pinned((e, p, r) => { r.asset = "x.exe"; delete r.targets; r.path = undefined; }),
  "a v1 release with a path": set((e, p) => { delete p.package; Object.assign(p, { driver: "github-release", hosts: ["api.github.com", "github.com"], release: { repo: "o/x", asset: "x.tar.gz", checksums: "s.txt", binary: "x", path: "x" } }); }),
  "a pin without github.com in hosts": pinned((e, p) => { p.hosts = []; }),
  "unknown tier": set((e) => { e.tier = "vendor"; }),
  "a made-up date": set((e) => { e.updatedAt = "2026-02-31"; }),
  "agent command with a newline": set((e) => { e.agent = { commands: ["a\nb"] }; }),
  "agent format without a dot": set((e) => { e.agent = { formats: ["pdf"] }; }),
  "agent field it does not know": set((e) => { e.agent = { run: "x" }; }),
  "winget with a flag": set((e) => { e.platforms.windows = { driver: "winget", id: "Pub.Tool", scope: "user", args: "--force" }; }),
  "winget without a scope": set((e) => { e.platforms.windows = { driver: "winget", id: "Pub.Tool" }; }),
  "windows-only agent CLI": set((e) => { e.category = "agent-clis"; e.platforms = { windows: { driver: "winget", id: "Pub.Tool", scope: "user" } }; }),
  "remove lists a package install does not put": set((e, p) => { delete p.package; Object.assign(p, { driver: "apt", account: "root", packages: ["x"], remove: { packages: ["y"] } }); }),
  "noRecommends on npm": set((e, p) => { p.noRecommends = true; }),
};
for (const [name, e] of Object.entries(refusedV2)) {
  test(`refuses (v2): ${name}`, () => assert.notDeepEqual(validateEntry(e), []));
}

test("a Windows-only entry is a tool without Linux detection", () => {
  const w = { id: "t", name: "T", category: "dev-tools", summary: "s", license: "MIT", publisher: { name: "P", url: "https://p.example" }, homepage: "https://p.example", platforms: { windows: { driver: "winget", id: "Pub.Tool", scope: "machine" } } };
  assert.deepEqual(validateEntry(w), []);
  assert.notDeepEqual(validateEntry({ ...w, detect: { command: "t", version: ["t", "-v"] } }), []);
});

test("starter sets: known area, 2 to 12 distinct items the catalog holds", () => {
  const ids = new Set(["a", "b", "c"]);
  const ok = { id: "kit", name: "Kit", area: "documents", summary: "s", items: ["a", "b"] };
  assert.deepEqual(validateBundle(ok, ids), []);
  for (const bad of [{ ...ok, area: "games" }, { ...ok, items: ["a"] }, { ...ok, items: ["a", "a"] }, { ...ok, items: ["a", "zzz"] }, { ...ok, extra: 1 }]) {
    assert.notDeepEqual(validateBundle(bad, ids), []);
  }
  assert.notDeepEqual(validateCatalog({ version: 1, entries: [npm()], bundles: [ok] }), []);
});

test("the signed payload carries the starter sets and every field the catalog holds", () => {
  const p = JSON.parse(buildPayload(catalog, 3, "2026-11-26T00:00:00Z"));
  assert.deepEqual(p.bundles, catalog.bundles);
  assert.deepEqual(p.entries, catalog.entries);
  assert.equal(p.serial, 3);
  for (const k of Object.keys(catalog)) assert.ok(k in p, `${k} is dropped from the signed payload`);
});

test("refuses what Go would read differently or refuse (S3b review)", () => {
  const bad = {
    "a key that differs by case": pinned((e, p, r) => { r.Version = "9.9.9"; }),
    "publisher with an extra key": set((e) => { e.publisher.Name = "x"; }),
    "windows null": set((e) => { e.platforms.windows = null; }),
    "hosts as a string": pinned((e, p) => { p.hosts = "github.com"; }),
    "a target named constructor": pinned((e, p, r) => { r.targets = { constructor: "x" }; }),
    "path as a list": pinned((e, p, r) => { r.path = ["x-{target}/x"]; }),
    "formats as a string": set((e) => { e.agent = { formats: "" }; }),
    "grants as a number": set((e) => { e.grants = 1; }),
    "agent note over the byte cap": set((e) => { e.agent = { summary: "—".repeat(150) }; }),
  };
  for (const [name, e] of Object.entries(bad)) assert.notDeepEqual(validateEntry(e), [], name);
});
