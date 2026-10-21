# Zapture Desktop

Open-source Electron recorder for [Zapture](https://zapture.app), for macOS 13+ and Windows 10 22H2+.

Licensed under the [GNU AGPL v3](LICENSE).

## Layout

- `src/main`: privileged main process (recording, uploads, updater)
- `src/preload`: the small typed bridge exposed to the renderer
- `src/renderer`: React UI, treated as an untrusted browser surface
- `packages/recorder-core`: recorder logic shared with the main process (bundled at build time)

## Development

```bash
bun install
bun run dev          # electron-vite dev
bun run test
bun run typecheck
bun run build        # also verifies the runtime bundles have no raw workspace imports
bun run package:mac  # unsigned unless DESKTOP_PRODUCTION=true plus signing secrets
bun run package:win
```

Packaged builds accept `--ci-smoke` to boot and exit, which CI uses.

## CI

- `preview.yml`: unsigned builds for PRs labelled `desktop`, or on manual dispatch. Uses no secrets and never publishes.
- `release.yml`: manual dispatch with a semver version. Signs, notarizes, and publishes a GitHub release. Requires the protected `zapture-desktop-production` environment and its signing secrets.

## Security

Never commit signing material, tokens, or service credentials. Report vulnerabilities privately to the maintainers rather than in a public issue.
