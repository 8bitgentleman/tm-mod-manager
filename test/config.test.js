import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { parseCfg, control, isAdvanced, applyEdits, validate, resetEdits } from '../src/config.js';

const dir = new URL('./fixtures/cfg/', import.meta.url);
const fixtures = Object.fromEntries(
  readdirSync(dir).filter((f) => f.endsWith('.cfg')).map((f) => [f, readFileSync(new URL(f, dir), 'utf8')]),
);
const find = (parsed, section, key) =>
  parsed.sections.find((s) => s.name === section).settings.find((s) => s.key === key);
const diffLines = (a, b) => {
  const x = a.split('\n'), y = b.split('\n');
  assert.equal(x.length, y.length, 'line count changed');
  return x.map((l, i) => (l === y[i] ? -1 : i)).filter((i) => i >= 0);
};

test('applyEdits with no edits round-trips every fixture, LF and CRLF', () => {
  assert.ok(Object.keys(fixtures).length >= 4);
  for (const [name, text] of Object.entries(fixtures)) {
    assert.equal(applyEdits(text, []), text, name);
    const crlf = text.replace(/\n/g, '\r\n');
    // Force the full rewrite path: an edit that writes the value already there.
    assert.equal(applyEdits(crlf, []), crlf, name + ' (CRLF, no edits)');
    const sec = parseCfg(crlf).sections.find((x) => x.settings.length);
    const s = sec.settings[0];
    assert.equal(applyEdits(crlf, [{ section: sec.name, key: s.key, value: s.value }]), crlf, name + ' (CRLF, rewrite)');
  }
});

test('an edit changes exactly the one key line', () => {
  const text = fixtures['MenuAtmosphere.cfg'];
  const out = applyEdits(text, [{ section: 'Atmosphere', key: 'SnowAmount', value: '2.5' }]);
  const changed = diffLines(text, out);
  assert.deepEqual(changed, [find(parseCfg(text), 'Atmosphere', 'SnowAmount').line]);
  assert.equal(out.split('\n')[changed[0]], 'SnowAmount = 2.5');
  assert.equal(find(parseCfg(out), 'Atmosphere', 'SnowAmount').value, '2.5');
});

test('edits are scoped by section when a key repeats', () => {
  const text = fixtures['BepInEx.cfg'];
  const out = applyEdits(text, [{ section: 'Logging.Disk', key: 'LogLevels', value: 'All' }]);
  const p = parseCfg(out);
  assert.equal(find(p, 'Logging.Disk', 'LogLevels').value, 'All');
  assert.equal(find(p, 'Logging.Console', 'LogLevels').value, 'Fatal, Error, Warning, Message, Info');
  assert.equal(diffLines(text, out).length, 1);
});

test('CRLF line endings survive an edit, including mixed files', () => {
  const crlf = fixtures['MenuAtmosphere.cfg'].replace(/\n/g, '\r\n');
  const out = applyEdits(crlf, [{ section: 'Atmosphere', key: 'Snow', value: 'false' }]);
  assert.ok(out.includes('\r\nSnow = false\r\n'));
  assert.equal(out.replace(/\r\n/g, '').includes('\n'), false, 'no bare LF introduced');
  assert.equal(out.length, crlf.length + 1);

  const mixed = '[A]\r\nX = 1\nY = 2\r\n';
  assert.equal(applyEdits(mixed, [{ section: 'A', key: 'X', value: '9' }]), '[A]\r\nX = 9\nY = 2\r\n');
});

test('unknown section/key and multi-line values throw', () => {
  const text = fixtures['MenuAtmosphere.cfg'];
  assert.throws(() => applyEdits(text, [{ section: 'Atmosphere', key: 'Nope', value: '1' }]), /unknown setting/);
  assert.throws(() => applyEdits(text, [{ section: 'Debug', key: 'Snow', value: 'true' }]), /unknown setting/);
  assert.throws(() => applyEdits(text, [{ section: 'Atmosphere', key: 'Snow', value: 'a\nb' }]), /single-line/);
});

