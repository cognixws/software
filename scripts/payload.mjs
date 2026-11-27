// The signed payload: the catalog's fields plus the serial and the issue time.
// Starter sets (bundles) travel in it; without them an app falls back to its
// seed's sets and the registry could never change one.
export function buildPayload(doc, serial, issued) {
  const out = { version: doc.version, serial, issued, entries: doc.entries };
  if (doc.bundles !== undefined) out.bundles = doc.bundles;
  return Buffer.from(JSON.stringify(out));
}
