#!/usr/bin/env bash
# Rebase our fork's patch stack onto upstream/main and, on a clean rebase,
# publish the next <upstream-base>-schuettc.N of @schuettc/pi-claude-bridge to
# npm. On conflicts: abort, open a tracking issue, and FAIL the job (exit 1) so
# the red run + issue email are the signal. Invoked by .github/workflows/upstream-sync.yml.
#
# Reharden (2026-09-22, see tools-ops audit 2026-09-22-fork-publish-sync-audit):
#   - The committed patch on schuettc-publish carries ONLY genuine source
#     patches + this CI. ALL packaging metadata (scoped name, -schuettc.N
#     version, repo/homepage) is applied at publish time, never committed, so
#     upstream's every-release version/name churn can no longer conflict.
#   - A conflict opens a tracking issue AND fails the job (exit 1); the previous
#     version silently exit 0'd and drifted behind while reporting success.
set -euo pipefail

PKG="@schuettc/pi-claude-bridge"
UPSTREAM_URL="https://github.com/elidickinson/pi-claude-bridge.git"
BRANCH="schuettc-publish"
FORCE="${1:-false}"

git config user.name "schuettc-fork-bot"
git config user.email "actions@github.com"

git remote add upstream "$UPSTREAM_URL" 2>/dev/null || git remote set-url upstream "$UPSTREAM_URL"
git fetch upstream main --quiet

base="$(git merge-base HEAD upstream/main)"
ahead="$(git rev-list --count "${base}..upstream/main")"
echo "upstream/main is ${ahead} commit(s) ahead of our base ${base}"

if [ "$ahead" -eq 0 ] && [ "$FORCE" != "true" ]; then
  echo "In sync; nothing to publish."
  exit 0
fi

if [ "$ahead" -gt 0 ]; then
  echo "Rebasing our patch stack onto upstream/main..."
  if ! git rebase upstream/main; then
    upstream_log="$(git --no-pager log --oneline "${base}..upstream/main")"
    git rebase --abort || true
    title="upstream sync: manual rebase needed (${ahead} new upstream commit(s))"
    body="$(printf 'Automated rebase of %s onto elidickinson/main hit conflicts on genuine source patches and was aborted — nothing was published.\n\nNew upstream commits:\n\n```\n%s\n```\n\nResolve locally: rebase %s onto upstream/main, force-push, then re-run the upstream-sync workflow (or let the next daily run pick it up).' "$BRANCH" "$upstream_log" "$BRANCH")"
    if [ "$(gh issue list --state open --search "$title in:title" --json number --jq 'length')" = "0" ]; then
      gh issue create --title "$title" --body "$body" \
        || echo "::warning::Could not open tracking issue; conflicts still need manual resolution."
    else
      echo "A conflict issue is already open; skipping duplicate."
    fi
    echo "::error::upstream-sync rebase conflicted; published nothing. See the tracking issue."
    exit 1
  fi
fi

upstream_ver="$(git show upstream/main:package.json | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).version')"
echo "upstream base version: ${upstream_ver}"

published="$(npm view "$PKG" versions --json 2>/dev/null || echo '[]')"
next_n="$(BASE="$upstream_ver" PUBLISHED="$published" node -e '
  const base = process.env.BASE;
  let v = [];
  try { v = JSON.parse(process.env.PUBLISHED); } catch (_) {}
  if (!Array.isArray(v)) v = [v];
  const re = new RegExp("^" + base.replace(/[.]/g, "\\.") + "-schuettc\\.(\\d+)$");
  let max = 0;
  for (const s of v) { const m = re.exec(s); if (m) max = Math.max(max, parseInt(m[1], 10)); }
  process.stdout.write(String(max + 1));
')"
new_ver="${upstream_ver}-schuettc.${next_n}"
echo "publishing new version: ${new_ver}"

# Stamp packaging metadata at publish time only. pi-claude-bridge has no build
# step (pi loads .ts at runtime) and no monorepo, so we publish from the repo
# root: edit package.json in place, publish, then revert so the metadata is
# never committed and the next upstream release replays our source cleanly.
PKG="$PKG" VER="$new_ver" node -e '
  const fs=require("fs"), f="package.json", p=JSON.parse(fs.readFileSync(f));
  p.name = process.env.PKG;
  p.version = process.env.VER;
  p.repository = { type: "git", url: "git+https://github.com/schuettc/pi-claude-bridge.git" };
  p.homepage = "https://github.com/schuettc/pi-claude-bridge#readme";
  fs.writeFileSync(f, JSON.stringify(p, null, 2) + "\n");
'
npm publish --provenance --access public --tag latest
git checkout -- package.json

# Keep schuettc-publish current (rebased onto upstream, our source patches on
# top) so tomorrow's run sees ahead=0. The branch stays upstream-named; the
# scoped name + -schuettc.N live only on npm + the tag.
git push --force-with-lease origin "HEAD:${BRANCH}"
git tag "v${new_ver}"
git push origin "v${new_ver}"

echo "Published ${PKG}@${new_ver}; pushed ${BRANCH} + tag v${new_ver}."
