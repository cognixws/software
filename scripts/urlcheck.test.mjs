// node --test scripts/: the daily check separates broken links from bot walls.
import { test } from "node:test";
import assert from "node:assert/strict";
import { probe, targets, report } from "./urlcheck.mjs";

const reply = (status, location) => ({ status, ok: status >= 200 && status < 300, headers: { get: (h) => (h === "location" ? location : null) } });
const fetcher = (map) => async (url, init) => {
  const r = map[`${init.method} ${url}`] ?? map[url];
  if (r instanceof Error) throw r;
  return r ?? reply(404);
};

test("200 is ok; 404 and 410 are broken; 5xx is broken", async () => {
  assert.equal((await probe("https://a.example/x", { fetcher: fetcher({ "https://a.example/x": reply(200) }) })).state, "ok");
  assert.equal((await probe("https://a.example/x", { fetcher: fetcher({}) })).state, "fail");
  assert.equal((await probe("https://a.example/x", { fetcher: fetcher({ "https://a.example/x": reply(410) }) })).state, "fail");
  assert.equal((await probe("https://a.example/x", { fetcher: fetcher({ "https://a.example/x": reply(503) }) })).state, "fail");
});

test("a bot wall is unverified, not broken; a HEAD refusal retries with GET", async () => {
  assert.equal((await probe("https://a.example/x", { fetcher: fetcher({ "https://a.example/x": reply(429) }) })).state, "unverified");
  const f = fetcher({ "HEAD https://a.example/x": reply(405), "GET https://a.example/x": reply(206) });
  assert.equal((await probe("https://a.example/x", { fetcher: f })).state, "ok");
});

test("a download redirect off the entry's hosts is broken; on them it is followed", async () => {
  const f = fetcher({ "https://github.com/a": reply(302, "https://evil.example/a"), "https://evil.example/a": reply(200) });
  assert.match((await probe("https://github.com/a", { hosts: ["github.com"], fetcher: f })).why, /does not name/);
  const g = fetcher({ "https://github.com/a": reply(302, "https://cdn.example/a"), "https://cdn.example/a": reply(200) });
  assert.equal((await probe("https://github.com/a", { hosts: ["github.com", "cdn.example"], fetcher: g })).state, "ok");
});

test("a lookup failure is broken, a timeout is unverified", async () => {
  const dns = Object.assign(new Error("fetch failed"), { cause: { code: "ENOTFOUND" } });
  assert.equal((await probe("https://a.example/x", { fetcher: fetcher({ "https://a.example/x": dns }) })).state, "fail");
  const slow = Object.assign(new Error("t"), { name: "TimeoutError" });
  assert.equal((await probe("https://a.example/x", { fetcher: fetcher({ "https://a.example/x": slow }) })).state, "unverified");
});

test("a pinned release stands on each architecture's asset", () => {
  const e = { id: "t", homepage: "https://t.example", publisher: { url: "https://t.example" }, platforms: { wsl: { driver: "github-release", hosts: ["github.com"], release: { repo: "o/t", asset: "t-{target}.tar.xz", binary: "t", version: "2.0.0", targets: { amd64: "x64", arm64: "a64" }, sha256: { amd64: "a", arm64: "b" } } } } };
  const urls = targets(e).map((t) => t.url);
  assert.deepEqual(urls, ["https://t.example", "https://github.com/o/t/releases/download/v2.0.0/t-x64.tar.xz", "https://github.com/o/t/releases/download/v2.0.0/t-a64.tar.xz"]);
});

test("the report names addresses and never anything else", () => {
  const md = report([{ id: "x", label: "asset amd64", url: "https://github.com/o/x/a", state: "fail", why: "HTTP 404" }], "d");
  assert.match(md, /1 broken/);
  assert.match(md, /https:\/\/github\.com\/o\/x\/a: HTTP 404/);
});
