#!/usr/bin/env node
// Validates catalog.json: the schema COGNIX[WS] enforces (internal/software
// in the app, ADR-0407 and ADR-0409), ids, HTTPS URLs, download hosts and
// pinned fingerprints. With --online it also checks each entry against its
// official source: the npm package and its repository, the vendor's script,
// the GitHub release and its checksums, the apt key's fingerprint. With
// --apt it checks that every apt package exists on this machine's
// distribution (CI runs it on Ubuntu 24.04 and Debian 12).
//
// No dependencies. Run: node scripts/validate.mjs [--online] [--apt]

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const online = args.has("--online");
const aptCheck = args.has("--apt");
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
const problems = [];
const notes = [];
const fail = (m) => problems.push(m);

// ── the schema (mirror of internal/software/catalog.go) ───────────────────
export const categories = ["agent-clis", "git", "containers", "cloud", "networking", "dev-tools", "packages", "runtime", "media"];
const drivers = {
  cli: "user", "npm-global": "user", "github-release": "user", "vendor-script": "user",
  apt: "root", "apt-repo": "root", setup: "user",
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
const entryKeys = new Set(["id", "name", "category", "required", "summary", "publisher", "homepage", "license", "keywords", "detect", "platforms", "dependsOn", "grants", "signIn", "updates"]);
const platformKeys = new Set(["families", "driver", "account", "hosts", "package", "packages", "env", "repo", "release", "script", "conflicts", "after", "remove"]);

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
  const d = e.detect || {};
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
  if (!signIns.has(e.signIn ?? "")) bad(`unknown signIn "${e.signIn}"`);
  if (!updatesSet.has(e.updates ?? "")) bad(`unknown updates "${e.updates}"`);
  const p = e.platforms?.wsl;
  if (!p) {
    bad("no platforms.wsl");
    return errs;
  }
  for (const k of Object.keys(e.platforms)) if (k !== "wsl") bad(`platform "${k}" is not read by any version yet`);
  for (const k of Object.keys(p)) if (!platformKeys.has(k)) bad(`unknown platform field "${k}"`);
  if (!(p.driver in drivers)) {
    bad(`unknown driver "${p.driver}"`);
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
  switch (p.driver) {
    case "cli":
    case "setup":
      if (p.package || p.packages?.length || p.repo || p.release || p.script) bad(`driver ${p.driver} takes no parameters`);
      break;
    case "npm-global":
      if (!str(p.package) || !npmRe.test(p.package)) bad("npm-global needs a valid package name");
      break;
    case "github-release": {
      const r = p.release;
      if (!r || !repoRe.test(r.repo) || !assetRe.test(r.asset) || !assetRe.test(r.checksums) || !commandRe.test(r.binary) || r.binary !== d.command) {
        bad("github-release needs a repo, an asset, a checksums file and the detected binary");
      }
      for (const h of ["api.github.com", "github.com"]) if (!(p.hosts || []).includes(h)) bad(`github-release must list ${h} in hosts`);
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
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return ["catalog.json must be an object"];
  for (const k of Object.keys(doc)) if (!["version", "entries"].includes(k)) out.push(`catalog.json: unknown field "${k}" (the serial is stamped when it is signed)`);
  if (doc.version !== 1) out.push("catalog.json: version must be 1");
  if (!Array.isArray(doc.entries) || doc.entries.length === 0) return [...out, "catalog.json: entries must be a non-empty list"];
  if (doc.entries.length > 500) out.push(`catalog.json holds ${doc.entries.length} entries; the cap is 500`);
  const ids = new Set();
  for (const [i, e] of doc.entries.entries()) {
    const at = `entries[${i}] (${e?.id ?? "?"})`;
    for (const m of validateEntry(e)) out.push(`${at}: ${m}`);
    if (ids.has(e?.id)) out.push(`${at}: id is listed twice`);
    ids.add(e?.id);
  }
  for (const e of doc.entries) for (const dep of e?.dependsOn || []) if (!ids.has(dep)) out.push(`${e.id}: depends on unknown "${dep}"`);
  return out;
}

// ── the official source of each entry (network) ──────────────────────────
async function get(url, { json = false, limit = 4 << 20, headers = {} } = {}) {
  const res = await fetch(url, { redirect: "follow", headers: { "User-Agent": "cognixws-software-validate", ...headers } });
  if (!res.url.startsWith("https://")) throw new Error(`${url} redirected off HTTPS`);
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > limit) throw new Error(`${url} is larger than ${limit} bytes`);
  return json ? JSON.parse(buf.toString("utf8")) : buf;
}
const ghHeaders = () => (token ? { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" } : { Accept: "application/vnd.github+json" });

async function checkSource(e) {
  const p = e.platforms.wsl;
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
  if (p.driver !== "apt") return;
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
  let doc;
  try {
    doc = JSON.parse(readFileSync(join(root, "catalog.json"), "utf8"));
  } catch (err) {
    console.error(`catalog.json is not valid JSON: ${err.message}`);
    process.exit(1);
  }
  problems.push(...validateCatalog(doc));
  if (!problems.length && online) {
    for (const e of doc.entries) {
      try {
        await checkSource(e);
      } catch (err) {
        fail(`${e.id}: ${err.message}`);
      }
    }
  }
  if (!problems.length && aptCheck) for (const e of doc.entries) checkApt(e);
  for (const n of notes) console.log(`  ${n}`);
  console.log(`catalog: ${doc.entries?.length ?? 0} entries${online ? ", sources checked" : ""}${aptCheck ? ", apt packages checked" : ""}`);
  if (problems.length) {
    console.error(`\n${problems.length} problem(s):`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log("catalog OK");
}
