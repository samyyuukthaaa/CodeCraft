import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { buildIndex, isTestPath, loadIndex, saveIndex } from '../src/index/build';
import { composePrompt, estimateTokens, parseRefs, selectContext } from '../src/index/context';
import { extractPythonImports, extractPythonSymbols, pythonSourceRoots, resolvePythonImport } from '../src/index/python';
import { listRelated, searchSymbols } from '../src/index/query';
import { IndexService } from '../src/index/service';
import { extractTsImports, extractTsSymbols, resolveTsImport } from '../src/index/tsjs';
import { WriteGate } from '../src/mcp/gate';
import { createHandlers } from '../src/mcp/tools';
import { DiskApplier, ScriptedReviewer, acceptAll, tempWorkspace } from './helpers';

const sym = (s: { name: string; kind: string; parent?: string }) => `${s.kind}:${s.parent ? `${s.parent}.` : ''}${s.name}`;

// ---------- Python symbols ----------
test('python symbols: classes, methods, nested and async functions, decorators; docstrings ignored', () => {
  const src = [
    'import os',
    '',
    '@decorator',
    'class Base(object):',
    '    """Docstring mentioning def fake_in_docstring(): and class Fake:"""',
    '    def method(self):',
    '        def inner():',
    '            pass',
    '        return inner',
    '',
    '    async def amethod(self):',
    "        '''",
    '        def also_fake():',
    "        '''",
    '',
    'async def top_async(x):',
    '    pass',
    '',
    'def top(a,',
    '        b):',
    '    class Local:',
    '        pass',
    '# def commented_out():',
    '\tdef tabbed(self): pass',
  ].join('\n');
  assert.deepEqual(extractPythonSymbols(src).map(sym), [
    'class:Base',
    'method:Base.method',
    'function:method.inner',
    'method:Base.amethod',
    'function:top_async',
    'function:top',
    'class:top.Local',
    'function:top.tabbed', // a tab-indented def after top's body is nested in top
  ]);
  const base = extractPythonSymbols(src).find((s) => s.name === 'Base');
  assert.equal(base?.line, 4);
});

// ---------- Python imports ----------
test('python imports: plain, dotted, aliased, from-relative, multi-line parentheses, continuation', () => {
  const src = [
    'import os, sys as system',
    'import pkg.sub.mod as m',
    'from . import views, models',
    'from ..core import (',
    '    Engine,  # comment',
    '    Session as S,',
    ')',
    'from pkg.helpers import \\',
    '    tool',
    'from x import *',
    'x = "import notreal"',
  ].join('\n');
  assert.deepEqual(extractPythonImports(src), [
    { module: 'os', level: 0, names: [] },
    { module: 'sys', level: 0, names: [] },
    { module: 'pkg.sub.mod', level: 0, names: [] },
    { module: '', level: 1, names: ['views', 'models'] },
    { module: 'core', level: 2, names: ['Engine', 'Session'] },
    { module: 'pkg.helpers', level: 0, names: ['tool'] },
    { module: 'x', level: 0, names: ['*'] },
  ]);
});

test('python import edges: src root, relative levels, submodules, package fallback, external', () => {
  const files = new Set(['src/app/__init__.py', 'src/app/views.py', 'src/app/models.py', 'src/app/core/__init__.py', 'src/app/core/engine.py', 'src/app/api/routes.py', 'tests/test_views.py']);
  const roots = pythonSourceRoots(files);
  assert.deepEqual(roots, ['', 'src']);
  const r = (imp: Parameters<typeof resolvePythonImport>[0], from: string) => resolvePythonImport(imp, from, files, roots).sort();
  assert.deepEqual(r({ module: 'app.views', level: 0, names: [] }, 'tests/test_views.py'), ['src/app/views.py']);
  assert.deepEqual(r({ module: 'app', level: 0, names: ['views'] }, 'tests/test_views.py'), ['src/app/__init__.py', 'src/app/views.py']);
  assert.deepEqual(r({ module: '', level: 1, names: ['views', 'models'] }, 'src/app/__init__.py'), ['src/app/models.py', 'src/app/views.py']);
  assert.deepEqual(r({ module: 'core.engine', level: 2, names: ['Engine'] }, 'src/app/api/routes.py'), ['src/app/core/engine.py']);
  assert.deepEqual(r({ module: 'app.views.missing', level: 0, names: [] }, 'tests/test_views.py'), ['src/app/views.py']);
  assert.deepEqual(r({ module: 'requests', level: 0, names: ['get'] }, 'src/app/views.py'), []);
});

