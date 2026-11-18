#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, posix, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { Tiktoken } from 'js-tiktoken/lite';
import ranks from 'js-tiktoken/ranks/o200k_base';
import { Minimatch } from 'minimatch';
import { parse } from 'yaml';

const tokenizer = 'o200k_base (js-tiktoken 1.0.21)';
const encoder = new Tiktoken(ranks);
const categories = ['Always Applied', 'Glob-Matched (Path-Scoped)', 'Agent-Requested', 'Manual'];
const isRule = path => path === '.cursorrules' || /^\.cursor\/rules\/.+\.mdc$/.test(path);

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

function indexedFiles(root, revision) {
  if (!revision) {
    return new Set(git(root, 'ls-files', '-z').split('\0').filter(Boolean));
  }
  const files = git(root, 'ls-tree', '-rz', revision).split('\0').filter(Boolean);
  return new Set(files.filter(entry => /^100[67][0-7]{2} blob /.test(entry))
    .map(entry => entry.slice(entry.indexOf('\t') + 1)));
}

function readRule(root, path, revision) {
  if (revision) return git(root, 'show', revision + ':' + path);
  const absolute = resolve(root, path);
  const actual = realpathSync(absolute);
  if (actual !== absolute || !actual.startsWith(root + sep)) {
    throw new Error('Expected a regular repository file');
  }
  return readFileSync(actual, 'utf8');
}

