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
  file that lists the asset. `vendor-script`: CI prints the script's SHA-256;
  read the script once.
- Root (`apt`, `apt-repo`) and code (`cli`, `setup`) entries reach people with
  the next app release; say so in the pull request.

## Withdrawing

Removing a user-account entry (`npm-global`, `github-release`,
`vendor-script`) withdraws it from every installation at their next check:
installed copies stay, the Catalog stops offering it. Do it when a source
moves, is compromised or stops being the vendor's.