// ---------- TypeScript / JavaScript ----------
test('ts symbols: classes, methods, functions, arrow consts; comments and strings ignored', () => {
  const src = [
    '// function commentedOut() {}',
    '/* class AlsoCommented {} */',
    'const s = "function inString() {}";',
    'export default class Widget extends Base {',
    '  private count = 0;',
    '  constructor(a: number) { super(); }',
    '  async render(x: string): Promise<void> {',
    '    if (x) { return; }',
    '  }',
    '  static create() {',
    '    return new Widget(1);',
    '  }',
    '}',
    'export async function load(id: string) {}',
    'function* gen() {}',
    'export const handler = async (req: Req) => {};',
    'const double = x => x * 2;',
    'const notAFunction = 42;',
    'interface Shape { area(): number }',
  ].join('\n');
  assert.deepEqual(extractTsSymbols(src).map(sym), [
    'class:Widget',
    'method:Widget.render',
    'method:Widget.create',
    'function:load',
    'function:gen',
    'function:handler',
    'function:double',
  ]);
});

test('ts imports: import/export-from/type/side-effect/require/dynamic; relative resolution incl. .js->.ts and index', () => {
  const src = [
    "import { a } from './a';",
    "import type { T } from '../types';",
    "import './side-effect';",
    "export * from './lib/index.js';",
    "const fs = require('node:fs');",
    "const lazy = await import('./lazy');",
    "import React from 'react';",
    "import { x } from '@scope/pkg/deep';",
    "// import { ghost } from './ghost';",
  ].join('\n');
  assert.deepEqual(extractTsImports(src).sort(), ['../types', './a', './lazy', './lib/index.js', './side-effect', '@scope/pkg/deep', 'node:fs', 'react'].sort());
  const files = new Set(['src/a.ts', 'src/types.ts', 'src/lib/index.ts', 'src/util/index.tsx', 'src/old.js', 'src/feature/main.ts']);
  assert.equal(resolveTsImport('./a', 'src/main.ts', files), 'src/a.ts');
  assert.equal(resolveTsImport('../types', 'src/feature/main.ts', files), 'src/types.ts');
  assert.equal(resolveTsImport('./lib/index.js', 'src/main.ts', files), 'src/lib/index.ts');
  assert.equal(resolveTsImport('./util', 'src/main.ts', files), 'src/util/index.tsx');
  assert.equal(resolveTsImport('./old.js', 'src/main.ts', files), 'src/old.js');
  assert.equal(resolveTsImport('react', 'src/main.ts', files), undefined);
  assert.equal(resolveTsImport('./missing', 'src/main.ts', files), undefined);
});

test('isTestPath', () => {
  for (const p of ['tests/test_app.py', 'pkg/test_x.py', 'x_test.py', 'src/a.test.ts', 'src/a.spec.js', 'src/__tests__/a.ts', 'conftest.py']) assert.equal(isTestPath(p), true, p);
  for (const p of ['src/app.py', 'src/testing.py', 'src/contest.ts', 'latest.py']) assert.equal(isTestPath(p), false, p);
});

