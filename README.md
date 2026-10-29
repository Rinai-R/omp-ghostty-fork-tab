# omp-ghostty-fork-tab

An [omp](https://omp.sh) extension for macOS Ghostty: typing a bare `/fork` opens a new Ghostty tab running `omp --fork <current session>`, switches to it, and leaves the parent session running in the original tab.

omp's built-in `/fork pane|window|tab` only supports tmux, Zellij, Herdr, CMUX, and Orca. This extension adds the equivalent for Ghostty through its AppleScript `new tab` API.

## Behavior

- `/fork` is intercepted only when running directly in Ghostty on macOS (not inside tmux, Zellij, screen, CMUX, Herdr, wmux, or Orca). Everywhere else the built-in `/fork` runs unchanged.
- The child starts from the persisted transcript with `omp --fork`, so it is a real fork: the new session records `parentSession` and inherits the provider prompt-cache key.
- The new tab is selected explicitly, so you land in the forked conversation.
- Streaming sessions ask for confirmation first; in-memory sessions and vibe mode are rejected.
- `--profile`, `PI_CONFIG_*`/XDG scope variables are forwarded to the child.

## Install

From git:

```sh
omp plugin install github:Rinai-R/omp-ghostty-fork-tab
```

Or clone and link a local checkout:

```sh
git clone https://github.com/Rinai-R/omp-ghostty-fork-tab
omp plugin link ./omp-ghostty-fork-tab
```

Restart omp (or run `/restart`) after installing. The first launch triggers the macOS Automation permission prompt for controlling Ghostty.

## Notes

- TypeScript extension module loaded directly by omp's Bun runtime; no build step.
- The Ghostty launch is done by generating AppleScript and running it through `osascript`.
- The extension does not take over `/fork tab`, `/fork window`, or `/fork pane`; those keep omp's built-in behavior.

## Release

Pushing a `v*` tag runs [`.github/workflows/release.yml`](.github/workflows/release.yml): it checks the tag against `package.json`, smoke-tests the extension with Bun, publishes to npm with provenance, and creates the GitHub release.

```sh
git tag v0.1.0
git push origin v0.1.0
```

The workflow needs `NPM_TOKEN` as an Actions secret (or variable). Bump `package.json` before tagging; a mismatched tag fails the run.

