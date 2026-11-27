# Review guidelines

An entry is COGNIX[WS]'s word that installing it from the app is sound. A
reviewer merges only when every line below holds.

## Official source only

- The package, release, script or repository is published by the vendor that
  `publisher` names, at a location that vendor documents on `homepage`:
  the npm package's repository is the vendor's (CI prints it), the release
  is the vendor's own GitHub repository, the script and the apt key are on
  the vendor's domain, an `apt` package is the distribution's own.
- No mirrors, forks, community taps or re-packagers. Nothing because it is
  installed on someone's machine.

## The entry

- An existing driver fits. A new way to install is a change to the app,
  reviewed as code, never an entry.
- `summary` is one sentence a person who avoids terminals understands.
- `license` is the SPDX expression of what installs.
- `detect` runs the installed command itself for its version.
- `env` holds only on/off switches that stop telemetry or edits to the
  person's shell profile.
- `apt-repo`: the fingerprint is the one the vendor publishes; CI checks the
  key at the URL against it. `github-release`: the release ships a checksums
  file that lists the asset. A pinned `github-release` (a `version` and a `sha256` per
  architecture) needs no checksums file: CI downloads each asset from the
  vendor's release and compares its hash with the pin, and a checksums file,
  when named, must list the same hash. `vendor-script`: CI prints the script's SHA-256;
  read the script once.
- Root (`apt`, `apt-repo`) and code (`cli`, `setup`) entries reach people with
  the next app release; say so in the pull request.

## Tier and placement

- `tier` is the reviewer's call: `official` is an entry COGNIX[WS] maintains,
  `community` is one an outside contributor proposed, pointing at the vendor's
  own distribution (never a personal fork). A pull request from outside the
  maintainers that says `official` is changed to `community` or refused.
- A community entry is one file and changes nothing that checks or signs the
  registry; CI checks it (from the base commit, by whether it comes from a fork, not by the tier the file claims); the reviewer confirms the license and the source, and `main`'s branch protection is what makes the check binding.
- The weekly refresh's pull request (`curator/weekly`) is read as a diff of
  pins: the audit table's held-back rows and any `license` line are the part
  to read twice. Merge it only when its checks are green.

## Withdrawing

Removing a user-account entry (`npm-global`, `github-release`,
`vendor-script`) withdraws it from every installation at their next check:
installed copies stay, the Catalog stops offering it. Do it when a source
moves, is compromised or stops being the vendor's.
