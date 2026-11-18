#!/usr/bin/env bash
set -euo pipefail

demo=$(mktemp -d)
trap 'rm -rf -- "$demo"' EXIT
cd "$demo"
git init -q
git config user.name 'Threshold Demo'
git config user.email 'demo@example.invalid'
mkdir -p .cursor/rules src docs
printf 'export const ready = true;\n' > src/index.ts
printf '# Getting started\n' > docs/intro.md

write_rule() {
  printf '%s\n' '---' "$@" '---' '' \
    '# TypeScript guidance' \
    'Add explicit types at public boundaries.' \
    'Keep implementation details private.' \
    'Add a focused test when changing behavior.' \
    > .cursor/rules/typescript.mdc
}

write_rule 'alwaysApply: true'
git add .
git commit -qm 'Apply TypeScript guidance globally'
base=$(git rev-parse HEAD)

write_rule 'alwaysApply: false' 'globs: "src/**/*.ts"'
git add .
git commit -qm 'Scope unchanged guidance to TypeScript files'

cli=(npx --yes --package https://github.com/bzucker4/threshold-cli/releases/download/v0.1.0/threshold-cli-0.1.0.tgz threshold)
"${cli[@]}" diff --base "$base"
"${cli[@]}" scan --path docs/intro.md --path src/index.ts
