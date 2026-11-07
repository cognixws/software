#!/usr/bin/env node
// Signs catalog.json into the published index (ADR-0409):
//
//   payload   = catalog.json with "serial" and "issued" stamped in
//   signature = Ed25519 over the payload's exact bytes
//   output    = {"payload": base64(payload), "signature": base64(signature)}
//
// The private key is SOFTWARE_INDEX_KEY: the 32-byte Ed25519 seed, base64.
// It exists only as a secret of this repository's "index-signing"
// environment; the publish workflow is the only reader. The signature is
// checked against keys/index.pub before anything is written, so a wrong
// secret never publishes.
//
// Run: SOFTWARE_INDEX_KEY=… node scripts/sign.mjs --serial N --out software-index.json

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { validateCatalog } from "./validate.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const arg = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const die = (m) => {
  console.error(m);
  process.exit(1);
};

const serial = Number(arg("--serial"));
const out = arg("--out");
if (!Number.isSafeInteger(serial) || serial < 1 || !out) die("usage: sign.mjs --serial N --out FILE");

const seed = Buffer.from(process.env.SOFTWARE_INDEX_KEY || "", "base64");
if (seed.length !== 32) die("SOFTWARE_INDEX_KEY must be a base64 32-byte Ed25519 seed");
// PKCS#8 wrapping of a raw Ed25519 seed (RFC 8410).
const key = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), format: "der", type: "pkcs8" });
const pubRaw = Buffer.from(readFileSync(join(root, "keys/index.pub"), "utf8").trim(), "base64");
const pub = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), pubRaw]), format: "der", type: "spki" });

const doc = JSON.parse(readFileSync(join(root, "catalog.json"), "utf8"));
const problems = validateCatalog(doc);
if (problems.length) die(`catalog.json is not valid:\n  ${problems.join("\n  ")}`);

const payload = Buffer.from(JSON.stringify({ version: doc.version, serial, issued: new Date().toISOString().replace(/\.\d+Z$/, "Z"), entries: doc.entries }));
const signature = sign(null, payload, key);
if (!verify(null, payload, pub, signature)) die("the signing key does not match keys/index.pub; nothing was written");
writeFileSync(out, JSON.stringify({ payload: payload.toString("base64"), signature: signature.toString("base64") }) + "\n");
console.log(`signed serial ${serial}: ${doc.entries.length} entries, ${payload.length} bytes`);
