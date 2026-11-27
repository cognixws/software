#!/usr/bin/env node
// The daily broken-URL check. Every address an entry depends on, read from
// the tree: its homepage and publisher, the pinned release assets per
// architecture, the vendor script, the apt repository and key, the node
// distribution list, the npm and PyPI packages, the winget manifest. It
// downloads nothing large (HEAD, then a one-byte GET when a server refuses
// HEAD) and prints addresses only; the workflow turns a failure into an
// issue, so a rename like duckdb_cli → duckdb-cli is seen within a day,
// before anyone presses Install (for a pinned entry the old tag's asset does not
// move, so this guards against a deleted release or a removed asset; the
// weekly refresh is what holds back a bump whose asset was renamed). An entry
// that installs "latest" also has its asset resolved under the latest tag.
//
// A 403, 429 or timeout from a vendor's own site is "unverified", reported
// but not a failure: bot walls are not broken links. A 404, a 410, a failed
// DNS lookup, a 5xx or an off-host redirect of a download is a failure.
//
// Run: node scripts/urlcheck.mjs [--report FILE]
// Exit 0: all reachable. Exit 1: at least one failure. Exit 2: the check itself failed. Reads GITHUB_TOKEN /
// GH_TOKEN for the API only and never prints it.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readTree } from "./tree.mjs";
import { ghHeaders } from "./validate.mjs";

const UA = "cognixws-software-urlcheck";
const soft = new Set([401, 403, 405, 429, 999]);

// One address → "ok", "unverified: why" or "FAIL: why".
export async function probe(url, { hosts, method = "HEAD", headers = {}, fetcher = fetch } = {}) {
  let cur = url;
  for (let hop = 0; hop < 6; hop++) {
    const u = new URL(cur);
    if (u.protocol !== "https:") return { state: "fail", why: `${cur} is not HTTPS` };
    if (hosts && !hosts.includes(u.host)) return { state: "fail", why: `redirects to ${u.host}, which the entry does not name` };
    let res;
    // A credential goes to the host it was meant for, never along a redirect.
    const h = { ...headers };
    if (u.host !== new URL(url).host) delete h.Authorization;
    try {
      res = await fetcher(cur, { method, redirect: "manual", headers: { "User-Agent": UA, ...(method === "GET" ? { Range: "bytes=0-0" } : {}), ...h }, signal: AbortSignal.timeout(20000) });
    } catch (err) {
      const why = String(err.cause?.code || err.name || err.message);
      return /Timeout|ETIMEDOUT|ECONNRESET/i.test(why) ? { state: "unverified", why: `${why}` } : { state: "fail", why };
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      cur = new URL(res.headers.get("location"), cur).href;
      continue;
    }
    if (res.ok) return { state: "ok" };
    if (method === "HEAD" && (res.status === 405 || res.status === 403 || res.status === 400)) return probe(url, { hosts, method: "GET", headers, fetcher });
    if (soft.has(res.status)) return { state: "unverified", why: `HTTP ${res.status}` };
    return { state: "fail", why: `HTTP ${res.status}` };
  }
  return { state: "fail", why: "too many redirects" };
}

const fill = (t, r, v, arch) => t.replaceAll("{version}", v).replaceAll("{arch}", arch).replaceAll("{target}", r.targets?.[arch] ?? "");

