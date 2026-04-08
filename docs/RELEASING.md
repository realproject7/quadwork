# Releasing QuadWork

This doc describes how to cut a new QuadWork release, including the one-time
GitHub Releases backfill for the existing v1.0.x–v1.3.x tags.

## Prerequisites

- `gh` authenticated against `realproject7/quadwork` with repo write access
- `npm` logged in to the `quadwork` package (`npm whoami` should print your
  publisher account)
- Clean working tree on `main`, fast-forwarded from `origin/main`
- Branch protection allows tag push (current setting allows it)

## Standard release — minor / patch / major

The `package.json` scripts wrap the whole chain so you never have to remember
the order:

```bash
# Bug fix bump — v1.3.0 → v1.3.1
npm run release:patch

# Feature bump — v1.3.0 → v1.4.0
npm run release:minor

# Breaking change bump — v1.3.0 → v2.0.0
npm run release:major
```

What the script does (`release:patch` shown, others identical except the
`npm version` flag):

1. `npm version patch` — bumps `package.json` + `package-lock.json` and
   commits the change on `main` with a `vX.Y.Z` tag.
2. `git push origin main --follow-tags` — pushes the bump commit **and** the
   new tag in one go (so CI / downstream consumers see them together).
3. `gh release create vX.Y.Z --generate-notes --latest` — creates the
   GitHub Release. `--generate-notes` auto-writes the body from merged PRs
   since the previous tag; `--latest` marks this release as the current
   "Latest" on the repo landing page.
4. `npm publish` — publishes to npm using the tarball the `prepack` script
   built.

The scripts are all one-liners so you can rerun pieces by hand if any step
fails (e.g. if `npm publish` 409s, just rerun that step once).

## One-time backfill of historical tags

Before the `release:*` scripts existed, versions v1.0.x–v1.3.0 were published
to npm and tagged in git but **no corresponding GitHub Release** was created.
The backfill loop below creates one Release per historical tag with
auto-generated notes. Run it **once** from the repo root (requires `gh`
authed to `realproject7/quadwork`):

```bash
# From the repo root of realproject7/quadwork:
git fetch --tags origin
TAGS=$(git tag --list 'v*' | sort -V)
PREV=""
for TAG in $TAGS; do
  echo "— $TAG (previous: ${PREV:-none})"
  if [ -z "$PREV" ]; then
    # No previous tag — first release, let gh infer notes from HEAD history
    gh release create "$TAG" --title "$TAG" --generate-notes
  else
    gh release create "$TAG" --title "$TAG" --notes-start-tag "$PREV" --generate-notes
  fi
  PREV=$TAG
done

# Explicitly mark the newest release as "Latest"
LATEST=$(git tag --list 'v*' | sort -V | tail -1)
gh release edit "$LATEST" --latest
```

Notes about the loop:

- If a Release for a tag already exists, `gh release create` will 422. Wrap
  the call in `|| true` if you want to skip existing entries, or run
  `gh release delete "$TAG" --yes` first to rebuild them.
- `--notes-start-tag` is what tells gh to group PRs by the range between two
  tags rather than the whole history.
- The explicit `gh release edit ... --latest` at the end handles the case
  where the backfill happens in chronological order — the last create would
  already flag `--latest`, but re-setting it is idempotent.

## After release

- Update any external distribution channel notes (VS Code extension, etc.)
- Post the release URL in the project chat so the batch reviewers can
  verify the auto-generated notes look sane.

## Pitfalls

- **Never run `npm run release:*` from a dirty tree.** `npm version` will
  refuse, but if you've amended an already-published commit the chain can
  leave the git tag ahead of the npm publish. Fix order: publish, THEN fix
  git.
- **Don't force-push over a released tag.** Branch protection should block
  it; if it doesn't, the release will point at a dangling commit and the
  auto-generated notes on the next release will be wrong.
- **`gh release create` without `--latest` leaves the previous release
  marked as Latest** — use the `--latest` flag on every release script so
  the repo landing page always points at the newest version.
