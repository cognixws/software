#!/usr/bin/env node
// Validates the registry tree (entries/<area>/<id>.json, bundles/<id>.json,
// D5a) as the one catalog it assembles into: the schema COGNIX[WS] enforces (internal/software
// in the app, ADR-0407 and ADR-0409), ids, HTTPS URLs, download hosts and
// pinned fingerprints. With --online it also checks each entry against its
// official source: the npm package and its repository, the vendor's script,
// the GitHub release and its checksums, the apt key's fingerprint. With
// --apt it checks that every apt package exists on this machine's
// distribution (CI runs it on Ubuntu 24.04 and Debian 12).
//
// --entry entries/<area>/<id>.json (repeatable) limits --online to those
// entries: what a single-entry pull request needs, the rest being checked
// offline. No dependencies.
// Run: node scripts/validate.mjs [--online] [--apt] [--entry FILE]...

import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readTree, placementProblems, assemble } from "./tree.mjs";
import { categories } from "./categories.mjs";

const argv = process.argv.slice(2);
const args = new Set(argv);
const only = argv.flatMap((a, i) => (a === "--entry" ? [argv[i + 1]] : []));
const online = args.has("--online");
const aptCheck = args.has("--apt");
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
const problems = [];
const notes = [];
const fail = (m) => problems.push(m);