// ---------- Build, edges, related, persistence ----------
const REPO: Record<string, string> = {
  'src/shop/__init__.py': 'from .cart import Cart\nfrom .pricing import price\n',
  'src/shop/cart.py': 'from .pricing import price\n\nclass Cart:\n    def total(self):\n        return price(1)\n',
  'src/shop/pricing.py': 'import math\n\ndef price(x):\n    return math.ceil(x)\n',
  'tests/test_cart.py': 'from shop import Cart\n\ndef test_total():\n    assert Cart().total() == 1\n',
  'tests/fixtures/app.py': 'from shop import Cart\n',
  'web/src/api.ts': "import { fmt } from './fmt';\nexport function getCart() { return fmt(1); }\n",
  'web/src/fmt.ts': 'export const fmt = (n: number) => String(n);\n',
  'web/src/fmt.test.ts': "import { fmt } from './fmt';\ntest('fmt', () => {});\n",
  'README.md': '# shop\n',
  'node_modules/dep/index.js': 'function shouldNotBeIndexed() {}\n',
  '.venv/lib/site.py': 'def nope(): pass\n',
  'dist/bundle.js': 'function nope() {}\n',
  'src/shop/__pycache__/cart.cpython-312.pyc': 'x',
  '.env': 'SECRET=1\n',
};

test('build: skips vendored/build/secret files; symbols, edges (incl. re-export) and related files', async () => {
  const ws = await tempWorkspace(REPO);
  try {
    const { index } = await buildIndex(ws.root);
    const paths = Object.keys(index.files).sort();
    assert.deepEqual(paths, ['README.md', 'src/shop/__init__.py', 'src/shop/cart.py', 'src/shop/pricing.py', 'tests/fixtures/app.py', 'tests/test_cart.py', 'web/src/api.ts', 'web/src/fmt.test.ts', 'web/src/fmt.ts']);
    assert.deepEqual(index.files['src/shop/cart.py']?.imports, ['src/shop/pricing.py']);
    assert.deepEqual(index.files['src/shop/pricing.py']?.externalImports, ['math']);
    // `from shop import Cart` follows the package re-export to cart.py
    assert.deepEqual(index.files['tests/test_cart.py']?.imports, ['src/shop/__init__.py', 'src/shop/cart.py']);
    assert.deepEqual(index.files['web/src/api.ts']?.imports, ['web/src/fmt.ts']);
    assert.equal(index.stats.totalFiles, 9);

    const cart = listRelated(index, 'src/shop/cart.py');
    assert.deepEqual(cart?.imports, ['src/shop/pricing.py']);
    assert.deepEqual(cart?.importedBy, ['src/shop/__init__.py', 'tests/fixtures/app.py', 'tests/test_cart.py']);
    assert.deepEqual(cart?.tests, ['tests/test_cart.py']); // the fixture under tests/ is not a test
    assert.deepEqual(listRelated(index, 'web/src/fmt.ts')?.tests, ['web/src/fmt.test.ts']);
    assert.equal(listRelated(index, 'nope.py'), undefined);

    assert.deepEqual(searchSymbols(index, 'cart').map((h) => `${h.path}:${h.name}`)[0], 'src/shop/cart.py:Cart');
    assert.deepEqual(searchSymbols(index, 'Cart.total').map((h) => h.name), ['total']);
    assert.deepEqual(searchSymbols(index, 'fmt', { kind: 'function' }).map((h) => h.path), ['web/src/fmt.ts']);
  } finally {
    await ws.cleanup();
  }
});

