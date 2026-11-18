# Threshold

Threshold shows which Cursor rules apply across your repo and flags pull requests that add instruction overhead where you didn’t expect it.

## Run locally

Requires Git and Node.js 20 or 22+. Run from any Git repository:

```sh
npx --yes --package https://github.com/bzucker4/threshold-cli/releases/download/v0.1.0/threshold-cli-0.1.0.tgz threshold scan --path src/index.ts
npx --yes --package https://github.com/bzucker4/threshold-cli/releases/download/v0.1.0/threshold-cli-0.1.0.tgz threshold diff --base origin/main
```

Use `--format json` for complete machine-readable results, `--budget N` to set the per-path budget (default 2,000), and `--max-paths N` to limit the Markdown table. Exit codes are 0 for a completed warning-mode scan, 1 for an opted-in new budget breach, and 2 for a command error.

### What is counted

- **Always Applied:** `alwaysApply: true` and the legacy root `.cursorrules` file, modeled as global.
- **Glob-Matched (Path-Scoped):** `.mdc` rules under `.cursor/rules` with matching repository-relative globs.
- **Agent-Requested:** a description without globs and without `alwaysApply: true`.
- **Manual:** remaining `.mdc` rules. Mention them explicitly in Cursor.

The path total counts each automatically applicable rule body once using `o200k_base` from `js-tiktoken@1.0.21`. The tokenizer counts normalized body text, including its final newline if present, with frontmatter removed for MDC. Agent-requested and manual rules have individual estimates and stay out of automatic path totals. The scanner uses minimatch for a static interpretation of path patterns. Cursor does not provide a runtime attachment trace through this tool.

The scanner flags unresolved path-like `@file` references against tracked files, using root-relative and rule-relative candidates. Reference targets, external user/team rules, other instruction formats, and full session prompt size are outside these estimates. Rules with unreadable or invalid frontmatter make the comparison incomplete and suppress budget enforcement.

`scan` reads tracked rule files from the working tree. Give it representative `--path` values or let it assess tracked files. `diff` reads two committed Git trees. It reports paths whose estimated automatic footprint or matching rule set changed, including added and removed paths. A regression crosses from at or below the budget to above it. Existing overages remain visible when changed and stay non-blocking.

## GitHub Action

Use a full Git checkout and Node.js 22. Run on every PR so the check can return success when no footprint changes. The default is a read-only job summary with an explicit no-op or a path-by-path delta. The example in `.github/workflows/threshold.yml` compares the PR base SHA to GitHub's checked-out merge commit.

Use the following step in a `pull_request` job after checkout and Node setup. For immutable pinning, replace the version tag with the full release commit SHA.

```yaml
- uses: bzucker4/threshold-cli@v0.1.0
  with:
    base: ${{ github.event.pull_request.base.sha }}
    budget: '2000'
    fail-on-regression: 'false'
```

Trusted same-repository workflows can optionally set `comment-token: ${{ github.token }}` and grant `pull-requests: write` to post the report as a PR comment. Fork PRs always use the job summary. Run the check in warning mode before enabling required budget enforcement.

## Threshold single-repo audit

**$250 introductory pilot** for one repository with up to 25 Cursor rule files. Includes a path-level baseline, one reviewable PR with agreed rule and glob changes, and the warning-mode GitHub check wired into that PR. Best suited to a team that maintains shared Cursor rules and can identify representative edit paths.

See [the benchmark notes](docs/benchmark.md) for the case-study reproduction procedure.
