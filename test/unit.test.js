import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeJoin, cmpVersion, satisfies } from '../src/util.js';
import { parseLibraryFolders, parseBuildId } from '../src/locate.js';
import { plan, dependents, outdated } from '../src/resolve.js';

test('safeJoin rejects paths that escape the game folder', () => {
  assert.equal(safeJoin('/g', 'BepInEx/plugins/x.dll'), path.join('/g', 'BepInEx', 'plugins', 'x.dll'));
  for (const bad of ['../x', 'a/../../x', '/etc/passwd', 'C:/x', 'a\\b', 'a//b', './a', ''])
    assert.throws(() => safeJoin('/g', bad), /unsafe/, bad);
});

test('versions compare numerically', () => {
  assert.equal(cmpVersion('2.19.0', '2.9.0'), 1);
  assert.equal(cmpVersion('1.5', '1.5.0'), 0);
  assert.ok(satisfies('2.19.0', '>=2.18.1'));
  assert.ok(!satisfies('2.18.0', '>=2.18.1'));
});

test('Steam vdf/acf parsing', () => {
  const vdf = '"libraryfolders"\n{\n "0"\n {\n  "path"  "C:\\\\Program Files (x86)\\\\Steam"\n }\n "1"\n {\n  "path"  "/Volumes/Games/Steam"\n }\n}';
  assert.deepEqual(parseLibraryFolders(vdf), ['C:\\Program Files (x86)\\Steam', '/Volumes/Games/Steam']);
  assert.equal(parseBuildId('"AppState"\n{\n "appid" "2743850"\n "buildid"  "25617730"\n}'), '25617730');
});

const cat = {
  entries: [
    { id: 'level-hook', name: 'Hook', version: '2.19.0', builds: { any: { files: {} } } },
    { id: 'pack', name: 'Pack', version: '1.2', requires: { 'level-hook': '>=2.18.1' }, builds: { mac: { files: {} }, windows: { files: {} } } },
    { id: 'winonly', name: 'W', version: '1.0', builds: { windows: { files: {} } } },
  ],
};
const ledger = (entries) => ({ schema: 1, entries });

test('plan installs a missing requirement first', () => {
  const steps = plan(cat, ledger({}), ['pack'], 'mac');
  assert.deepEqual(steps.map((s) => [s.entry.id, s.action]), [['level-hook', 'install'], ['pack', 'install']]);
});

test('plan updates a too-old requirement, leaves a new-enough one alone', () => {
  assert.deepEqual(plan(cat, ledger({ 'level-hook': { version: '2.18.0', files: {} } }), ['pack'], 'mac').map((s) => [s.entry.id, s.action]),
    [['level-hook', 'update'], ['pack', 'install']]);
  assert.deepEqual(plan(cat, ledger({ 'level-hook': { version: '2.18.1', files: {} } }), ['pack'], 'mac').map((s) => s.entry.id), ['pack']);
});

test('plan: same version is current unless reinstall', () => {
  const l = ledger({ 'level-hook': { version: '2.19.0', files: {} } });
  assert.equal(plan(cat, l, ['level-hook'], 'mac')[0].action, 'current');
  assert.equal(plan(cat, l, ['level-hook'], 'mac', { reinstall: true })[0].action, 'update');
});

test('plan refuses a platform with no build', () => {
  assert.throws(() => plan(cat, ledger({}), ['winonly'], 'mac'), /no mac build/);
});

test('dependents and outdated', () => {
  const l = ledger({ 'level-hook': { version: '2.18.1', files: {} }, pack: { version: '1.2', files: {} } });
  assert.deepEqual(dependents(cat, l, 'level-hook'), ['pack']);
  assert.deepEqual(outdated(cat, l), ['level-hook']);
});

test('catalog ids must be plain slugs', async () => {
  const { checkId } = await import('../src/util.js');
  for (const ok of ['level-hook', 'ssx3-ports', 'a.b_c']) assert.equal(checkId(ok), ok);
  for (const bad of ['..', '../x', 'a/b', 'A', '', '.x', 'a..b', 'a\\b']) assert.throws(() => checkId(bad));
});
