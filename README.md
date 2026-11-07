# COGNIX[WS] software catalog

This repository is the signed registry behind **Software › Catalog** in
[COGNIX[WS]](https://cognix.ws): the tools a person can install on their
computer from the app, each with the official source it comes from and how
the app checks it. It holds data, never installers: an entry names one of the
app's drivers and fills its parameters.

- `catalog.json` — the catalog, one object per entry.
- `scripts/validate.mjs` — the schema the app enforces, plus `--online`
  (each entry against its official source) and `--apt` (each package in the
  distribution's archive). `node --test scripts/validate.test.mjs` proves it
  refuses what the app refuses.
- `scripts/sign.mjs` — signs the catalog into `software-index.json`.
- `keys/index.pub` — the public key the app compiles to verify the index.
- `GUIDELINES.md` — what a reviewer checks before an entry merges.

## How a change reaches people

```
pull request ──▶ validate (schema · official source · fingerprints · apt on Ubuntu 24.04 and Debian 12)
     │ human review (GUIDELINES.md), merge
     ▼
main ──▶ publish: validate again ▶ serial = last release + 1 ▶ sign (Ed25519) ▶ release vN
                                                                    │ software-index.json, catalog.json
                                                                    ▼
COGNIX[WS] (on a visit to the Catalog, or Check for updates):
  download releases/latest/download/software-index.json over HTTPS
  ▶ verify the signature with the compiled key ▶ refuse a serial older than the one it has
  ▶ keep it as the catalog (cached; never in backups) — anything else: the catalog the app carries
```

The index is `{"payload": base64, "signature": base64}`. The payload is
`catalog.json` with `serial` (strictly increasing) and `issued` stamped in;
the signature is Ed25519 over the payload's exact bytes.

## The signing key

The private key exists only as the secret `SOFTWARE_INDEX_KEY` of this
repository's `index-signing` environment, which only `main` may use. Nobody
holds a copy: it was generated straight into the secret. If it is lost or
exposed, a new key is generated the same way, its public half is added to
`keys/index.pub` and to the app's compiled list in a release, and the old one
is dropped in the release after.

## What the app takes from the index

Entries whose recipe is data run under the person's account — `npm-global`,
`github-release`, `vendor-script` — come from the index: a merge here adds,
changes or withdraws them for every installation. Entries whose recipe is the
app's code or runs as administrator — `cli` (agent CLIs), `setup`, `apt`,
`apt-repo` — are listed here too, and the app uses its compiled copy of them:
a new one reaches people with the next COGNIX[WS] release.

## Adding an entry

1. Read [GUIDELINES.md](GUIDELINES.md): only official sources, one sentence,
   an existing driver.
2. Add one object to `catalog.json` and run `node scripts/validate.mjs --online`.
3. Open a pull request. CI validates it; a maintainer reviews and merges;
   the merge publishes the next signed index.
