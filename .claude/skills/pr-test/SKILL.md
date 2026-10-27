---
name: pr-test
description: Progress the AI API Cost Tracker roadmap through real GitHub Issues, implementation, commits, PRs, checks, and safe merges. Can also create-only or merge an existing PR.
argument-hint: "[full | create | merge <PR-number> | issue <issue-number>]"
disable-model-invocation: true
---

# PR Lifecycle Test — AI API Cost Tracker

You are executing a user-invoked GitHub workflow skill. Use the actual project's code and the GitHub CLI (`gh`), not a mock or simulated PR. The user's explicit invocation authorizes the requested GitHub operations *within the verified project repository*, subject to normal GitHub permissions and repository protection rules. Never bypass security controls.

## Invocation and modes

Parse the invocation argument: `$ARGUMENTS`

- No argument, or `full`: select the next small, meaningful, independently reviewable task from the project roadmap, implement it, create a PR, verify it, and merge if safe.
- `create`: do the same but stop after opening the PR; provide its URL.
- `issue <number>`: implement the specified open Issue, then run the full PR lifecycle.
- `merge <number>`: do not create or modify code; inspect and validate the specified existing PR, then merge it if safe.
- Unrecognized arguments: show supported usage and stop.

This skill is *manually triggered*. Do not install cron jobs, background tasks, watchers, or recurring GitHub Actions as part of its execution.

## 1. Verify environment and scope

