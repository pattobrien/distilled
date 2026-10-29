# pattobrien/distilled

This repository is a fork of [alchemy-run/distilled](https://github.com/alchemy-run/distilled). It
publishes every package to GitHub Packages under the `@pattobrien` scope, so
[pattobrien/alchemy](https://github.com/pattobrien/alchemy) can depend on changes that upstream has
not merged yet.

## What this fork carries

- Inngest accepts the `X-Inngest-Env` header and types the app and environment errors seen live.
  Upstream PR: [alchemy-run/distilled#834](https://github.com/alchemy-run/distilled/pull/834).
- Inngest generates the v1 REST API with typed webhook errors. Upstream PR:
  [alchemy-run/distilled#835](https://github.com/alchemy-run/distilled/pull/835).
- The Linear SDK in `packages/linear`. Upstream PR:
  [alchemy-run/distilled#698](https://github.com/alchemy-run/distilled/pull/698).
- The Tailscale SDK in `packages/tailscale`, based on upstream PR
  [alchemy-run/distilled#956](https://github.com/alchemy-run/distilled/pull/956).
- The fork release workflow `.github/workflows/release-fork.yml` and its scripts
  `scripts/release/fork-publish.ts` and `scripts/release/fork-next-version.ts`.

Remove an item from this list once upstream merges its PR and a sync brings the change in.

## Packages

Every non-private `@distilled.cloud/<pkg>` publishes as `@pattobrien/distilled-<pkg>` to
`https://npm.pkg.github.com`. For example, `@distilled.cloud/inngest` publishes as
`@pattobrien/distilled-inngest`. Source `package.json` names never change. The release script
rewrites names and internal `@distilled.cloud/*` dependencies to `npm:` aliases at publish time.
It also rewrites each package's imports of itself in `lib` to the fork name, so they resolve
through the package self-reference.

A fork tag is `v<upstream>-fork.N`, and the published version drops the `v`. `<upstream>` is the
shared `version` in `packages/*/package.json`. For example, tag `v1.0.0-rc.13-fork.2` publishes
version `1.0.0-rc.13-fork.2`. N increases with every fork release and never reuses a number that
has a tag.

## Releasing

Every push to `main` that touches `packages/**`, `pnpm-lock.yaml` or the publish script runs
`release-fork.yml`. The workflow computes the next version with
`scripts/release/fork-next-version.ts`: the shared `version` plus `-fork.N`, where N is one more
than the highest `v*-fork.*` tag on the remote. It builds, publishes every package, then tags the
commit `v<version>`. Runs on `main` share one concurrency group and never cancel each other, so each
gets its own N. The publish script skips any package version that is already on the registry.

Pushing a `v<upstream>-fork.N` tag by hand publishes that exact version. To publish an existing
fork version again from `main`, run the workflow by hand with the `version` input:

```sh
gh workflow run release-fork.yml -R pattobrien/distilled -f version=1.0.0-rc.13-fork.2
```

Leaving the input empty publishes the next fork.N. To preview the package map locally, run
`node scripts/release/fork-publish.ts --dry-run <upstream>-fork.N`. The dry run rewrites every
`packages/*/package.json` in place, so run `git checkout -- packages` afterwards.

## Syncing from upstream

Add the upstream remote once with
`git remote add upstream https://github.com/alchemy-run/distilled.git`.

1. Create a branch from `main`.
2. Merge upstream into the branch:

   ```sh
   git fetch upstream
   git merge --no-ff upstream/main
   ```

3. Open a PR into `main`.

Never rebase or force-push `main` or any pushed branch. After the sync lands, re-pin
`submodules/distilled` in pattobrien/alchemy to the new `main`.