test('parses types, defaults, descriptions and choices from real files', () => {
  const bep = parseCfg(fixtures['BepInEx.cfg']);
  const hide = find(bep, 'Chainloader', 'HideManagerGameObject');
  assert.equal(hide.type, 'Boolean');
  assert.equal(hide.default, 'false');
  assert.equal(hide.value, 'true');
  assert.equal(hide.description.split('\n').length, 3, 'multi-line description, trailing "## " dropped');
  assert.equal(control(hide), 'toggle');

  const levels = find(bep, 'Logging.Disk', 'LogLevels');
  assert.equal(levels.type, 'LogLevel');
  assert.deepEqual(levels.choices, ['None', 'Fatal', 'Error', 'Warning', 'Message', 'Info', 'Debug', 'All']);
  assert.equal(levels.flags, true);
  assert.equal(control(levels), 'select');

  const backend = find(bep, 'Preloader', 'HarmonyBackend');
  assert.equal(backend.flags, false);
  assert.deepEqual(backend.choices, ['auto', 'dynamicmethod', 'methodbuilder', 'cecil']);
  assert.equal(find(bep, 'Preloader.Entrypoint', 'Method').value, '.cctor');

  const atm = parseCfg(fixtures['MenuAtmosphere.cfg']);
  assert.deepEqual(atm.sections.map((s) => s.name), ['Atmosphere', 'Debug']);
  const amount = find(atm, 'Atmosphere', 'SnowAmount');
  assert.equal(amount.type, 'Single');
  assert.equal(control(amount), 'number');
  assert.equal(control(find(atm, 'Atmosphere', 'Floor')), 'text');
  assert.equal(fixtures['MenuAtmosphere.cfg'].split('\n')[amount.line], 'SnowAmount = 1');

  const circ = parseCfg(fixtures['TrickyCircuit.cfg']);
  const key = find(circ, 'Debug', 'DebugStartKey');
  assert.equal(key.type, 'KeyCode');
  assert.ok(key.choices.length > 300);
  assert.equal(control(key), 'select', 'choices win over the type');
});

test('orphaned entries (no metadata) parse as untyped text', () => {
  const circ = parseCfg(fixtures['TrickyCircuit.cfg']);
  const orphan = find(circ, 'Atmosphere', 'SnowAmount');
  assert.equal(orphan.type, null);
  assert.equal(orphan.default, null);
  assert.equal(orphan.description, '');
  assert.equal(control(orphan), 'text');
  assert.equal(find(circ, 'Debug', 'AtmosphereShot').type, null);
  // The same key name in a bound section is not an orphan.
  assert.equal(find(circ, 'Background', 'Enabled').type, 'Boolean');
});

test('synthetic shapes: range, spaces in key, = in value, empty values, stray comments', () => {
  const syn = parseCfg(fixtures['synthetic.cfg']);
  const speed = find(syn, 'General', 'Speed Multiplier');
  assert.deepEqual(speed.range, { min: 0, max: 3 });
  assert.equal(speed.description, 'Speed multiplier.\nSecond description line.');
  assert.equal(find(syn, 'General', 'Count').description, 'Count of things.');
  const arms = find(syn, 'General', 'Arms');
  assert.equal(arms.value, 'hold:BoardPressCashAt=1000000;cash:BoardPressCashAt=800');
  assert.equal(arms.default, 'null:SpeedControl=false;base:SpeedControl=true');
  const out = find(syn, 'General', 'OutDir');
  assert.equal(out.value, '');
  assert.equal(out.default, '');

  const text = fixtures['synthetic.cfg'];
  const edited = applyEdits(text, [
    { section: 'General', key: 'Arms', value: 'a:X=1' },
    { section: 'General', key: 'Speed Multiplier', value: '0.5' },
    { section: 'General', key: 'OutDir', value: 'dump' },
  ]);
  assert.equal(diffLines(text, edited).length, 3);
  assert.ok(edited.includes('\nArms = a:X=1\n'));
  assert.ok(edited.includes('\nSpeed Multiplier = 0.5\n'));
  assert.ok(edited.includes('\nOutDir = dump\n'));
  assert.equal(applyEdits(edited, [{ section: 'General', key: 'OutDir', value: '' }]).includes('\nOutDir = \n'), true);
});

