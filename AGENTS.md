# Zapture Desktop

Electron application for macOS and Windows. Keep privileged operations in `src/main`, expose the smallest typed bridge from `src/preload`, and treat `src/renderer` as an untrusted browser surface.

Use the project skills when applicable:

- `.agents/skills/zapture-desktop-development/SKILL.md` for recorder, Electron, IPC, hosted-editor, and desktop test work.
- `.agents/skills/zapture-desktop-release/SKILL.md` for packaging, signing, updater, GitHub Actions, and release work.

Never place signing material, GitHub tokens, Cloudflare credentials, or render-service credentials in the desktop bundle. Preview packages must remain unsigned and must never publish updates.
