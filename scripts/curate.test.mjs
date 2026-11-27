// node --test scripts/: the refresh's decision table, with the network stubbed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { refresh, cmpVersion, versionOfTag, licenseVerdict, report, COOL_OFF_MS } from "./curate.mjs";

const NOW = Date.parse("2026-11-27T12:00:00Z");
const hex = (b) => createHash("sha256").update(b).digest("hex");
const entry = (over = {}) => ({
  id: "x", license: "MIT", detect: { command: "x", version: ["x", "--version"] },
  platforms: { wsl: { driver: "github-release", hosts: ["github.com"], release: { repo: "o/x", asset: "x-{arch}.tar.gz", binary: "x", version: "1.0.0", sha256: { amd64: "a".repeat(64) }, ...over } } },
});
const rel = (v, hoursAgo = 72, extra = {}) => ({ tag_name: `v${v}`, published_at: new Date(NOW - hoursAgo * 3600e3).toISOString(), assets: [], ...extra });
const world = (o = {}) => ({
  now: () => NOW,
  releases: async () => o.releases ?? [rel("1.0.0")],
  repo: async () => o.repo ?? { license: { spdx_id: "MIT" } },
  download: o.download ?? (async () => Buffer.from("bytes")),
  text: o.text ?? (async () => ""),
  smoke: o.smoke ?? null,
});

test("version helpers", () => {
  assert.ok(cmpVersion("1.10.0", "1.9.9") > 0);
  assert.equal(cmpVersion("2.0.1", "2.0.1"), 0);
  assert.equal(versionOfTag("v0.15.1"), "0.15.1");
  assert.equal(versionOfTag("jq-1.8.1", "jq-{version}"), "1.8.1");
  assert.equal(versionOfTag("nightly"), "");
  assert.equal(versionOfTag("v1.0.0-rc1"), "");
});

test("licenses: recorded passes; changed or blocked is refused", () => {
  assert.ok(licenseVerdict("MIT", "MIT").ok);
  assert.ok(licenseVerdict("MIT OR Apache-2.0", "Apache-2.0").ok);
  assert.ok(!licenseVerdict("MIT", "BUSL-1.1").ok);
  assert.ok(!licenseVerdict("MIT", "GPL-3.0").ok);
  assert.ok(!licenseVerdict("MIT", "NOASSERTION").ok);
  assert.ok(!licenseVerdict("MIT", undefined).ok);
});

test("current pin: nothing to do", async () => assert.equal((await refresh(entry(), world())).status, "current"));
test("an older release than the pin is ignored", async () => assert.equal((await refresh(entry(), world({ releases: [rel("0.9.0")] }))).status, "current"));
test("prereleases, drafts and odd tags are never candidates", async () => {
  const r = await refresh(entry(), world({ releases: [rel("2.0.0", 72, { prerelease: true }), rel("3.0.0", 72, { draft: true }), { ...rel("4.0.0"), tag_name: "nightly" }] }));
  assert.equal(r.status, "current");
});

test("inside the cool-off: held, the old pin stays", async () => {
  const r = await refresh(entry(), world({ releases: [rel("1.1.0", 2)] }));
  assert.equal(r.status, "held");
  assert.match(r.notes[0], /cool-off/);
  assert.ok(COOL_OFF_MS === 24 * 3600e3);
});

test("the newest release is too fresh but an older one cleared: that one is taken", async () => {
  const r = await refresh(entry(), world({ releases: [rel("1.2.0", 2), rel("1.1.0", 48)] }));
  assert.equal(r.status, "bump");
  assert.equal(r.to, "1.1.0");
});

test("a clean newer release is bumped with the hash it computed", async () => {
  const body = Buffer.from("release-bytes");
  const r = await refresh(entry(), world({ releases: [rel("1.1.0")], download: async () => body }));
  assert.equal(r.status, "bump");
  assert.equal(r.sha256.amd64, hex(body));
  assert.match(r.notes.join(), /no checksum/);
});

test("a license that changed holds the bump", async () => {
  const r = await refresh(entry(), world({ releases: [rel("1.1.0")], repo: { license: { spdx_id: "BUSL-1.1" } } }));
  assert.equal(r.status, "held");
  assert.match(r.notes[0], /license/);
});

test("an archived repository holds the bump", async () => {
  const r = await refresh(entry(), world({ releases: [rel("1.1.0")], repo: { archived: true, license: { spdx_id: "MIT" } } }));
  assert.equal(r.status, "held");
});

test("a renamed or missing asset holds the bump and keeps the pin", async () => {
  const r = await refresh(entry(), world({ releases: [rel("1.1.0")], download: async () => { throw new Error("GET … returned 404"); } }));
  assert.equal(r.status, "held");
  assert.match(r.notes[0], /pin stays at 1\.0\.0/);
});

test("GitHub's own digest must match the download", async () => {
  const body = Buffer.from("b");
  const bad = rel("1.1.0", 72, { assets: [{ name: "x-amd64.tar.gz", digest: `sha256:${"f".repeat(64)}` }] });
  assert.equal((await refresh(entry(), world({ releases: [bad], download: async () => body }))).status, "held");
  const good = rel("1.1.0", 72, { assets: [{ name: "x-amd64.tar.gz", digest: `sha256:${hex(body)}` }] });
  const r = await refresh(entry(), world({ releases: [good], download: async () => body }));
  assert.equal(r.status, "bump");
  assert.match(r.notes[0], /GitHub's release digest/);
});

test("a checksums file must list the computed hash", async () => {
  const body = Buffer.from("b");
  const e = entry({ checksums: "sums.txt" });
  const w = (text) => world({ releases: [rel("1.1.0")], download: async () => body, text: async () => text });
  assert.equal((await refresh(e, w(`${"0".repeat(64)}  x-amd64.tar.gz\n`))).status, "held");
  assert.equal((await refresh(e, w(`${hex(body)}  x-amd64.tar.gz\n`))).status, "bump");
  assert.equal((await refresh(e, w(""))).status, "held");
});

test("a failed smoke proof holds the bump; a passing one is in the evidence", async () => {
  const bad = await refresh(entry(), world({ releases: [rel("1.1.0")], smoke: async () => ({ ok: false, detail: "debian:12: no version" }) }));
  assert.equal(bad.status, "held");
  assert.match(bad.notes.join(), /smoke proof failed/);
  const ok = await refresh(entry(), world({ releases: [rel("1.1.0")], smoke: async () => ({ ok: true, detail: "ubuntu:24.04: x 1.1.0" }) }));
  assert.equal(ok.status, "bump");
  assert.match(report([ok], [], "2026-11-27"), /smoke: ubuntu:24\.04/);
});

test("the report: quiet when current, a table when not", () => {
  assert.match(report([{ id: "x", status: "current", from: "1.0.0" }], [], "d"), /nothing to merge/);
  const md = report([{ id: "x", status: "held", from: "1.0.0", to: "1.1.0", notes: ["why"] }], ["`n`: a → b"], "d");
  assert.match(md, /\*\*held back\*\*/);
  assert.match(md, /Reported, not changed/);
});

test("upstream text cannot break or spoof the audit table", () => {
  const md = report([{ id: "x", status: "bump", from: "1.0.0", to: "1.1.0", notes: [], smoke: { ok: true, detail: "a | [click](https://evil.example) `x`\n| fake | row |" } }], [], "d");
  const row = md.split("\n").find((l) => l.startsWith("| `x`"));
  assert.equal(row.split("|").length, 7);
  assert.ok(!/[`<>]/.test(row.slice(row.indexOf("1.1.0"))));
});