1. Confirm that `git` and `gh` are installed, `gh auth status` succeeds, and the user has suitable repository access.
2. Confirm you are inside the intended AI API Cost Tracker Git repository. Use `gh repo view --json nameWithOwner,defaultBranchRef` to identify the actual remote repository. Its name must be `ai-api-cost-tracker`. If the repository is absent, is not this project, or the remote is ambiguous, stop and report the blocker; never create or touch an unrelated repository.
3. Discover the actual default branch (`main` if configured; otherwise respect the repository's default). Confirm the Git commit author configuration is correct; never impersonate a person or use fictitious authorship.
4. Inspect `git status --porcelain` before doing any branch, checkout, pull, or commit operation. If there are unrelated uncommitted changes, stop and explain instead of discarding, stashing, or accidentally committing them.
5. Read the project's README, CONTRIBUTING.md, CLAUDE.md, package scripts, and relevant CI workflows if they exist. Respect their instructions and protected-branch policies.

## Roadmap-driven development and continuity (full/create/issue modes)

**Standing instruction (apply on every invocation):**

> Every time /pr-test is invoked, analyze the current project and select the next meaningful development task from the project roadmap. If no roadmap exists, create one based on the AI API Cost Tracker requirements. Implement the selected task, create an Issue, make commits, open a PR, run tests, and merge when safe. Maintain development progress across sessions until the project is complete.

Interpret this instruction as follows:

1. Read the latest default-branch state, README, current GitHub Issues, merged/open PRs, and any existing roadmap (`ROADMAP.md`, `docs/ROADMAP.md`, or equivalent). Do not redo work already completed or start a task already being worked on in an open PR.
2. If no suitable roadmap exists, build one from the project's actual requirements and state. Cover meaningful milestones such as project foundation, OpenAI/Anthropic/Gemini integrations, provider usage normalization, accurate configurable pricing, persistence, ingestion security, dashboard, request history, tests, documentation, and release readiness. Respect the existing architecture, tech stack, and any previously accepted project decisions. Each item should have clear acceptance criteria and dependencies. Store the roadmap as a real version-controlled Markdown file in the repository; include it in the first relevant PR.
3. Select **one** next actionable, independently reviewable roadmap task per invocation, respecting prerequisites and current project priorities. Prefer an existing matching open Issue; otherwise create a new Issue for the selected task. Do not create duplicate Issues.
4. Follow the complete Issue -> feature branch -> meaningful commit(s) -> PR -> validation -> merge workflow below. If merging is unsafe or blocked, preserve the PR and report what prevents completion instead of bypassing checks.
5. Keep progress persistent **in the repository and GitHub**, not just in conversation context. Treat verified merged PRs and closed Issues as the authoritative record of completed work. On each new invocation, reconcile the roadmap with those records and include any needed status updates in the new task's PR. Do not mark unmerged work complete. If a PR is still pending, leave its task in progress and resume or report it on the next invocation. If the planned roadmap is finished, report completion rather than inventing activity.
6. This is still manually triggered. One call runs one bounded task; the skill does not install a daemon, scheduler, or background process. The `merge <number>` mode remains limited to merging an existing PR, not selecting new work.

## 2. Choose a legitimate task (full/create/issue modes)

- If an Issue number was supplied, validate that it exists, is open, belongs to this repository, and describes suitable work.
- Otherwise, inspect the persistent roadmap, existing open Issues, merged/open PRs, and current project state. Select the next actionable roadmap item, preferring a bounded genuinely useful implementation: a feature, focused test, bug fix, type safety improvement, provider error-handling enhancement, or verified documentation correction.
- If no Issue covers the selected real task, create a concise GitHub Issue with a specific description and acceptance criteria using `gh issue create`. Reuse an existing matching Issue rather than creating a duplicate.
- Do not invent a problem, make no-op or cosmetic-only changes, create empty commits, or open throwaway Issues merely to generate GitHub activity.
- If no legitimate bounded task exists, stop and report that there is no suitable work to test with.

## 3. Implement in an isolated branch (full/create/issue modes)

1. Fetch and synchronize with the default branch safely (e.g., `git fetch origin`, then switch to the clean default branch and fast-forward it).
2. Create a new, descriptive feature branch named for the actual task (such as `test/usage-cost-rounding` or `fix/provider-error-handling`). Avoid overwriting any existing branch.
3. Implement only the chosen task. Use the project's patterns and dependencies; do not bring in unrelated changes.
4. Add or update appropriate tests for code changes when practical.
5. Run the available project checks: lint, typecheck, unit tests, build, as applicable. Report absent commands honestly. Do not run destructive migrations, production writes, paid API calls, or external deployments.
6. Inspect `git diff --check`, `git diff`, and the staged file list. Check for credentials, accidental personal information, binary artifacts, and unrelated changes.
7. Commit the actual changes with a precise Conventional Commit message. Multiple commits are fine only if they represent distinct meaningful units of work. Never backdate, forge, or inflate Git history.
8. Push only the new feature branch (`git push -u origin <feature-branch>`). Never force-push or push directly to the default branch.

## 4. Create the PR (full/create/issue modes)

- Open a real PR with `gh pr create --base <default-branch> --head <feature-branch> --title <clear-title> --body <description>`.
- In the PR body summarize: the problem, implementation, tests performed, relevant limitations, and `Fixes #<issue-number>` when applicable.
- State that the changes were implemented with Claude Code assistance; do not fabricate independent reviewers or approvals.
- Retrieve and record the PR number and URL with `gh pr view --json number,url,state,headRefOid,baseRefName`.
- In `create` mode, stop here. Do not merge.

## 5. Validate before merge (full/merge modes)

For `merge <number>`, first confirm the selected PR is in this same project, open, not a draft, and targets the default branch. Review the PR's description, changed files, diff, and relevant Issue. Do not merge a PR that you cannot adequately validate, particularly one with changes outside the user's requested scope.

For all merges:

1. Inspect the PR diff (`gh pr diff <number>`) for correctness, unrelated files, unsafe permission changes, or secrets.
2. Check CI status with `gh pr checks <number>`; use `gh pr checks <number> --watch` where CI is configured and it is practical to wait for completion. Distinguish pending, failed, cancelled, and absent checks. Never claim CI passed if no CI is configured.
3. Confirm that any required checks and reviews imposed by the repository actually pass. If no CI exists, verify all relevant available local checks and explicitly report the CI gap.
4. Stop if there is a merge conflict, incomplete task, failing or pending required check, missing review, security concern, or ambiguous status. Do not use `--admin` or bypass repository policies.
5. Ensure that merge commits are enabled for the repository. Use an ordinary merge (not squash) to preserve individual legitimate commits.
6. Protect against merging a changed PR head after validation: retrieve the current head SHA and merge with `gh pr merge <number> --merge --delete-branch --match-head-commit <HEAD_SHA>` when supported.
7. Verify the resulting PR state with `gh pr view <number> --json state,mergedAt,url`. Verify Issue closure where the PR body links it.
8. Synchronize the local default branch only when safe to do so; avoid damaging any uncommitted work.
9. Record the verified merged PR and linked Issue in the final report. On the next invocation, reconcile the version-controlled roadmap with these GitHub records and include any necessary status updates in that next PR. Never declare an unmerged task complete.

If GitHub requires user approval or an action cannot run with the current permissions, explain the exact blocker and stop. Do not invent success.

## 6. Report actual results

Provide a concise report containing:

- Repository and selected Issue (if any)
- Short description of the real change
- Branch and commit hash(es)
- Pull Request URL and number
- Local validation and GitHub CI status (including whether CI is absent)
- Merge status and merge commit (only if verified)
- Roadmap item completed/in progress, roadmap location, and recommended next task
- Follow-up required for any blocked step

Do not state that an achievement was unlocked or that the user's GitHub contribution count increased unless independently verified. The goal of this skill is to exercise a legitimate, auditable `gh pr create` / `gh pr merge` lifecycle within this software project.
