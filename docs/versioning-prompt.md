# Reusable prompt — automatic version/release sync in CI

Paste the **Generic prompt** below into a fresh agent session on any repo and let it
adapt to the stack. Sections further down show the substitutions for Node and Python
projects. This is the tag-driven flow used by RouteMaker (see the README "Deployment &
CI" section for the live implementation).

---

## Generic prompt (stack-agnostic)

````text
Set up automatic version/release sync in CI for this repo so that three things
never drift apart and update automatically on every merge to the default branch:

  1. the version reported by the running app/artifact,
  2. the git tag, and
  3. the published artifact's tag (container image, npm package, etc.).

First, DISCOVER the stack and tell me what you found before writing anything:
  - default/release branch and whether it's protected (does it require PRs?);
  - the version "source of truth" (a plain VERSION file? package.json?
    pyproject.toml? a build-time env var?);
  - how the project is tested, built, and published (npm/PyPI/Docker/ghcr/etc.);
  - any existing release or version-bump workflow.

Then implement ONE CI workflow, triggered on push to the default branch (plus
manual dispatch), with three jobs. Use the TAG-DRIVEN design below by default.

  test — run the project's full test/lint suite on the commit.

  bump — runs only on push to the default branch; needs: test; contents: write.
    Version source of truth is GIT TAGS (vX.Y.Z). Compute:
      next = max( latest vX.Y.Z tag with patch incremented , the committed
                  version-file value used as a floor )
    If no tags exist yet, seed from the committed version file (e.g. 1.0.0).
    Create an annotated tag vNEW on the merge commit and push ONLY THE TAG
    (git push origin vNEW). Do NOT push a commit to the branch. Expose `version`
    and the commit `sha` as job outputs. Make it idempotent (skip if the tag
    already exists).

  build & publish — needs: [test, bump]. Check out the bump job's SHA (fall back
    to github.ref), then BAKE the resolved version into the artifact's version
    source (e.g. `echo $version > VERSION`, or `npm version` no-git, etc.) BEFORE
    building, so the built artifact carries the new version. Tag the artifact with
    `latest` AND the version from the bump output (type=raw,value=${{ needs.bump.outputs.version }}
    for docker/metadata-action) — never from a tag-push event. Gate it so it still
    runs when bump is skipped (PRs, non-default branches, manual dispatch):
      if: ${{ !cancelled() && needs.test.result == 'success'
              && (needs.bump.result == 'success' || needs.bump.result == 'skipped') }}
    Finally, VERIFY the version baked inside the published artifact equals the tag.

  The running app must report the same version — read it at runtime from the
  shipped version file (or bake it into the build) and surface it (e.g. an About
  dialog / --version / a /VERSION endpoint).

WHY tag-driven (and when to deviate): pushing a version-bump COMMIT to the
default branch from CI requires the CI bot to bypass branch protection, which is
often unavailable or finicky. Tags are NOT branch-protected, so pushing only the
tag works with the stock CI token + `contents: write` and no protection changes.
If (and only if) the default branch is unprotected or the CI actor genuinely has
a working bypass, you may instead commit the bumped version file back with a
"[skip ci]" message and push commit+tag together — but confirm the push actually
succeeds before relying on it.

PITFALLS TO AVOID (all learned the hard way):
  - Bump-after-build causes a perpetual off-by-one (every artifact ships the
    previous version). Bump BEFORE build, and build from the bumped version.
  - Do NOT rely on tag-push events to trigger the versioned build: a "[skip ci]"
    bump commit suppresses tag-triggered runs, and tags made via the API emit a
    `create` event, not `push`. Tag the artifact from the bump output in the SAME
    run instead. (Tag-driven avoids this: don't add a `tags:` trigger at all.)
  - Delete any separate standalone version-bump workflow — it's superseded.
  - Keep a committed version file even when tags are the source of truth: it's the
    seed for the first release, the floor you raise for a minor/major bump, and it
    lets local/offline builds succeed.

RELEASES: every merge already creates its vX.Y.Z tag, so cutting a GitHub release
is just `gh release create vX.Y.Z --verify-tag --notes "…"` on the EXISTING tag —
never let it create a new tag. Patch bumps are automatic; for a minor/major,
raise the version-file floor (e.g. 1.1.0) before merging.

VERIFY BEFORE CALLING IT DONE — merge the workflow change, then on the first live
run confirm: (a) all three jobs pass, (b) the new tag exists, and (c) pulling the
published `latest` and `:X.Y.Z` artifacts shows the version inside matching the
tag exactly. Update the README's CI/release section to describe the flow.

ADAPT per project: point the bump/bake steps at THIS project's real version
source (VERSION / package.json / pyproject.toml / …) and its real
test/build/publish commands; keep everything else identical.
````

---

## Adapt for a Node / `package.json` project

Add this note to the end of the generic prompt:

````text
This is a Node project. Adapt as follows:
  - Version source of truth: package.json "version" (the committed value is the
    seed/floor). test = `npm ci && npm test` (and `npm run lint` if present).
  - bump: next = max(latest vX.Y.Z tag patch+1, package.json version). Do NOT run
    plain `npm version` (it creates a commit + tag on the branch). Instead set the
    field without committing: `npm version $NEW --no-git-tag-version --allow-same-version`,
    then create/push ONLY the annotated git tag vNEW.
  - build & publish: check out the bump SHA, run `npm version $version
    --no-git-tag-version --allow-same-version` to bake it, build, then publish.
    For npm: set the registry, `npm publish --provenance --access public` (the
    package.json version IS the published version — verify it equals the tag).
    For a Docker image instead: tag :$version + :latest and verify the baked
    package.json version inside the image equals the tag.
  - The app can expose it via `process.env.npm_package_version` at build time or by
    importing package.json.
````

## Adapt for a Python / `pyproject.toml` project

Add this note to the end of the generic prompt:

````text
This is a Python project. Adapt as follows:
  - Version source of truth: pyproject.toml [project] version (committed value is
    the seed/floor). test = `pip install -e .[test] && pytest` (or your runner).
  - bump: next = max(latest vX.Y.Z tag patch+1, pyproject version). Rewrite the
    version in place (e.g. `sed -i` or tomlkit) WITHOUT committing to the branch,
    then create/push ONLY the annotated git tag vNEW. (Or use a build-time backend
    like hatch-vcs / setuptools-scm that derives the version straight from the git
    tag — then there is no file to bump at all; just push the tag.)
  - build & publish: check out the bump SHA, bake the version into pyproject
    (skip if using hatch-vcs/setuptools-scm), `python -m build`, then
    `twine upload` to PyPI — or build a Docker image tagged :$version + :latest.
    Verify the built dist's version (e.g. the wheel filename / `importlib.metadata`)
    equals the tag.
  - The app can expose it via `importlib.metadata.version("<pkg>")`.
````
````