test('build: incremental reuse, re-parse of changed files, removed files drop their edges, persistence', async () => {
  const ws = await tempWorkspace(REPO);
  try {
    const first = await buildIndex(ws.root);
    const again = await buildIndex(ws.root, first);
    assert.equal(again.index.stats.reusedFiles, 9);
    assert.equal(again.index.stats.parsedFiles, 0);
    assert.deepEqual(again.index.files['tests/test_cart.py']?.imports, first.index.files['tests/test_cart.py']?.imports);

    await fs.writeFile(path.join(ws.root, 'src/shop/pricing.py'), 'def price(x):\n    return x\n\ndef discount(x):\n    return x\n');
    await fs.rm(path.join(ws.root, 'src/shop/cart.py'));
    const changed = await buildIndex(ws.root, again);
    assert.equal(changed.index.stats.parsedFiles, 1);
    assert.deepEqual(changed.index.files['src/shop/pricing.py']?.symbols.map((s) => s.name), ['price', 'discount']);
    assert.equal(changed.index.files['src/shop/cart.py'], undefined);
    assert.ok(!changed.index.files['tests/test_cart.py']?.imports.includes('src/shop/cart.py'));

    const store = path.join(ws.root, '..', `${path.basename(ws.root)}-index.json`);
    await saveIndex(store, changed);
    const loaded = await loadIndex(store);
    assert.deepEqual(loaded?.index.files, changed.index.files);
    await fs.rm(store, { force: true });
    assert.equal(await loadIndex(store), undefined);

    const svc = new IndexService(ws.root, undefined);
    const [a, b] = await Promise.all([svc.get(), svc.get()]); // concurrent callers share one build
    assert.equal(a, b);
  } finally {
    await ws.cleanup();
  }
});

// ---------- Context budget ----------
test('refs: @file and @symbol parsing', () => {
  assert.deepEqual(parseRefs('fix @file:src\\a.py and @symbol:Cart.total, then @file:./b.ts.'), [
    { kind: 'file', value: 'src/a.py' },
    { kind: 'symbol', value: 'Cart.total' },
    { kind: 'file', value: 'b.ts' },
  ]);
  assert.deepEqual(parseRefs('email me@example.com'), []);
});

