#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/twinny-publish-latest.sh [a.b.c]

Run from release/<a.b.c>. The script:

1. Pushes the current release branch.
2. Rebases master onto the current release branch so master contains the release code.
3. Commits package metadata for version <a.b.c> on master.
4. Tags master as v<a.b.c>.
5. Pushes master and the tag. GitHub Actions publishes the tag to npm with the latest dist-tag.
USAGE
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

current_branch="$(git branch --show-current)"
if [[ ! "${current_branch}" =~ ^release/([0-9]+\.[0-9]+\.[0-9]+)$ ]]; then
  echo "Current branch must be release/a.b.c, got ${current_branch}" >&2
  exit 1
fi

release_branch="${current_branch}"
branch_version="${BASH_REMATCH[1]}"
version="${1:-$branch_version}"
if [[ "${version}" != "${branch_version}" ]]; then
  echo "Version ${version} does not match current release branch ${release_branch}" >&2
  exit 1
fi

git update-index -q --refresh
if [[ -n "$(git status --porcelain)" ]]; then
  echo "Worktree must be clean before publishing ${version}." >&2
  exit 1
fi

tag="v${version}"
if git rev-parse -q --verify "refs/tags/${tag}" >/dev/null; then
  echo "Tag ${tag} already exists locally." >&2
  exit 1
fi

git fetch origin "+refs/heads/master:refs/remotes/origin/master" --tags
if git ls-remote --exit-code --tags origin "refs/tags/${tag}" >/dev/null 2>&1; then
  echo "Tag ${tag} already exists on origin." >&2
  exit 1
fi

git push origin "${release_branch}"

if ! git show-ref --verify --quiet refs/heads/master; then
  git branch master origin/master
fi

git switch master
git merge --ff-only origin/master
if [[ "$(git rev-parse master)" != "$(git rev-parse origin/master)" ]]; then
  echo "Local master differs from origin/master. Push, reset, or clean it up before publishing." >&2
  exit 1
fi

git rebase "${release_branch}"
npm version "${version}" --no-git-tag-version --allow-same-version

files_to_stage=()
for file in package.json package-lock.json npm-shrinkwrap.json pnpm-lock.yaml; do
  if [[ -e "${file}" ]]; then
    files_to_stage+=("${file}")
  fi
done

if (( ${#files_to_stage[@]} > 0 )); then
  git add "${files_to_stage[@]}"
fi

if ! git diff --cached --quiet; then
  git commit -m "chore: release ${version}"
fi

git tag -a "${tag}" -m "Release ${tag}"
git push origin master "${tag}"

echo "Pushed master and ${tag}. GitHub Actions will publish twinny@${version} with the latest dist-tag."
