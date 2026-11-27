#!/usr/bin/env node
// The weekly catalog refresh (OD4). For every pinned github-release entry it
// looks for a newer upstream release and, when one clears the checks, rewrites
// that entry's file with the new version, the per-architecture SHA-256 and
// updatedAt. It never signs, never pushes and never merges: the workflow
// opens one pull request from what this leaves in the working tree, and a
// maintainer merges it.
//
// A candidate is held back (the old pin stays live, the report says why) when
//   - it is younger than the cool-off (24 h),
//   - a pinned asset is missing, renamed, or a checksums file disagrees,
//   - the upstream license is not the one the entry records, or is one the
//     catalog never carries (non-commercial, BUSL, SSPL, proprietary),
//   - it fails the smoke proof: the new binary runs its detect command in a
//     clean ubuntu:24.04 and debian:12 container (--smoke).
// node-dist and uv-tool pins are reported, not changed: their pins carry
// facts only a human or the app's container test can re-prove.
//
// Run: node scripts/curate.mjs [--dry-run] [--smoke] [--report FILE] [--summary FILE]
// Reads GITHUB_TOKEN / GH_TOKEN for the API rate limit. Exit 0 whether or not
// anything changed; non-zero only when the refresh itself could not run.

import { writeFileSync, appendFileSync, mkdtempSync, rmSync, chmodSync, lstatSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readTree, serialize, root } from "./tree.mjs";
import { get, getOnHosts, ghHeaders, assetFormat } from "./validate.mjs";

export const COOL_OFF_MS = 24 * 3600 * 1000;
const blockedLicense = /^(BUSL|SSPL|Elastic|Commons-Clause|CC-BY-NC|CC-BY-ND|LicenseRef|proprietary|NOASSERTION|NONE)/i;
export const images = ["ubuntu:24.04", "debian:12"];

