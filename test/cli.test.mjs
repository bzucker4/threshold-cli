import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const cli = fileURLToPath(new URL('../threshold.mjs', import.meta.url));
const metadata = (fields, body) => '---\n' + fields + '\n---\n' + body + '\n';

test('scan categories, globs and references, then compare committed budgets', t => {
  const cwd = mkdtempSync(join(tmpdir(), 'threshold-test-'));
  t.after(() => rmSync(cwd, { force: true, recursive: true }));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  const put = (path, data) => writeFileSync(join(cwd, path), data);
  const run = (...args) => {
    const result = spawnSync(process.execPath, [cli, ...args, '--format', 'json'], { cwd, encoding: 'utf8' });
    assert.equal(result.stderr, '');
    return [result.status, JSON.parse(result.stdout)];
  };
  const commit = message => {
    git('add', '.');
    git('-c', 'user.name=Threshold Tests', '-c', 'user.email=test@example.invalid', 'commit', '-qm', message);
  };
  git('init', '-qb', 'main');
  for (const path of ['.cursor/rules', 'src', 'docs']) mkdirSync(join(cwd, path), { recursive: true });
  put('src/index.ts', '');
  put('docs/intro.md', '');
  put('.cursorrules', 'Use tests.\n');
  put('.cursor/rules/global.mdc', metadata('alwaysApply: true', 'Follow @docs/intro.md.'));
  put('.cursor/rules/scoped.mdc', metadata('globs: ["src/**", "**/*.ts"]', 'Use types. See @docs/missing.md.'));
  put('.cursor/rules/agent.mdc', metadata('description: Use when reviewing', 'Review changes.'));
  put('.cursor/rules/manual.mdc', metadata('alwaysApply: false', 'Manual workflow.'));
  commit('Initial fixture');
  const base = git('rev-parse', 'HEAD');
  const [scanCode, scan] = run('scan', '--path', 'src/index.ts', '--path', 'docs/intro.md');
  assert.equal(scanCode, 0);
  assert.equal(scan.tokenizer, 'o200k_base (js-tiktoken 1.0.21)');
  assert.deepEqual(scan.rules.map(rule => rule.category).sort(), [
    'Agent-Requested', 'Always Applied', 'Always Applied', 'Glob-Matched (Path-Scoped)', 'Manual'
  ]);
  assert.equal(scan.warnings.length, 1);
  assert.match(scan.warnings[0].message, /missing\.md/);
  assert.equal(scan.paths[0].rules.filter(rule => rule.endsWith('scoped.mdc')).length, 1);
  assert.equal(scan.paths[1].rules.some(rule => rule.endsWith('scoped.mdc')), false);
  assert.equal(run('diff', '--base', base)[1].paths.length, 0);

  put('.cursor/rules/scoped.mdc', metadata('globs: src/**', 'Write readable code. '.repeat(50)));
  commit('Increase instruction footprint');
  const budget = String(scan.paths[0].tokens);
  const [warnCode, diff] = run('diff', '--base', base, '--budget', budget);
  assert.equal(warnCode, 0);
  assert.equal(diff.regressions, 1);
  assert.deepEqual(diff.paths.map(row => row.path), ['src/index.ts']);
  assert.deepEqual(diff.paths[0].changes.map(change => change.rule), ['.cursor/rules/scoped.mdc']);
  assert.equal(run('diff', '--base', base, '--budget', budget, '--fail-on-regression')[0], 1);
  assert.equal(run('diff', '--base', base, '--budget', '1', '--fail-on-regression')[0], 0);

  put('.cursor/rules/scoped.mdc', '---\nalwaysApply: invalid\n---\n');
  commit('Invalid metadata');
  assert.equal(run('diff', '--base', base, '--fail-on-regression')[1].incomplete, true);
});