test('validate', () => {
  const syn = parseCfg(fixtures['synthetic.cfg']);
  const bep = parseCfg(fixtures['BepInEx.cfg']);
  const speed = find(syn, 'General', 'Speed Multiplier');
  const count = find(syn, 'General', 'Count');
  const byte = find(syn, 'Debug Tools', 'Level');
  const bool = find(bep, 'Chainloader', 'HideManagerGameObject');
  const flags = find(bep, 'Logging.Disk', 'LogLevels');
  const backend = find(bep, 'Preloader', 'HarmonyBackend');
  const str = find(bep, 'Preloader.Entrypoint', 'Method');

  for (const ok of ['0', '1.5', '3', '.5', '2e0', '-0']) assert.equal(validate(speed, ok), null, ok);
  for (const bad of ['', 'abc', '1,5', '3.01', '-1', 'NaN', 'Infinity', ' 1']) assert.ok(validate(speed, bad), bad);

  assert.equal(validate(count, '8'), null);
  for (const bad of ['1.5', '9', '0', '1e3', '']) assert.ok(validate(count, bad), bad);
  assert.equal(validate(byte, '255'), null);
  assert.ok(validate(byte, '256'));
  assert.ok(validate(byte, '-1'));
  assert.ok(validate({ type: 'Int32' }, '2147483648'));
  assert.equal(validate({ type: 'Int64' }, '9223372036854775807'), null);

  assert.equal(validate(bool, 'true'), null);
  assert.equal(validate(bool, 'False'), null);
  assert.ok(validate(bool, 'yes'));

  assert.equal(validate(flags, 'Error, Warning'), null);
  assert.equal(validate(flags, 'All'), null);
  assert.ok(validate(flags, 'Error, Bogus'));
  assert.ok(validate(flags, 'Error,'));
  assert.equal(validate(backend, 'cecil'), null);
  assert.equal(validate(backend, 'Cecil'), null, 'enums parse case-insensitively in BepInEx');
  assert.ok(validate(backend, 'cecil, auto'), 'non-flags enum takes one value');
  assert.ok(validate(backend, 'nope'));

  assert.equal(validate(str, 'anything = goes'), null);
  assert.ok(validate(str, 'two\nlines'));
});

test('resetEdits restores defaults and skips orphans', () => {
  const text = fixtures['TrickyCircuit.cfg'];
  const parsed = parseCfg(text);
  const edits = resetEdits(parsed);
  assert.ok(edits.every((e) => e.section !== 'Atmosphere'), 'orphans have no default');
  const after = parseCfg(applyEdits(text, edits));
  for (const sec of after.sections)
    for (const s of sec.settings) if (s.default !== null) assert.equal(s.value, s.default, `${sec.name}.${s.key}`);
  assert.deepEqual(resetEdits(after), []);

  const bep = resetEdits(parseCfg(fixtures['BepInEx.cfg']));
  assert.deepEqual(bep.find((e) => e.key === 'HideManagerGameObject'), { section: 'Chainloader', key: 'HideManagerGameObject', value: 'false' });
});

test('isAdvanced', () => {
  for (const n of ['Debug', 'debug', 'Probe', 'FlipProbe', 'Sampler', 'Diagnostics', 'Harness', 'Debug Tools', 'Advanced'])
    assert.equal(isAdvanced(n), true, n);
  for (const n of ['General', 'Atmosphere', 'Logging.Disk', 'Circuit']) assert.equal(isAdvanced(n), false, n);
});