// Every [id, label, url, options] an entry stands on.
export function targets(e) {
  const out = [];
  const add = (label, url, o = {}) => out.push({ id: e.id, label, url, ...o });
  add("homepage", e.homepage);
  if (e.publisher?.url && e.publisher.url !== e.homepage) add("publisher", e.publisher.url);
  const w = e.platforms?.windows;
  if (w?.id) {
    const seg = w.id.split(".");
    add(`winget ${w.id}`, `https://api.github.com/repos/microsoft/winget-pkgs/contents/manifests/${seg[0][0].toLowerCase()}/${seg.join("/")}`, { api: true });
  }
  const p = e.platforms?.wsl;
  if (!p) return out;
  switch (p.driver) {
    case "github-release": {
      const r = p.release;
      if (r.version) {
        const tag = (r.tag || "v{version}").replaceAll("{version}", r.version);
        for (const arch of Object.keys(r.sha256)) {
          add(`asset ${arch}`, `https://github.com/${r.repo}/releases/download/${tag}/${fill(r.asset, r, r.version, arch)}`, { hosts: p.hosts });
          if (r.checksums) add(`checksums ${arch}`, `https://github.com/${r.repo}/releases/download/${tag}/${fill(r.checksums, r, r.version, arch)}`, { hosts: p.hosts });
        }
      } else add("latest release", `https://api.github.com/repos/${r.repo}/releases/latest`, { api: true, latestOf: r });
      break;
    }
    case "npm-global": add(`npm ${p.package}`, `https://registry.npmjs.org/${p.package.replace("/", "%2f")}`); break;
    case "uv-tool": add(`pypi ${p.tool.package}`, `https://pypi.org/pypi/${p.tool.package}/${p.tool.version}/json`); break;
    // The script's own host may hand off to a download host (astral.sh → releases.astral.sh); HTTPS is the rule.
    case "vendor-script": add("script", p.script); break;
    case "node-dist": add("SHASUMS256", `https://nodejs.org/dist/v${p.dist.version}/SHASUMS256.txt`); break;
    case "apt-repo":
      for (const [base, codename] of [["ubuntu", "noble"], ["debian", "bookworm"]]) {
        add(`key (${base})`, p.repo.key.replaceAll("{base}", base).replaceAll("{codename}", codename), { hosts: p.hosts });
        // A repository has no page at its root: its InRelease file is what apt reads.
        const fillRepo = (t) => t.replaceAll("{base}", base).replaceAll("{codename}", codename);
        add(`repo (${base})`, `${fillRepo(p.repo.url).replace(/\/$/, "")}/dists/${fillRepo(p.repo.suite)}/InRelease`, { hosts: p.hosts });
      }
      break;
  }
  return out;
}

async function latestAssets(r, fetcher) {
  let rel;
  try {
    const res = await fetcher(`https://api.github.com/repos/${r.repo}/releases/latest`, { headers: { "User-Agent": UA, ...ghHeaders() }, signal: AbortSignal.timeout(20000) });
    rel = await res.json();
  } catch (err) {
    return { state: "unverified", why: String(err.message) };
  }
  const version = String(rel.tag_name ?? "").replace(/^v/, "");
  const names = new Set((rel.assets ?? []).map((a) => a.name));
  const want = ["amd64", "arm64"].map((arch) => fill(r.asset, r, version, arch)).concat(r.checksums ? [r.checksums] : []);
  const missing = want.filter((n) => !names.has(n));
  return missing.length ? { state: "fail", why: `release ${rel.tag_name} has no ${missing.join(", ")}` } : { state: "ok" };
}

export async function run(files, { fetcher = fetch, concurrency = 6 } = {}) {
  const list = files.filter((f) => f.kind === "entry").flatMap((f) => targets(f.doc));
  const results = new Array(list.length);
  let next = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < list.length) {
      const i = next++;
      const t = list[i];
      const got = await probe(t.url, { hosts: t.hosts, headers: t.api ? ghHeaders() : {}, fetcher });
      // An unpinned entry installs "latest": its asset, under the latest tag, must exist.
      results[i] = { ...t, ...(got.state === "ok" && t.latestOf ? await latestAssets(t.latestOf, fetcher) : got) };
    }
  }));
  return results;
}

export function report(results, today) {
  const bad = results.filter((r) => r.state === "fail");
  const unv = results.filter((r) => r.state === "unverified");
  const lines = [`Daily source check, ${today}: ${results.length} addresses, ${bad.length} broken, ${unv.length} unverified.`, ""];
  if (bad.length) lines.push("### Broken", "", ...bad.map((r) => `- \`${r.id}\` ${r.label}: ${r.url}: ${r.why}`), "");
  if (unv.length) lines.push("### Unverified (a bot wall or a timeout, not a broken link)", "", ...unv.map((r) => `- \`${r.id}\` ${r.label}: ${r.url}: ${r.why}`), "");
  if (bad.length) lines.push("A broken pinned asset means a person pressing Install on that entry gets an error. Fix the pin (or withdraw the entry) in a pull request.", "");
  return lines.join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  try {
    const { files } = readTree();
    const results = await run(files);
    const md = report(results, new Date().toISOString().slice(0, 10));
    if (argv.includes("--report")) writeFileSync(argv[argv.indexOf("--report") + 1], md);
    console.log(md);
    process.exit(results.some((r) => r.state === "fail") ? 1 : 0);
  } catch (err) {
    console.error(`the check could not run: ${err.message}`);
    process.exit(2);
  }
}