// ── the schema (mirror of internal/software/catalog.go) ───────────────────
export { categories };
const drivers = {
  cli: "user", "npm-global": "user", "github-release": "user", "vendor-script": "user",
  apt: "root", "apt-repo": "root", setup: "user", "node-dist": "user", "uv-tool": "user", winget: "windows",
};
const idRe = /^[a-z0-9][a-z0-9-]{0,39}$/;
const commandRe = /^[a-z0-9][a-z0-9._-]{0,39}$/;
const npmRe = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const debRe = /^[a-z0-9][a-z0-9.+-]{0,62}$/;
const repoRe = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const assetRe = /^[A-Za-z0-9_.{}-]+$/;
const fprRe = /^[0-9A-F]{40}$/;
const suiteRe = /^[a-z0-9{}][a-z0-9{}._-]{0,39}$/;
const compsRe = /^[a-z0-9]+( [a-z0-9]+){0,3}$/;
const envKeyRe = /^[A-Z][A-Z0-9_]{0,63}$/;
const envValRe = /^(0|1|true|false)$/;
const families = new Set(["apt", "dnf", "pacman"]);
const signIns = new Set(["", "gui", "later", "none"]);
const updatesSet = new Set(["", "driver", "vendor"]);
const afterSet = new Set(["docker-access"]);
const entryKeys = new Set(["id", "name", "category", "required", "summary", "publisher", "homepage", "license", "keywords", "detect", "platforms", "dependsOn", "grants", "signIn", "updates", "tier", "recommended", "approxSizeMB", "updatedAt", "agent"]);
const platformKeys = new Set(["families", "driver", "account", "hosts", "package", "packages", "env", "repo", "release", "tool", "dist", "script", "conflicts", "after", "remove", "noRecommends", "id", "scope"]);
const releaseKeys = new Set(["repo", "asset", "checksums", "binary", "version", "tag", "sha256", "targets", "path", "folder"]);
const agentKeys = new Set(["summary", "commands", "formats", "caveats", "skill", "extension"]);
const bundleKeys = new Set(["id", "name", "area", "summary", "items"]);
// Schema v2 (ADR-0409 amendment of 2026-11-22), as internal/software/catalog.go reads it.
const semverRe = /^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]{1,20})?$/;
const tagTmplRe = /^[A-Za-z0-9_.-]{0,20}\{version\}[A-Za-z0-9_.-]{0,20}$/;
const targetRe = /^[A-Za-z0-9_.-]{1,64}$/;
const archPathRe = /^[A-Za-z0-9_.{}+-]+(\/[A-Za-z0-9_.{}+-]+){0,7}$/;
const sha256Re = /^[0-9a-f]{64}$/;
const pypiRe = /^[A-Za-z0-9]([A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/;
const pyVersionRe = /^[0-9]+(\.[0-9]+){1,3}((a|b|rc|\.post|\.dev)[0-9]{1,4})?$/;
const extraRe = /^[a-z0-9][a-z0-9._-]{0,39}$/;
const pythonRe = /^3\.[0-9]{1,2}$/;
const formatRe = /^\.[a-z0-9]{1,10}$/;
const dateRe = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const extIdRe = /^[a-z0-9][a-z0-9-]{0,63}$/;
const wingetIdRe = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}(\.[A-Za-z0-9][A-Za-z0-9+_-]{0,63}){1,3}$/;
const distVersionRe = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const distPlatforms = ["linux-x64", "linux-arm64"];
const unsupportedAssetRe = /\.(deb|rpm|apk|msi|exe|dmg|pkg|7z|rar|bz2|zst|tar|gz|xz|tbz2?|appimage|sig|asc|sha256|pem)$/i;
const plain = (s, max) => typeof s === "string" && Buffer.byteLength(s) <= max && !/[\u0000-\u001f\u007f]/.test(s);
export const assetFormat = (asset) => {
  const a = asset.toLowerCase();
  if (a.endsWith(".tar.gz") || a.endsWith(".tgz")) return "tar.gz";
  if (a.endsWith(".tar.xz") || a.endsWith(".txz")) return "tar.xz";
  if (a.endsWith(".zip")) return "zip";
  if (unsupportedAssetRe.test(a)) return "";
  return "binary";
};

const envDenied = (k) => k === "PATH" || k === "HOME" || k === "NODE_OPTIONS" || k.startsWith("LD_") || k.startsWith("NPM_CONFIG_") || k.startsWith("npm_");
const isHttps = (u) => {
  try {
    const p = new URL(u);
    return p.protocol === "https:" && p.host !== "";
  } catch {
    return false;
  }
};
const onHosts = (u, hosts) => {
  try {
    const p = new URL(u.replaceAll("{base}", "x").replaceAll("{codename}", "x"));
    return p.protocol === "https:" && (hosts || []).includes(p.host);
  } catch {
    return false;
  }
};
const str = (v) => typeof v === "string";
const strs = (v) => v === undefined || (Array.isArray(v) && v.every(str));

function validateRelease(r, bad) {
  for (const k of Object.keys(r)) if (!releaseKeys.has(k)) bad(`unknown release field "${k}"`);
  const format = assetFormat(r.asset);
  if (!format) return bad("github-release opens .tar.gz, .tar.xz and .zip archives or a bare binary");
  if (r.checksums !== undefined && !(str(r.checksums) && assetRe.test(r.checksums))) return bad("github-release checksums must be a file name");
  const hasTarget = (r.asset + (r.checksums ?? "") + (r.path ?? "")).includes("{target}");
  if (r.version === undefined) {
    if (!r.checksums || format !== "tar.gz" || r.tag !== undefined || r.sha256 || r.targets || r.path !== undefined || r.folder || hasTarget) {
      bad("github-release without a pinned version takes a .tar.gz, its checksums file and nothing more");
    }
    return;
  }
  if (!str(r.version) || !semverRe.test(r.version)) return bad(`github-release version "${r.version}" is not a version`);
  if (r.tag !== undefined && !(str(r.tag) && tagTmplRe.test(r.tag))) bad("github-release tag must hold {version}");
  const sums = r.sha256 || {};
  if (Object.keys(sums).length === 0) return bad("a pinned github-release needs its sha256 per architecture");
  for (const [arch, sum] of Object.entries(sums)) {
    if (arch !== "amd64" && arch !== "arm64") bad(`unknown architecture "${arch}"`);
    if (!str(sum) || !sha256Re.test(sum)) bad(`sha256 for ${arch} is not 64 lower-case hex digits`);
  }
  for (const [arch, t] of Object.entries(r.targets || {})) if (!Object.hasOwn(sums, arch) || !str(t) || !targetRe.test(t)) bad(`target for ${arch} needs a pin and a plain name`);
  if (hasTarget && Object.keys(r.targets || {}).length !== Object.keys(sums).length) bad("{target} needs a target for every pinned architecture");
  if (r.path !== undefined) {
    const segs = String(r.path).split("/");
    if (!str(r.path) || !archPathRe.test(r.path) || segs.includes("..") || segs.includes(".")) bad("github-release path must be a plain relative path");
    if (format === "binary") bad("a bare binary has no path inside");
  }
  if (r.folder !== undefined && typeof r.folder !== "boolean") bad("folder is true or false");
  if (r.folder && format === "binary") bad("a folder install needs an archive");
}

function validateWinget(p, bad) {
  if (typeof p !== "object" || p === null || Array.isArray(p)) return bad("the windows platform is an object");
  for (const k of Object.keys(p)) if (!["driver", "id", "scope"].includes(k)) return bad("winget takes only an id and a scope");
  if (p.driver !== "winget") return bad("the windows platform uses the winget driver");
  if (!str(p.id) || !wingetIdRe.test(p.id)) bad("winget needs a package identifier");
  if (p.scope !== "user" && p.scope !== "machine") bad("winget needs a scope, user or machine");
}

function validateV2(e, bad) {
  if (e.tier !== undefined && e.tier !== "official" && e.tier !== "community") bad(`unknown tier "${e.tier}"`);
  if (e.recommended !== undefined && typeof e.recommended !== "boolean") bad("recommended is true or false");
  if (e.approxSizeMB !== undefined && !(Number.isInteger(e.approxSizeMB) && e.approxSizeMB >= 0 && e.approxSizeMB <= 100000)) bad("approxSizeMB out of range");
  if (e.updatedAt !== undefined) {
    const t = Date.parse(`${e.updatedAt}T00:00:00Z`);
    if (!str(e.updatedAt) || !dateRe.test(e.updatedAt) || Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== e.updatedAt) bad("updatedAt must be a date, YYYY-MM-DD");
  }
  const a = e.agent;
  if (a === undefined) return;
  if (typeof a !== "object" || a === null || Array.isArray(a)) return bad("agent must be an object");
  for (const k of Object.keys(a)) if (!agentKeys.has(k)) bad(`unknown agent field "${k}"`);
  if (!plain(a.summary ?? "", 300) || !plain(a.caveats ?? "", 500) || (a.commands ?? []).length > 8 || (a.formats ?? []).length > 24) bad("agent notes are plain and short");
  for (const c of Array.isArray(a.commands) ? a.commands : []) if (!str(c) || !c.trim() || !plain(c, 200)) bad("agent commands are plain lines");
  if (a.formats !== undefined && !Array.isArray(a.formats)) bad("agent formats is a list");
  if (a.commands !== undefined && !Array.isArray(a.commands)) bad("agent commands is a list");
  for (const f of Array.isArray(a.formats) ? a.formats : []) if (!str(f) || !formatRe.test(f)) bad(`agent format "${f}" is not a file extension`);
  if ((a.skill !== undefined && !(str(a.skill) && idRe.test(a.skill))) || (a.extension !== undefined && !(str(a.extension) && extIdRe.test(a.extension)))) bad("agent skill and extension are ids");
}

export function validateBundle(b, ids) {
  const errs = [];
  if (typeof b !== "object" || b === null || Array.isArray(b)) return ["bundle must be an object"];
  for (const k of Object.keys(b)) if (!bundleKeys.has(k)) errs.push(`unknown field "${k}"`);
  if (!str(b.id) || !idRe.test(b.id)) errs.push("invalid id");
  if (!str(b.name) || !b.name.trim() || !str(b.summary) || !b.summary.trim() || !plain(b.name, 60) || !plain(b.summary, 300)) errs.push("name and summary are required, plain and short");
  if (!categories.includes(b.area)) errs.push(`unknown area "${b.area}"`);
  if (!Array.isArray(b.items) || b.items.length < 2 || b.items.length > 12) return [...errs, "a bundle holds 2 to 12 items"];
  const seen = new Set();
  for (const id of b.items) {
    if (!str(id) || !idRe.test(id) || seen.has(id)) errs.push(`invalid or repeated item "${id}"`);
    else if (ids && !ids.has(id)) errs.push(`names unknown "${id}"`);
    seen.add(id);
  }
  return errs;
}

// Go matches JSON keys case-insensitively: only the exact, known names pass,
// so "Package" next to "package" cannot slip a second value past this check.
const closedKeys = (o, allowed, what, bad) => {
  if (typeof o !== "object" || o === null || Array.isArray(o)) return bad(`${what} must be an object`);
  for (const k of Object.keys(o)) if (!allowed.includes(k)) bad(`unknown ${what} field "${k}"`);
};

export function validateEntry(e) {
  const errs = [];
  const bad = (m) => errs.push(m);
  if (typeof e !== "object" || e === null || Array.isArray(e)) return ["entry must be an object"];
  for (const k of Object.keys(e)) if (!entryKeys.has(k)) bad(`unknown field "${k}"`);
  if (!str(e.id) || !idRe.test(e.id)) bad("id must be lowercase letters, digits and dashes (≤ 40)");
  for (const k of ["name", "summary", "license"]) if (!str(e[k]) || !e[k].trim()) bad(`"${k}" is required`);
  if (str(e.summary) && e.summary.length > 140) bad("summary is longer than 140 characters (one sentence)");
  if (!e.publisher || !str(e.publisher.name) || !e.publisher.name) bad("publisher.name is required");
  if (!categories.includes(e.category)) bad(`unknown category "${e.category}"`);
  if (!isHttps(e.homepage) || !isHttps(e.publisher?.url)) bad("homepage and publisher.url must be https URLs");
  if (!strs(e.keywords) || !strs(e.dependsOn)) bad("keywords and dependsOn must be lists of strings");
  if (!signIns.has(e.signIn ?? "")) bad(`unknown signIn "${e.signIn}"`);
  if (!updatesSet.has(e.updates ?? "")) bad(`unknown updates "${e.updates}"`);
  validateV2(e, bad);
  closedKeys(e.publisher, ["name", "url"], "publisher", bad);
  if (e.detect !== undefined) closedKeys(e.detect, ["command", "version", "pattern"], "detect", bad);
  if (e.grants !== undefined && !str(e.grants)) bad("grants must be text");
  if (typeof e.platforms !== "object" || e.platforms === null) {
    bad("no platforms");
    return errs;
  }
  for (const k of Object.keys(e.platforms)) if (k !== "wsl" && k !== "windows") bad(`platform "${k}" is not read by any version`);
  const w = e.platforms.windows;
  if (w !== undefined) {
    if (e.category === "agent-clis") bad("agent CLIs have no Windows platform");
    validateWinget(w, bad);
  }
  if (e.platforms.wsl !== undefined && (typeof e.platforms.wsl !== "object" || e.platforms.wsl === null)) {
    bad("platforms.wsl must be an object");
    return errs;
  }
  const p = e.platforms.wsl;
  const d = e.detect || {};
  if (!p) {
    if (!w) bad("no platform");
    else if (e.required || e.category === "agent-clis" || e.detect !== undefined) bad("a Windows-only entry is a tool and has no Linux detection");
    return errs;
  }
  if (!str(d.command) || !commandRe.test(d.command) || !Array.isArray(d.version) || d.version[0] !== d.command || !d.version.every(str)) {
    bad("detect must name a command and run it for the version");
  }
  if (d.pattern !== undefined) {
    try {
      new RegExp(d.pattern);
    } catch {
      bad("detect.pattern is not a regular expression");
    }
  }
  for (const k of Object.keys(p)) if (!platformKeys.has(k)) bad(`unknown platform field "${k}"`);
  if (p.hosts !== undefined && !(Array.isArray(p.hosts) && p.hosts.every(str))) bad("hosts must be a list of host names");
  if (p.repo !== undefined) closedKeys(p.repo, ["url", "suite", "components", "key", "fingerprint"], "repo", bad);
  if (p.tool !== undefined) closedKeys(p.tool, ["package", "version", "extras", "python", "resolvedAt"], "tool", bad);
  if (p.dist !== undefined) closedKeys(p.dist, ["version", "sha256"], "dist", bad);
  if (!str(p.driver) || !Object.hasOwn(drivers, p.driver) || p.driver === "winget") {
    bad(`unknown driver "${p.driver}" for a Linux platform`);
    return errs;
  }
  if (Boolean(e.required) !== (p.driver === "setup")) bad("a required entry, and only one, is installed by Setup");
  if ((e.category === "agent-clis") !== (p.driver === "cli")) bad("agent CLIs, and only they, use the cli driver");
  if (p.account !== undefined && p.account !== drivers[p.driver]) bad(`driver ${p.driver} runs as ${drivers[p.driver]}`);
  for (const f of p.families || []) if (!families.has(f)) bad(`unknown family "${f}"`);
  for (const a of p.after || []) if (!afterSet.has(a)) bad(`unknown post-step "${a}"`);
  for (const [k, v] of Object.entries(p.env || {})) {
    if (!envKeyRe.test(k) || envDenied(k) || !str(v) || !envValRe.test(v)) bad(`env ${k} is not allowed`);
  }
  for (const pkg of [...(p.packages || []), ...(p.conflicts || [])]) if (!debRe.test(pkg)) bad(`invalid package name "${pkg}"`);
  if (p.remove !== undefined) {
    for (const pkg of p.remove?.packages || []) if (!(p.packages || []).includes(pkg)) bad(`remove lists "${pkg}", which install does not put`);
    for (const k of Object.keys(p.remove ?? {})) if (k !== "packages" && k !== "keeps") bad(`unknown remove field "${k}"`);
  }
  if (p.dist !== undefined && p.driver !== "node-dist") bad("only node-dist takes a dist");
  if (p.release !== undefined && p.driver !== "github-release") bad("only github-release takes a release");
  if (p.tool !== undefined && p.driver !== "uv-tool") bad("only uv-tool takes a tool");
  if (p.noRecommends !== undefined && (typeof p.noRecommends !== "boolean" || (p.driver !== "apt" && p.driver !== "apt-repo"))) bad("only apt and apt-repo take noRecommends");
  switch (p.driver) {
    case "node-dist": {
      const dd = p.dist;
      if (!dd || !distVersionRe.test(dd.version)) bad("node-dist needs a pinned version");
      if (d.command !== "node") bad("node-dist installs node");
      for (const [k, v] of Object.entries(dd?.sha256 || {})) if (!distPlatforms.includes(k) || !sha256Re.test(v)) bad(`node-dist sha256 ${k} is not a platform and a SHA-256`);
      if (!dd?.sha256?.["linux-x64"]) bad("node-dist needs the linux-x64 SHA-256");
      if (!(p.hosts || []).includes("nodejs.org")) bad("node-dist must list nodejs.org in hosts");
      break;
    }
    case "uv-tool": {
      const t = p.tool;
      if (!t || !str(t.package) || !pypiRe.test(t.package) || !str(t.version) || !pyVersionRe.test(t.version)) bad("uv-tool needs a PyPI package and its pinned version");
      if ((t?.extras || []).length > 8 || !(t?.extras || []).every((x) => str(x) && extraRe.test(x))) bad("uv-tool takes at most 8 plain extras");
      if (t?.python !== undefined && !pythonRe.test(t.python)) bad("uv-tool python must be a version such as 3.12");
      if (!str(t?.resolvedAt) || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(t.resolvedAt) || Number.isNaN(Date.parse(t.resolvedAt)) || new Date(t.resolvedAt).getUTCFullYear() < 2020) bad("uv-tool needs resolvedAt, the UTC time its dependencies were resolved");
      if (!(e.dependsOn || []).includes("uv")) bad("uv-tool entries depend on uv");
      if (p.package || p.packages?.length || p.script || p.repo || p.hosts?.length || (p.env && Object.keys(p.env).length)) bad("uv-tool takes only its tool");
      break;
    }
    case "cli":
    case "setup":
      if (p.package || p.packages?.length || p.repo || p.release || p.script) bad(`driver ${p.driver} takes no parameters`);
      break;
    case "npm-global":
      if (!str(p.package) || !npmRe.test(p.package)) bad("npm-global needs a valid package name");
      break;
    case "github-release": {
      const r = p.release;
      if (!r || !repoRe.test(r.repo) || !assetRe.test(r.asset) || !commandRe.test(r.binary) || r.binary !== d.command) {
        bad("github-release needs a repo, an asset and the detected binary");
        break;
      }
      validateRelease(r, bad);
      for (const h of r.version ? ["github.com"] : ["api.github.com", "github.com"]) if (!(p.hosts || []).includes(h)) bad(`github-release must list ${h} in hosts`);
      break;
    }
    case "vendor-script":
      if (!onHosts(p.script || "", p.hosts)) bad("vendor-script needs an https script on the entry's hosts");
      break;
    case "apt":
      if (!p.packages?.length) bad("apt needs packages");
      break;
    case "apt-repo": {
      const r = p.repo;
      if (!r || !p.packages?.length || !onHosts(r.url, p.hosts) || !onHosts(r.key, p.hosts) || !fprRe.test(r.fingerprint) || !suiteRe.test(r.suite) || !compsRe.test(r.components)) {
        bad("apt-repo needs packages, a repository and key on its hosts, and a pinned fingerprint");
      }
      break;
    }
  }
  return errs;
}

export function validateCatalog(doc) {
  const out = [];
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return ["the catalog must be an object"];
  for (const k of Object.keys(doc)) if (!["version", "entries", "bundles"].includes(k)) out.push(`catalog: unknown field "${k}" (the serial is stamped when it is signed)`);
  if (doc.version !== 1) out.push("catalog: version must be 1");
  if (!Array.isArray(doc.entries) || doc.entries.length === 0) return [...out, "catalog: entries must be a non-empty list"];
  if (doc.entries.length > 500) out.push(`the catalog holds ${doc.entries.length} entries; the cap is 500`);
  const ids = new Set();
  for (const [i, e] of doc.entries.entries()) {
    const at = `entries[${i}] (${e?.id ?? "?"})`;
    for (const m of validateEntry(e)) out.push(`${at}: ${m}`);
    if (ids.has(e?.id)) out.push(`${at}: id is listed twice`);
    ids.add(e?.id);
  }
  if (doc.bundles !== undefined) {
    if (!Array.isArray(doc.bundles)) out.push("bundles must be a list");
    else {
      const bids = new Set();
      for (const [i, b] of doc.bundles.entries()) {
        for (const m of validateBundle(b, ids)) out.push(`bundles[${i}] (${b?.id ?? "?"}): ${m}`);
        if (bids.has(b?.id)) out.push(`bundles[${i}]: id is listed twice`);
        bids.add(b?.id);
      }
    }
  }
  for (const e of doc.entries) for (const dep of e?.dependsOn || []) if (!ids.has(dep)) out.push(`${e.id}: depends on unknown "${dep}"`);
  return out;
}

// ── the official source of each entry (network) ──────────────────────────
export async function get(url, { json = false, limit = 4 << 20, headers = {} } = {}) {
  const res = await fetch(url, { redirect: "follow", headers: { "User-Agent": "cognixws-software-validate", ...headers } });
  if (!res.url.startsWith("https://")) throw new Error(`${url} redirected off HTTPS`);
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > limit) throw new Error(`${url} is larger than ${limit} bytes`);
  return json ? JSON.parse(buf.toString("utf8")) : buf;
}
export const ghHeaders = () => (token ? { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" } : { Accept: "application/vnd.github+json" });

// A pinned release (schema v2): the asset of that tag's release, per pinned
// architecture, must hash to the catalog's sha256 (downloaded whole, 256 MiB
// cap), and when the entry names a checksums file the vendor's must list the
// same hash.
// The driver refuses a redirect to a host the entry does not name
// (release.go): so does this, hop by hop.
export async function getOnHosts(url, hosts, limit) {
  for (let hop = 0; hop < 5; hop++) {
    const u = new URL(url);
    if (u.protocol !== "https:" || !(hosts || []).includes(u.host)) throw new Error(`${url} is on a host the entry does not name`);
    const res = await fetch(url, { redirect: "manual", headers: { "User-Agent": "cognixws-software-validate" } });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      url = new URL(res.headers.get("location"), url).href;
      continue;
    }
    if (!res.ok) throw new Error(`GET ${url} returned ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > limit) throw new Error(`${url} is larger than ${limit} bytes`);
    return buf;
  }
  throw new Error(`${url}: too many redirects`);
}

async function checkPinnedRelease(e, r, hosts) {
  const tag = (r.tag || "v{version}").replaceAll("{version}", r.version);
  for (const [arch, want] of Object.entries(r.sha256)) {
    const fill = (t) => t.replaceAll("{version}", r.version).replaceAll("{arch}", arch).replaceAll("{target}", r.targets?.[arch] ?? "");
    const asset = fill(r.asset);
    const body = await getOnHosts(`https://github.com/${r.repo}/releases/download/${tag}/${asset}`, hosts, 256 << 20);
    const got = createHash("sha256").update(body).digest("hex");
    if (got !== want) fail(`${e.id}: ${asset} (${tag}) hashes to ${got}, the entry pins ${want}`);
    else notes.push(`${e.id}: ${arch} ${asset} ${tag} sha256 matches (${body.length} bytes)`);
    if (r.checksums) {
      const sums = (await get(`https://github.com/${r.repo}/releases/download/${tag}/${fill(r.checksums)}`)).toString("utf8");
      const line = sums.split("\n").find((l) => l.trim().split(/\s+/)[1]?.replace(/^\*/, "") === asset);
      if (!line || line.trim().split(/\s+/)[0].toLowerCase() !== want) fail(`${e.id}: ${fill(r.checksums)} does not list ${want} for ${asset}`);
    }
  }
}

async function checkSource(e) {
  const p = e.platforms.wsl;
  if (!p) return; // Windows-only: winget checks the vendor's installer against Microsoft's manifest
  switch (p.driver) {
    case "npm-global": {
      const meta = await get(`https://registry.npmjs.org/${p.package.replace("/", "%2f")}/latest`, { json: true });
      const repo = String(meta.repository?.url || meta.repository || "").replace(/^git\+/, "").replace(/\.git$/, "");
      if (!/^https:\/\/github\.com\/[^/]+\/[^/]+/.test(repo)) fail(`${e.id}: npm package ${p.package} names no GitHub repository (${repo || "none"})`);
      notes.push(`${e.id}: npm ${p.package}@${meta.version} from ${repo}`);
      return;
    }
    case "vendor-script": {
      const body = await get(p.script, { limit: 2 << 20 });
      if (!/^#!/.test(body.toString("utf8", 0, 64))) fail(`${e.id}: ${p.script} does not start with a #! line`);
      notes.push(`${e.id}: script ${p.script} sha256 ${createHash("sha256").update(body).digest("hex")} (${body.length} bytes)`);
      return;
    }
    case "github-release": {
      const r = p.release;
      const meta = await get(`https://api.github.com/repos/${r.repo}`, { json: true, headers: ghHeaders() });
      if (meta.private || meta.fork || meta.archived) fail(`${e.id}: ${r.repo} is private, a fork or archived`);
      if (r.version) return checkPinnedRelease(e, r, p.hosts);
      const rel = await get(`https://api.github.com/repos/${r.repo}/releases/latest`, { json: true, headers: ghHeaders() });
      const version = String(rel.tag_name).replace(/^v/, "");
      const names = new Set(rel.assets.map((a) => a.name));
      if (!names.has(r.checksums)) fail(`${e.id}: release ${rel.tag_name} has no ${r.checksums}`);
      for (const arch of ["amd64", "arm64"]) {
        const asset = r.asset.replaceAll("{version}", version).replaceAll("{arch}", arch);
        if (!names.has(asset)) fail(`${e.id}: release ${rel.tag_name} has no ${asset}`);
      }
      const sums = (await get(`https://github.com/${r.repo}/releases/download/${rel.tag_name}/${r.checksums}`)).toString("utf8");
      const amd = r.asset.replaceAll("{version}", version).replaceAll("{arch}", "amd64");
      if (!sums.split("\n").some((l) => l.trim().split(/\s+/)[1]?.replace(/^\*/, "") === amd)) fail(`${e.id}: ${r.checksums} does not list ${amd}`);
      notes.push(`${e.id}: ${r.repo} ${rel.tag_name}, checksums list the asset`);
      return;
    }
    case "node-dist": {
      const v = p.dist.version;
      const sums = (await get(`https://nodejs.org/dist/v${v}/SHASUMS256.txt`)).toString("utf8");
      for (const [plat, sum] of Object.entries(p.dist.sha256)) {
        const file = `node-v${v}-${plat}.tar.gz`;
        const line = sums.split("\n").find((l) => l.trim().endsWith(` ${file}`));
        if (!line || line.trim().split(/\s+/)[0] !== sum) fail(`${e.id}: nodejs.org's SHASUMS256.txt for v${v} does not list ${sum} for ${file}`);
      }
      notes.push(`${e.id}: node v${v}, SHA-256 per platform match nodejs.org's list`);
      return;
    }
    case "apt-repo": {
      for (const base of ["ubuntu", "debian"]) {
        const url = p.repo.key.replaceAll("{base}", base).replaceAll("{codename}", base === "ubuntu" ? "noble" : "bookworm");
        const key = await get(url, { limit: 1 << 20 });
        const dir = mkdtempSync(join(tmpdir(), "key-"));
        try {
          writeFileSync(join(dir, "k"), key);
          const out = execFileSync("gpg", ["--show-keys", "--with-colons", join(dir, "k")], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, GNUPGHOME: dir } });
          const fprs = out.split("\n").filter((l) => l.startsWith("fpr:")).map((l) => l.split(":")[9]);
          const primaries = out.split("\n").filter((l) => l.startsWith("pub:")).length;
          if (primaries !== 1 || fprs[0] !== p.repo.fingerprint) fail(`${e.id}: the key at ${url} is ${fprs[0] || "unreadable"}, the entry pins ${p.repo.fingerprint}`);
          else notes.push(`${e.id}: ${url} fingerprint ${fprs[0]} matches`);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
      return;
    }
    default:
      return; // apt: --apt checks the packages; cli and setup: recipes are the app's code
  }
}

function checkApt(e) {
  const p = e.platforms.wsl;
  if (!p || p.driver !== "apt") return;
  for (const pkg of p.packages) {
    try {
      const out = execFileSync("apt-cache", ["show", "--no-all-versions", pkg], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      const v = /^Version: (.+)$/m.exec(out)?.[1];
      if (!v) throw new Error("no version");
      notes.push(`${e.id}: ${pkg} ${v}`);
    } catch {
      fail(`${e.id}: package ${pkg} is not in this distribution's archive`);
    }
  }
}

// ── run ───────────────────────────────────────────────────────────────────
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { files, problems: treeProblems } = readTree();
  const doc = assemble(files);
  problems.push(...treeProblems, ...placementProblems(files), ...validateCatalog(doc));
  const ofFile = new Map(files.filter((f) => f.kind === "entry").map((f) => [f.doc.id, f.path]));
  for (const p of only) if (!files.some((f) => f.path === p && f.kind === "entry")) fail(`--entry ${p}: no such entry in the tree`);
  if (!problems.length && online) {
    for (const e of doc.entries) {
      if (only.length && !only.includes(ofFile.get(e.id))) continue;
      try {
        await checkSource(e);
      } catch (err) {
        fail(`${e.id}: ${err.message}`);
      }
    }
  }
  if (!problems.length && aptCheck) for (const e of doc.entries) checkApt(e);
  for (const n of notes) console.log(`  ${n}`);
  console.log(`catalog: ${doc.entries?.length ?? 0} entries${online ? (only.length ? `, sources of ${only.length} checked` : ", sources checked") : ""}${aptCheck ? ", apt packages checked" : ""}`);
  if (problems.length) {
    console.error(`\n${problems.length} problem(s):`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log("catalog OK");
}