test('budget: explicit refs first, reasons recorded, never over budget, over-budget files listed as left out', async () => {
  const big = 'x = 1\n'.repeat(4000); // ~24k chars
  const ws = await tempWorkspace({ ...REPO, 'src/shop/big.py': `def huge():\n${big}` });
  try {
    const { index } = await buildIndex(ws.root);
    const read = (p: string) => ws.fs.read(p);
    const { report, contextText } = await selectContext({ index, text: 'Fix the total in @file:src/shop/cart.py using @symbol:price and look at @file:src/shop/big.py and @file:nope.py', budgetTokens: 1000, read });
    assert.ok(report.usedTokens <= 1000);
    assert.deepEqual(report.unresolved, ['@file:nope.py']);
    const byPath = Object.fromEntries(report.items.map((i) => [i.path, i]));
    assert.equal(byPath['src/shop/cart.py']?.included, true);
    assert.equal(byPath['src/shop/cart.py']?.reason, 'referenced with @file');
    assert.match(byPath['src/shop/pricing.py']?.reason ?? '', /defines @symbol:price \(function, line 3\)/);
    // too big to include whole: an outline (its symbols with line numbers) is included instead
    assert.equal(byPath['src/shop/big.py']?.included, true);
    assert.match(byPath['src/shop/big.py']?.reason ?? '', /outline only \(whole file ~\d+ tokens is over budget\)/);
    assert.match(contextText, /### src\/shop\/big\.py outline[^\n]*\n\d+ lines; read sections[^\n]*\nL1 function huge/);
    assert.ok(!contextText.includes('x = 1\nx = 1'), 'the big file body itself is not included');
    assert.ok(byPath['tests/test_cart.py'], 'related test is a candidate');
    // priority order: the two @file references come before the @symbol hit and related files
    assert.deepEqual(report.items.slice(0, 2).map((i) => i.path).sort(), ['src/shop/big.py', 'src/shop/cart.py']);
    assert.equal(report.items[2]?.path, 'src/shop/pricing.py');
    assert.equal(report.totalFiles, index.stats.totalFiles);
    for (const i of report.items.filter((x) => x.included)) assert.ok(contextText.includes(`### ${i.path}`));
    assert.equal(report.items.filter((i) => i.included).reduce((s, i) => s + i.tokens, 0), report.usedTokens);
  } finally {
    await ws.cleanup();
  }
});

test('budget: an over-budget file with a matching @symbol contributes an excerpt of that definition', async () => {
  const filler = Array.from({ length: 3000 }, (_, i) => `    v${i} = ${i}`).join('\n');
  const ws = await tempWorkspace({ 'big.py': `def before():\n${filler}\n\ndef target():\n    return 42\n\ndef after():\n    return 0\n` });
  try {
    const { index } = await buildIndex(ws.root);
    const { report, contextText } = await selectContext({ index, text: 'explain @symbol:target', budgetTokens: 500, read: (p) => ws.fs.read(p) });
    const item = report.items.find((i) => i.path === 'big.py');
    assert.equal(item?.included, true);
    assert.match(item?.reason ?? '', /excerpt lines 3003-3005/);
    assert.ok(contextText.includes('return 42'));
    assert.ok(!contextText.includes('v1500 = 1500'));
    assert.ok(report.usedTokens <= 500);
  } finally {
    await ws.cleanup();
  }
});

test('budget: zero budget includes nothing; secrets in included files are redacted; composePrompt', async () => {
  const fake = 'AIza' + 'Q'.repeat(35);
  const ws = await tempWorkspace({ 'conf.py': `KEY = "${fake}"\ndef load():\n    pass\n` });
  try {
    const { index } = await buildIndex(ws.root);
    const none = await selectContext({ index, text: '@file:conf.py', budgetTokens: 0, read: (p) => ws.fs.read(p) });
    assert.equal(none.report.usedTokens, 0);
    assert.equal(none.contextText, '');
    assert.equal(composePrompt(none.contextText, 'hi'), 'hi');
    const some = await selectContext({ index, text: '@file:conf.py', budgetTokens: 1000, read: (p) => ws.fs.read(p) });
    assert.ok(!some.contextText.includes(fake));
    assert.match(composePrompt(some.contextText, 'hi'), /Request:\nhi$/);
    assert.equal(estimateTokens('abcd'), 1);
    assert.equal(estimateTokens('abcde'), 2);
  } finally {
    await ws.cleanup();
  }
});

test('budget: the editor selection comes first, as an excerpt of exactly the selected lines', async () => {
  const ws = await tempWorkspace(REPO);
  try {
    const { index } = await buildIndex(ws.root);
    const { report, contextText } = await selectContext({
      index,
      text: 'make it faster',
      budgetTokens: 2000,
      read: (p) => ws.fs.read(p),
      selection: { path: 'src/shop/cart.py', startLine: 3, endLine: 5 },
    });
    assert.equal(report.items[0]?.path, 'src/shop/cart.py');
    assert.equal(report.items[0]?.reason, 'selected in the editor (lines 3-5)');
    assert.ok(contextText.includes('### src/shop/cart.py lines 3-5'));
    assert.ok(contextText.includes('class Cart:'));
    assert.ok(!contextText.includes('from .pricing import price\n\nclass'), 'only the selected lines, not the whole file');
    assert.ok(report.items.some((i) => i.path === 'tests/test_cart.py' && /test for src\/shop\/cart\.py/.test(i.reason)));
    const outside = await selectContext({ index, text: 'x', budgetTokens: 2000, read: (p) => ws.fs.read(p), selection: { path: 'not/indexed.py', startLine: 1, endLine: 2 } });
    assert.equal(outside.report.items.length, 0);
  } finally {
    await ws.cleanup();
  }
});

test('budget: per-file cap spreads the budget; big docs get a heading outline; "CLI" (3 letters) is a keyword', async () => {
  const bigCli = 'import click\n\n' + Array.from({ length: 300 }, (_, i) => `def command_${i}():\n    return ${i}\n`).join('\n');
  const doc = 'CLI\n===\n\n' + 'text '.repeat(3000) + '\n\nBuilt-in commands\n-----------------\n\nmore text\n';
  const ws = await tempWorkspace({ 'src/app/cli.py': bigCli, 'docs/cli.rst': doc, 'tests/test_cli.py': 'from app.cli import command_1\n\ndef test_it():\n    assert command_1() == 1\n', 'src/app/__init__.py': '' });
  try {
    const { index } = await buildIndex(ws.root);
    const { report, contextText } = await selectContext({ index, text: 'Add a new CLI command', budgetTokens: 3000, read: (p) => ws.fs.read(p) });
    const byPath = Object.fromEntries(report.items.map((i) => [i.path, i]));
    assert.match(byPath['src/app/cli.py']?.reason ?? '', /file name matches "cli"; outline only/);
    assert.match(byPath['docs/cli.rst']?.reason ?? '', /documentation (page named "cli"|for src\/app\/cli\.py); outline only/);
    assert.match(contextText, /L1 CLI\nL\d+ Built-in commands/);
    assert.equal(byPath['tests/test_cli.py']?.included, true);
    assert.ok(report.usedTokens <= 3000);
    for (const i of report.items) if (i.included) assert.ok(i.tokens <= Math.floor(3000 * 0.35) || i.reason.includes('outline'), `${i.path} took ${i.tokens}`);
  } finally {
    await ws.cleanup();
  }
});

// ---------- MCP tools ----------
test('mcp tools: search_symbols and list_related answer from the index; read_file reports reads', async () => {
  const ws = await tempWorkspace(REPO);
  try {
    const gate = new WriteGate(ws.fs, new DiskApplier(ws.root), new ScriptedReviewer(acceptAll));
    const reads: string[] = [];
    const h = createHandlers({ fs: ws.fs, gate, tests: { run: async () => ({ ran: false, output: '' }) }, index: new IndexService(ws.root, undefined), onRead: (p) => reads.push(p) });
    const s = JSON.parse((await h.search_symbols({ query: 'Cart' })).text);
    assert.equal(s.symbols[0].path, 'src/shop/cart.py');
    const r = JSON.parse((await h.list_related({ path: 'src/shop/cart.py' })).text);
    assert.deepEqual(r.tests, ['tests/test_cart.py']);
    assert.equal((await h.list_related({ path: '../x.py' })).isError, true);
    assert.equal((await h.list_related({ path: 'missing.py' })).isError, true);
    await h.read_file({ path: 'src/shop/cart.py' });
    assert.deepEqual(reads, ['src/shop/cart.py']);
    const noIndex = createHandlers({ fs: ws.fs, gate, tests: { run: async () => ({ ran: false, output: '' }) } });
    assert.equal((await noIndex.search_symbols({ query: 'x' })).isError, true);
  } finally {
    await ws.cleanup();
  }
});

// ---------- Flask fixture (real repository) ----------
const FLASK = path.resolve('fixtures/flask');
test('flask fixture: real symbols, edges, related tests and context', { skip: !existsSync(path.join(FLASK, 'src/flask/app.py')) && 'fixtures/flask not cloned' }, async () => {
  const { index } = await buildIndex(FLASK);
  assert.ok(index.stats.totalFiles > 100);
  assert.equal(searchSymbols(index, 'Flask', { kind: 'class' })[0]?.path, 'src/flask/app.py');
  assert.ok(index.files['src/flask/app.py']?.imports.includes('src/flask/sansio/app.py'));
  assert.ok(index.files['src/flask/app.py']?.externalImports.includes('werkzeug'));
  assert.ok(listRelated(index, 'src/flask/sessions.py')?.tests.includes('tests/test_session_interface.py'));
  assert.ok(listRelated(index, 'src/flask/blueprints.py')?.tests.includes('tests/test_blueprints.py'));
  for (const p of Object.keys(index.files)) assert.ok(!p.startsWith('.git/') && !p.includes('/__pycache__/'), p);
  const { report } = await selectContext({ index, text: 'How does @symbol:Flask handle errors?', budgetTokens: 6000, read: async (p) => fs.readFile(path.join(FLASK, p), 'utf8') });
  const flask = report.items.find((i) => i.path === 'src/flask/app.py');
  assert.equal(flask?.included, true);
  assert.match(flask?.reason ?? '', /excerpt lines/);
  assert.ok(report.usedTokens <= 6000);
});
