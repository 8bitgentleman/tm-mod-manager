import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { adopt } from '../src/adopt.js';
import { readLedger } from '../src/ledger.js';

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const file = (body) => ({ member: 'x', sha256: sha(body), size: Buffer.byteLength(body) });

const HOOK = 'hook dll';
const MAP = 'map bundle';
const cat = {
  entries: [
    { id: 'bepinex', name: 'BepInEx', version: '5.4.23.5', builds: { any: { files: { 'winhttp.dll': file('bep') } } } },
    { id: 'hook', name: 'Hook', version: '2.19.0', builds: { any: { files: {
      'BepInEx/plugins/Hook.dll': file(HOOK), 'BepInEx/config/hook.cfg': file('defaults') } } } },
    { id: 'pack', name: 'Pack', version: '1.2', builds: { mac: { files: { 'Maps/A.asset': file(MAP), 'Maps/B.asset': file('b') } } } },
    { id: 'other', name: 'Other', version: '1.0', builds: { mac: { files: { 'Maps/A.asset': file(MAP) } } } },
  ],
};

async function game(files) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tmm-adopt-'));
  for (const [rel, body] of Object.entries(files)) {
    await fsp.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await fsp.writeFile(path.join(dir, rel), body);
  }
  return dir;
}

test('adopts exact hand installs, ignores .cfg edits, skips BepInEx', async () => {
  const dir = await game({
    'winhttp.dll': 'bep', 'BepInEx/plugins/Hook.dll': HOOK, 'BepInEx/config/hook.cfg': 'player edited',
    'Maps/A.asset': MAP, 'Maps/B.asset': 'b',
  });
  const ledger = await readLedger(dir);
  const ids = await adopt(cat, ledger, dir, 'mac');
  // "other" shares Maps/A.asset, which "pack" took first.
  assert.deepEqual(ids, ['hook', 'pack']);
  const saved = await readLedger(dir);
  assert.equal(saved.entries.hook.version, '2.19.0');
  // The .cfg keeps the catalog's hash, so the edit reads as the player's.
  assert.equal(saved.entries.hook.files['BepInEx/config/hook.cfg'], sha('defaults'));
  assert.ok(!saved.entries.bepinex);
  assert.deepEqual(await adopt(cat, saved, dir, 'mac'), []); // nothing left to find
});

test('a partial, older or same-size-but-different install is not adopted', async () => {
  const dir = await game({
    'BepInEx/plugins/Hook.dll': 'hook DLL', // same size, different bytes
    'Maps/A.asset': MAP, // B missing
  });
  const ledger = await readLedger(dir);
  // "other" is just Maps/A.asset, so it matches; the others don't.
  assert.deepEqual(await adopt(cat, ledger, dir, 'mac'), ['other']);
});

test('a missing .cfg still counts; the hash cache skips re-hashing', async () => {
  const dir = await game({ 'BepInEx/plugins/Hook.dll': HOOK });
  const cache = new Map();
  assert.deepEqual(await adopt(cat, { schema: 1, entries: {} }, dir, 'mac', { cache }), ['hook']);
  assert.equal(cache.size, 1);
});