function parseRule(path, source) {
  let body = source.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  let category = categories[0];
  let globs = [];
  if (path !== '.cursorrules') {
    const frontmatter = /^---[ \t]*\n([\s\S]*?)^---[ \t]*(?:\n|$)/m.exec(body);
    if (body.startsWith('---\n') && frontmatter?.index !== 0) throw new Error('Unclosed YAML frontmatter');
    const metadata = frontmatter?.index === 0 ? parse(frontmatter[1], { maxAliasCount: 0 }) ?? {} : {};
    if (metadata.constructor !== Object) throw new Error('Expected a YAML mapping');
    if (frontmatter?.index === 0) body = body.slice(frontmatter[0].length);
    const patterns = metadata.globs ?? [];
    if (typeof patterns !== 'string' && (!Array.isArray(patterns) || patterns.some(item => typeof item !== 'string'))) {
      throw new Error('Expected globs as a string or list of strings');
    }
    if (metadata.alwaysApply !== undefined && typeof metadata.alwaysApply !== 'boolean') {
      throw new Error('Expected alwaysApply as a boolean');
    }
    globs = (Array.isArray(patterns) ? patterns : patterns.split(/,(?![^{]*\}|[^(]*\)|[^\[]*\])/))
      .map(pattern => pattern.trim().replace(/^\.\//, '').replace(/^\//, ''))
      .filter(Boolean);
    category = metadata.alwaysApply ? categories[0] : globs.length ? categories[1]
      : typeof metadata.description === 'string' && metadata.description.trim() ? categories[2] : categories[3];
  }
  const references = [...new Set([...body.matchAll(/(?:^|[\s("'`])@((?:\.{1,2}\/|\/)?[\w.-]+(?:\/[\w.-]+)*\.[\w-]+)(?=$|[\s"'`),:;!?.])/gm)]
    .map(match => match[1]))];
  return { path, category, globs, tokens: encoder.encode(body, [], []).length, references };
}

function snapshot(root, revision) {
  const files = indexedFiles(root, revision);
  const rules = [];
  const warnings = [];
  let incomplete = false;
  for (const path of [...files].filter(isRule).sort()) {
    try {
      const rule = parseRule(path, readRule(root, path, revision));
      rules.push(rule);
      for (const ref of rule.references) {
        const candidates = [posix.normalize(ref.replace(/^\//, ''))];
        if (!ref.startsWith('/')) candidates.push(posix.normalize(posix.join(posix.dirname(path), ref)));
        if (!candidates.some(candidate => files.has(candidate))) {
          warnings.push({ path, message: 'Unresolved tracked file reference @' + ref });
        }
      }
    } catch (error) {
      // Parser errors can embed source text. Reports only expose filenames.
      incomplete = true;
      warnings.push({ path, message: 'Could not read or parse rule. Check frontmatter and file type.' });
    }
  }
  return { files, rules, warnings, incomplete };
}

function footprint(state, path, patterns) {
  const rules = state.rules.filter(rule => rule.category === categories[0] ||
    (rule.category === categories[1] && rule.globs.some(glob => {
      if (!patterns.has(glob)) patterns.set(glob, new Minimatch(glob, { dot: true, nonegate: true, nocomment: true }));
      return patterns.get(glob).match(path);
    })));
  return { tokens: rules.reduce((total, rule) => total + rule.tokens, 0), rules };
}

function differences(base, head, paths, budget) {
  const patterns = new Map();
  return paths.flatMap(path => {
    const prior = base.files.has(path) ? footprint(base, path, patterns) : { tokens: 0, rules: [] };
    const next = head.files.has(path) ? footprint(head, path, patterns) : { tokens: 0, rules: [] };
    const before = new Map(prior.rules.map(rule => [rule.path, rule]));
    const after = new Map(next.rules.map(rule => [rule.path, rule]));
    const changes = [...new Set([...before.keys(), ...after.keys()])].sort().flatMap(rule => {
      const from = before.get(rule);
      const to = after.get(rule);
      if (from?.category === to?.category && from?.tokens === to?.tokens) return [];
      return [{ rule, before: from?.tokens ?? 0, after: to?.tokens ?? 0 }];
    });
    if (!changes.length) return [];
    return [{ path, before: prior.tokens, after: next.tokens, changes,
      regression: !base.incomplete && !head.incomplete && prior.tokens <= budget && next.tokens > budget }];
  }).sort((a, b) => (b.after - b.before) - (a.after - a.before) || a.path.localeCompare(b.path));
}

function inline(value) {
  const safe = value.replace(/[\x00-\x1f\x7f]/g, '?').replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('@', '&#64;')
    .replaceAll('|', '&#124;').replaceAll('\x60', '&#96;');
  return '<code>' + safe + '</code>';
}

function markdown(report, maxPaths) {
  const lines = ['## Threshold ' + report.command, '', 'Tokenizer: ' + tokenizer, ''];
  if (report.command === 'diff') {
    lines.push(report.paths.length ? report.paths.length + ' path(s) changed · ' + report.regressions +
      ' new budget breach(es) (budget: ' + report.budget + ')' :
      report.incomplete ? 'Automatic rule comparison is incomplete.' : 'No path-level automatic rule footprint changes.', '');
    if (report.incomplete) lines.push('Some rules could not be read. Budget enforcement was skipped.', '');
    if (report.paths.length) {
      lines.push('| Path | Before → After | Rule changes |', '| --- | ---: | --- |');
      for (const row of report.paths.slice(0, maxPaths)) {
        const changes = row.changes.map(change => inline(change.rule) + ' (' + change.before + ' → ' + change.after + ')');
        lines.push('| ' + inline(row.path) + ' | ' + row.before + ' → ' + row.after +
          (row.regression ? ' ⚠️' : '') + ' | ' + changes.join(', ') + ' |');
      }
    }
  } else {
    for (const category of categories) {
      const rules = report.rules.filter(rule => rule.category === category);
      lines.push('### ' + category, '');
      lines.push(...(rules.length ? rules.map(rule => '- ' + inline(rule.path) + ' · ' + rule.tokens +
        ' tokens' + (rule.category === categories[1] ? ' · ' + rule.globs.map(inline).join(', ') : '')) : ['None.']), '');
    }
    lines.push('| Path | Estimated tokens | Automatically matched rules |', '| --- | ---: | --- |');
    for (const row of report.paths.slice(0, maxPaths)) {
      lines.push('| ' + inline(row.path) + ' | ' + row.tokens + (row.overBudget ? ' ⚠️' : '') +
        ' | ' + row.rules.map(inline).join(', ') + ' |');
    }
  }
  if (report.paths.length > maxPaths) lines.push('', 'Showing ' + maxPaths + ' of ' + report.paths.length + ' paths. Use --format json for all paths.');
  if (report.warnings.length) {
    lines.push('', '### Warnings', '');
    lines.push(...report.warnings.slice(0, 40).map(warning => '- ' + inline(warning.path) + ' · ' + warning.message.replace(/@(\S+)/g, (_, ref) => inline('@' + ref))));
    if (report.warnings.length > 40) lines.push('- Additional warnings are available in JSON output.');
  }
  lines.push('', 'Estimates cover version-controlled Cursor rule bodies. User/team settings and actual session context are outside this report.');
  return lines.join('\n') + '\n';
}

function countOption(value, name) {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error('Expected a nonnegative integer for --' + name);
  return Number(value);
}

function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === '--help' || args.includes('--help')) {
    console.log('threshold scan [--path PATH ...] [--budget N] [--format markdown|json]\n' +
      'threshold diff [--base REF] [--head REF] [--budget N] [--fail-on-regression]\n' +
      'Both commands accept --max-paths N and --format markdown|json.');
    return;
  }
  if (!['scan', 'diff'].includes(command)) throw new Error('Expected scan or diff');
  const options = {
    budget: { type: 'string', default: '2000' },
    format: { type: 'string', default: 'markdown' },
    'max-paths': { type: 'string', default: '30' }
  };
  Object.assign(options, command === 'scan' ? { path: { type: 'string', multiple: true } } : {
    base: { type: 'string', default: 'origin/main' },
    head: { type: 'string', default: 'HEAD' },
    'fail-on-regression': { type: 'boolean' }
  });
  const { values } = parseArgs({ args, options });
  const budget = countOption(values.budget, 'budget');
  const maxPaths = countOption(values['max-paths'], 'max-paths');
  if (!['markdown', 'json'].includes(values.format)) throw new Error('Expected markdown or json for --format');
  const root = realpathSync(git(process.cwd(), 'rev-parse', '--show-toplevel').trimEnd());
  const revision = ref => git(root, 'rev-parse', '--verify', '--end-of-options', ref + '^{commit}').trim();
  const head = snapshot(root, command === 'diff' ? revision(values.head) : null);
  const report = { command, tokenizer, budget, paths: [], warnings: head.warnings };
  if (command === 'diff') {
    const base = snapshot(root, revision(values.base));
    const paths = [...new Set([...base.files, ...head.files])].filter(path => !isRule(path)).sort();
    report.incomplete = base.incomplete || head.incomplete;
    report.paths = differences(base, head, paths, budget);
    report.regressions = report.paths.filter(row => row.regression).length;
    report.warnings = [...head.warnings, ...base.warnings.filter(previous =>
      !head.warnings.some(current => current.path === previous.path && current.message === previous.message))];
    if (values['fail-on-regression'] && report.regressions) process.exitCode = 1;
  } else {
    const paths = values.path?.map(path => {
      const target = relative(root, resolve(root, path));
      if (!target || isAbsolute(target) || target === '..' || target.startsWith('..' + sep)) {
        throw new Error('Expected a repository-relative file path');
      }
      return target.split(sep).join('/');
    }) ?? [...head.files].filter(path => !isRule(path)).sort();
    const patterns = new Map();
    report.rules = head.rules;
    report.paths = [...new Set(paths)].map(path => {
      const result = footprint(head, path, patterns);
      return { path, tokens: result.tokens, overBudget: result.tokens > budget, rules: result.rules.map(rule => rule.path) };
    }).sort((a, b) => b.tokens - a.tokens || a.path.localeCompare(b.path));
  }
  const rendered = markdown(report, maxPaths);
  if (process.env.GITHUB_STEP_SUMMARY && command === 'diff') appendFileSync(process.env.GITHUB_STEP_SUMMARY, rendered);
  process.stdout.write(values.format === 'json' ? JSON.stringify(report, null, 2) + '\n' : rendered);
}

try {
  main();
} catch (error) {
  console.error('Threshold: ' + error.message);
  process.exitCode = 2;
}
