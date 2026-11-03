# Releasing

Releases are made by hand by the maintainer, jmozez. Nothing here runs automatically. Publishing needs the maintainer's npm security key.

1. Check that `main` is green in CI, including the `package` and `action` jobs, and that CodeQL has no open alerts.
2. Check that `version` in `package.json` is right, and that `CHANGELOG.md` lists every change under that version with today's date.
3. Run `npm ci && npm audit && npm run typecheck && npm run build && npm test && npm pack --dry-run`. Check the file list: `dist`, `hosts`, `action.yml`, `README.md`, `CHANGELOG.md` and `LICENSE`.
4. Check every entry in `hosts/hosts.yaml` against its source page, update `checked` dates, and bump the pack `version` if any rule changed.
5. Rebuild the screenshots with `npm run build && bash docs/images/make.sh` if the output changed.
6. Publish with `npm publish`. `prepublishOnly` runs the type check and tests again. To add provenance later, publish from a GitHub workflow with `npm publish --provenance`.
7. Tag the commit `vX.Y.Z`, push the tag, and create a GitHub release with the changelog section as its notes.
8. Move the `v0` tag to the new release so `jmozez/skillmedic@v0` in workflows picks it up.
