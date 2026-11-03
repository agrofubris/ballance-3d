# Release and versioning policy

A release is an annotated tag on `main`, GitHub's source archives of that tag, and one
desktop asset, `Ballance-3D-Stereo-vX.Y.Z-win-x64.zip`, built from the same commit.

## Rules

1. Tag the exact reviewed commit on `main` with an annotated tag `vMAJOR.MINOR.PATCH`;
   never move or recreate an existing tag.
2. Build the desktop asset from a clean working tree at that tag (the portable Python
   from `Setup-Ballance.bat` in `.tools/`): `npm run build:rapier`, then
   `npm run leia:build` (SR-lib and the SR SDK under `.local/reference/sr-lib`), then
   `npm run package:tester -- --no-ivp --release`, which writes
   `.local/release/Ballance-3D-Stereo-vX.Y.Z-win-x64.zip`.
   The release runs on Rapier and loads a player-built IVP module when one is installed
   (`Build-IVP.bat`). The Leia SR presenter ships with the SDK's permission notice; the
   SR runtime DLLs do not (they come with the player's SR Platform).
3. The asset contains no game content: no original or converted Ballance media, no
   `.local/`, no tests, captures or traces, and no IVP build.
4. `SOURCE_REVISION.txt` records the archived commit through `export-subst`, so a
   downloaded source snapshot identifies its revision without a tag.
5. Record the asset's size and SHA-256 in the release notes; after upload, download it
   again and compare.
6. Release notes come from `CHANGELOG.md`; do not alter older release notes.

## Versioning

`vMAJOR.MINOR.PATCH`: minor for feature batches, patch for fixes.
