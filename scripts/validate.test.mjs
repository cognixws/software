// node --test scripts/: the validator refuses what the app refuses.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateCatalog, validateEntry } from "./validate.mjs";

const catalog = JSON.parse(readFileSync(new URL("../catalog.json", import.meta.url), "utf8"));
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
