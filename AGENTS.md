# Agent Instructions

## Mandatory: Read GUIDANCE.md

At the start of every session and after every context compaction,
you **MUST** read and follow `GUIDANCE.md` in the repo root before
doing any work. It is the single source of truth for all
architectural and workflow decisions.

---

## Keep the Chinese Lite documentation in sync

- Treat `docs/lite/` as upstream English source. Put Chinese translations in `docs/zh-CN/lite/` with the same relative filenames. Apply translation-only changes in the Chinese tree.
- Whenever you sync upstream, or notice changes to the English Lite documentation, run `pnpm --dir docs/local-site translations:check`. If it reports changes, use the Git diff from `docs/local-site/translation-base.txt` to the current English source as the translation input and update the matching Chinese pages as part of the same task.
- Translate new or changed content, mirror document renames and removals, and verify the translated headings, anchors, code samples, and links. Reuse assets from the English tree. The bilingual site covers Babylon Lite's WebGPU documentation.
- Once all reported changes are reflected and `pnpm --dir docs/local-site build` succeeds, set `docs/local-site/translation-base.txt` to the full SHA of the synced English source commit and run the check again. Keep the previous baseline while translation work is incomplete. See [the docs site guide](docs/local-site/README.md).

---

## Release Commit Messages

The release pipeline decides between a minor and major release by scanning commit
messages since the last `npm-lite-v*` tag.

For normal changes, use Conventional Commit-style messages such as:

- `fix: correct texture upload alignment`
- `feat(loader): add KTX2 fallback handling`

For breaking changes, the final commit that lands on `master` **MUST** contain
one of these markers:

- `feat!: remove deprecated loader option`
- `feat(loader)!: change loadGltf return shape`
- `BREAKING CHANGE: describe the migration path`

Because GitHub squash merge usually builds the final commit from the PR title
and body, agents must make sure breaking-change markers are present in the PR
title/body or in the final squash message, not only in an intermediate local
commit. If a PR is labeled `breaking`, `breaking change`, `major`, or
`semver-major`, PR CI will require a marker in the PR title/body when the
release-marker job has a repo-scoped `GITHUB_TOKEN` available to read PR labels.

Releases are published by the internal Azure DevOps release pipeline, which
tags the released master commit as `npm-lite-v<X.Y.Z>`; that tag triggers
`azure-pipelines-playground-release.yml` to deploy the versioned playground. The
public `azure-pipelines-npm-publish.yml` and `azure-pipelines-npm-publish-gl.yml`
pipelines are retired (manual emergency fallback only), so editing
`config/release.json` or `config/release-gl.json` no longer requests a release.
Release version resolution scans commits since the previous `npm-lite-v*`
release tag for breaking-change markers, so a missing marker can hide a breaking
change inside a minor or patch release.

### Guardrails (Non-Negotiable)

- **Never run the all-scene suite unless the user explicitly requests it** — do not execute `pnpm test`, full `pnpm test:parity`, or an unfiltered `pnpm build:bundle-scenes`. CI owns repository-wide scene coverage.
- **Run focused validation before declaring success** — use the narrowest relevant unit tests, filtered scene bundles, lint, and typecheck for the changed subsystem.
- **Do not run visual/parity tests locally unless explicitly requested** — CI owns screenshot and MAD validation.
- **No MAD regression in affected scenes** — the relevant CI parity checks must pass.
- **All focused agent-allowed tests green** — scoped non-visual and bundle-size checks must pass. Perf and visual tests are user/CI-only.
- **No bundle-size regression** — bundle size must stay within ceilings.
- **No ceiling updates** — bundle-size test thresholds cannot be changed without explicit user approval.
- **Do not sacrifice semantics or conventions for trivial byte savings** — never weaken naming, readability, diagnostics, correctness, or maintainability merely to save a few bundle bytes. If a correct, convention-preserving implementation misses a ceiling by only a few bytes, keep the correct design and request explicit approval before adjusting the ceiling instead of distorting the code to win the threshold.
- **No golden reference changes** — reference screenshots are immutable unless user explicitly requests update.