const numeric = (v) => v.split(/[.-]/).slice(0, 3).map((x) => parseInt(x, 10) || 0);
// > 0 when a is newer than b.
export function cmpVersion(a, b) {
  const x = numeric(a);
  const y = numeric(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

// The version a tag names under the entry's tag template ("v{version}").
export function versionOfTag(tag, template = "v{version}") {
  const [pre, post] = template.split("{version}");
  if (!tag.startsWith(pre) || !tag.endsWith(post)) return "";
  const v = tag.slice(pre.length, tag.length - post.length);
  return /^[0-9]+\.[0-9]+\.[0-9]+$/.test(v) ? v : "";
}

// SPDX ids an entry's license expression allows ("MIT OR Apache-2.0").
const spdxSet = (expr) => new Set(String(expr).split(/[\s()]+/).filter((t) => t && !/^(AND|OR|WITH)$/i.test(t)));

export function licenseVerdict(recorded, upstream) {
  if (!upstream) return { ok: false, note: "upstream states no license" };
  if (blockedLicense.test(upstream)) return { ok: false, note: `upstream license is ${upstream}, which the catalog does not carry` };
  if (!spdxSet(recorded).has(upstream)) return { ok: false, note: `upstream license is ${upstream}, the entry records ${recorded}` };
  return { ok: true, note: `${upstream}, as recorded` };
}

const fill = (t, r, v, arch) => t.replaceAll("{version}", v).replaceAll("{arch}", arch).replaceAll("{target}", r.targets?.[arch] ?? "");

// What a refresh needs from the world, injectable so the decision table is tested.
export const live = {
  now: () => Date.now(),
  releases: (repo) => get(`https://api.github.com/repos/${repo}/releases?per_page=30`, { json: true, headers: ghHeaders() }),
  repo: (repo) => get(`https://api.github.com/repos/${repo}`, { json: true, headers: ghHeaders() }),
  download: (url, hosts) => getOnHosts(url, hosts, 256 << 20),
  text: async (url) => (await get(url)).toString("utf8"),
  smoke: (e, r, v, bytes) => smoke(e, r, v, bytes),
};

// One pinned entry → a decision: "current", "held" or "bump".
export async function refresh(e, io = live) {
  const p = e.platforms.wsl;
  const r = p.release;
  const out = { id: e.id, from: r.version, status: "current", notes: [] };
  const rels = await io.releases(r.repo);
  const cutoff = io.now() - COOL_OFF_MS;
  const fresh = rels
    .filter((x) => !x.draft && !x.prerelease && versionOfTag(x.tag_name, r.tag))
    .sort((a, b) => cmpVersion(versionOfTag(b.tag_name, r.tag), versionOfTag(a.tag_name, r.tag)));
  const newest = fresh[0];
  if (!newest || cmpVersion(versionOfTag(newest.tag_name, r.tag), r.version) <= 0) return out;
  // The newest release that cleared the cool-off, if it is still newer than the pin.
  const eligible = fresh.find((x) => Date.parse(x.published_at) <= cutoff);
  const eligibleV = eligible && versionOfTag(eligible.tag_name, r.tag);
  if (!eligible || cmpVersion(eligibleV, r.version) <= 0) {
    return { ...out, status: "held", to: versionOfTag(newest.tag_name, r.tag), notes: [`released ${newest.published_at}, inside the 24 h cool-off`] };
  }
  const v = eligibleV;
  out.to = v;
  const meta = await io.repo(r.repo);
  const lic = licenseVerdict(e.license, meta.license?.spdx_id);
  out.license = lic.note;
  if (!lic.ok) return { ...out, status: "held", notes: [`license: ${lic.note}`] };
  if (meta.archived || meta.private) return { ...out, status: "held", notes: [`${r.repo} is archived or private`] };

  const tag = eligible.tag_name;
  const sha256 = {};
  const bytesByArch = {};
  for (const arch of Object.keys(r.sha256)) {
    const asset = fill(r.asset, r, v, arch);
    let body;
    try {
      body = await io.download(`https://github.com/${r.repo}/releases/download/${tag}/${asset}`, p.hosts);
    } catch (err) {
      return { ...out, status: "held", notes: [`${asset} (${tag}): ${err.message}; the pin stays at ${r.version}`] };
    }
    sha256[arch] = createHash("sha256").update(body).digest("hex");
    bytesByArch[arch] = body;
    const listed = eligible.assets?.find((a) => a.name === asset)?.digest;
    if (listed && listed !== `sha256:${sha256[arch]}`) return { ...out, status: "held", notes: [`${asset}: GitHub's digest ${listed} differs from the download's ${sha256[arch]}`] };
    if (r.checksums) {
      const sums = await io.text(`https://github.com/${r.repo}/releases/download/${tag}/${fill(r.checksums, r, v, arch)}`);
      const line = sums.split("\n").find((l) => l.trim().split(/\s+/)[1]?.replace(/^\*/, "") === asset);
      if (!line || line.trim().split(/\s+/)[0].toLowerCase() !== sha256[arch]) return { ...out, status: "held", notes: [`${r.checksums} does not list ${sha256[arch]} for ${asset}`] };
      out.notes.push(`${arch}: ${r.checksums} lists the hash`);
    } else if (listed) out.notes.push(`${arch}: upstream publishes only GitHub's release digest, which matches`);
    else out.notes.push(`${arch}: upstream publishes no checksum; the hash is the one COGNIX[WS] computed`);
  }
  if (bytesByArch.amd64 && io.smoke) {
    const s = await io.smoke(e, r, v, bytesByArch.amd64);
    out.smoke = s;
    if (!s.ok) return { ...out, status: "held", notes: [...out.notes, `smoke proof failed: ${s.detail}`] };
  }
  return { ...out, status: "bump", sha256, tag };
}

// The new bytes run the entry's own version command in each clean image.
function smoke(e, r, v, bytes) {
  const format = assetFormat(fill(r.asset, r, v, "amd64"));
  const dir = mkdtempSync(join(tmpdir(), "curate-"));
  try {
    const file = join(dir, "asset");
    writeFileSync(file, bytes);
    const work = join(dir, "x");
    execFileSync("mkdir", [work]);
    let bin = join(work, r.binary);
    if (format === "binary") execFileSync("cp", [file, bin]);
    else {
      if (format === "zip") execFileSync("unzip", ["-q", file, "-d", work]);
      else execFileSync("tar", ["-xf", file, "-C", work]);
      const rel = r.path ? fill(r.path, r, v, "amd64") : r.binary;
      bin = join(work, rel);
      // lstat: a symlink in the archive must not point the mount at a host file.
      let st;
      try { st = lstatSync(bin); } catch { st = null; }
      if (!st || !st.isFile()) return { ok: false, detail: `${rel} is not a regular file in the archive (${readdirSync(work).join(", ")})` };
    }
    chmodSync(bin, 0o755);
    const [, ...rest] = e.detect.version;
    const pattern = new RegExp(e.detect.pattern || "[0-9]+\\.[0-9]+");
    const seen = [];
    for (const image of images) {
      let out;
      try {
        out = execFileSync("docker", ["run", "--rm", "--network", "none", "-v", `${bin}:/opt/tool:ro`, image, "/opt/tool", ...rest], { encoding: "utf8", timeout: 120000, stdio: ["ignore", "pipe", "pipe"] });
      } catch (err) {
        return { ok: false, detail: `${image}: ${String(err.stderr || err.message).trim().slice(0, 200)}` };
      }
      if (!pattern.test(out)) return { ok: false, detail: `${image}: output "${out.trim().slice(0, 80)}" has no version` };
      seen.push(`${image}: ${out.trim().split("\n")[0].slice(0, 60)}`);
    }
    return { ok: true, detail: seen.join("; ") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function apply(file, doc, result, today) {
  const r = doc.platforms.wsl.release;
  r.version = result.to;
  r.sha256 = result.sha256;
  doc.updatedAt = today;
  writeFileSync(file, serialize(doc));
}

// Upstream text goes into a table cell: no pipes, no markup, no line breaks.
const cell = (t) => String(t).replace(/[|`<>\r\n]+/g, " ").trim();

export function report(results, info, today) {
  const rows = results.filter((x) => x.status !== "current");
  const lines = [`## Catalog refresh, ${today}`, ""];
  if (!rows.length && !info.length) return lines.concat("Every pin is current; nothing to merge.", "").join("\n");
  if (rows.length) {
    lines.push("| Entry | Pinned | Upstream | Result | Evidence |", "|---|---|---|---|---|");
    for (const x of rows) {
      const result = x.status === "bump" ? "bumped" : "**held back**";
      const evidence = cell([...(x.notes ?? []), x.license && x.status === "bump" ? `license ${x.license}` : "", x.smoke ? `smoke: ${x.smoke.detail}` : ""].filter(Boolean).join("; "));
      lines.push(`| \`${x.id}\` | ${cell(x.from)} | ${cell(x.to ?? "?")} | ${result} | ${evidence} |`);
    }
    lines.push("");
  }
  if (info.length) lines.push("Reported, not changed (re-proved by a person or the app's container test):", "", ...info.map((i) => `- ${i}`), "");
  lines.push("This pull request was opened by the refresh workflow. It changes pins only; a maintainer reviews and merges it, and the merge signs the next index.", "");
  return lines.join("\n");
}

async function pinsReport(files) {
  const out = [];
  for (const f of files) {
    const p = f.doc.platforms?.wsl;
    try {
      if (p?.driver === "uv-tool") {
        const meta = await get(`https://pypi.org/pypi/${p.tool.package}/json`, { json: true });
        if (cmpVersion(meta.info.version, p.tool.version) > 0) out.push(`\`${f.doc.id}\`: ${p.tool.package} ${p.tool.version} → ${meta.info.version} on PyPI`);
      } else if (p?.driver === "node-dist") {
        const idx = await get("https://nodejs.org/dist/index.json", { json: true });
        const major = p.dist.version.split(".")[0];
        const next = idx.find((x) => x.version.startsWith(`v${major}.`) && x.lts);
        if (next && cmpVersion(next.version.slice(1), p.dist.version) > 0) out.push(`\`${f.doc.id}\`: Node ${p.dist.version} → ${next.version.slice(1)} (same major, LTS)`);
      }
    } catch (err) {
      out.push(`\`${f.doc.id}\`: upstream could not be read (${err.message})`);
    }
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const arg = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined);
  const dry = argv.includes("--dry-run");
  const io = { ...live, smoke: argv.includes("--smoke") ? live.smoke : null };
  const today = new Date(io.now()).toISOString().slice(0, 10);
  const { files } = readTree();
  const pinned = files.filter((f) => f.kind === "entry" && f.doc.platforms?.wsl?.driver === "github-release" && f.doc.platforms.wsl.release.version);
  const results = [];
  for (const f of pinned) {
    try {
      const x = await refresh(f.doc, io);
      results.push(x);
      if (x.status === "bump" && !dry) apply(join(root, f.path), f.doc, x, today);
      console.log(`${f.doc.id}: ${x.status}${x.to ? ` ${x.from} → ${x.to}` : ` ${x.from}`}${x.status === "held" ? ` (${x.notes.join("; ")})` : ""}`);
    } catch (err) {
      results.push({ id: f.doc.id, from: f.doc.platforms.wsl.release.version, status: "held", notes: [`the refresh could not read upstream: ${err.message}`] });
      console.log(`${f.doc.id}: held (${err.message})`);
    }
  }
  const md = report(results, await pinsReport(files), today);
  if (arg("--report")) writeFileSync(arg("--report"), md);
  const bumps = results.filter((x) => x.status === "bump");
  const changed = bumps.length > 0 && !dry;
  if (arg("--summary")) writeFileSync(arg("--summary"), JSON.stringify({ changed, bumps: bumps.map((x) => `${x.id} ${x.from} → ${x.to}`), held: results.filter((x) => x.status === "held").map((x) => x.id) }, null, 2) + "\n");
  const heldN = results.filter((x) => x.status === "held").length;
  // Something a person should read even when no pin moved: a held-back candidate or a reported pin.
  const notes = heldN > 0 || md.includes("Reported, not changed");
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changed}\nbumps=${bumps.length}\nheld=${heldN}\nnotes=${notes}\n`);
  console.log(`refresh: ${pinned.length} pinned, ${bumps.length} bumped, ${results.filter((x) => x.status === "held").length} held back`);
}
