#!/bin/sh
# CI-gated merge for the current PR — a local stand-in for required status checks,
# which GitHub paywalls for private repos on the free plan.
#
#   Usage:  npm run merge            # merges the PR for the current branch
#           npm run merge -- 23      # merges PR #23
#
# Waits for every CI check on the PR to finish, refuses to merge unless they all
# pass, then merges and deletes the branch. NOT tamper-proof: anyone can still run
# `gh pr merge` directly. It only guards the sanctioned path.
set -e

PR="$1"  # optional PR number; defaults to the PR for the current branch

if ! command -v gh >/dev/null 2>&1; then
  echo "✋ GitHub CLI (gh) is required: https://cli.github.com" >&2
  exit 1
fi

# Resolve the target PR (for messaging and to fail early if there is none).
PR_NUM=$(gh pr view $PR --json number -q .number 2>/dev/null || true)
if [ -z "$PR_NUM" ]; then
  echo "✋ No pull request found${PR:+ for #$PR}. Open one first." >&2
  exit 1
fi

echo "⏳ Waiting for CI checks on PR #$PR_NUM to finish…"
# --watch blocks until all checks complete; --fail-fast bails on the first failure.
# Exits non-zero if any check fails, so `set -e` aborts the merge below.
if ! gh pr checks "$PR_NUM" --watch --fail-fast; then
  echo "✋ CI did not pass — refusing to merge PR #$PR_NUM." >&2
  exit 1
fi

echo "✅ CI green — merging PR #$PR_NUM."
gh pr merge "$PR_NUM" --merge --delete-branch
