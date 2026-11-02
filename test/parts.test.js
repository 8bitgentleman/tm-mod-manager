// Schema-2 multi-part entries: a code fix downloads only the part that changed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadCatalog } from '../src/catalog.js';
import { readLedger } from '../src/ledger.js';
import { plan } from '../src/resolve.js';
import { applySteps, stepDownload } from '../src/ops.js';

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

// Smallest valid zip: stored (uncompressed) members. Enough for yauzl, and no
// zip tool is needed on the CI runners.
const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => { let c = ~0; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return ~c >>> 0; };
function zipOf(members) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, body] of Object.entries(members)) {
    const n = Buffer.from(name);
    const d = Buffer.from(body);
    const crc = crc32(d);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(d.length, 18); lh.writeUInt32LE(d.length, 22);
    lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(d.length, 20); ch.writeUInt32LE(d.length, 24);
    ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, n, d);
    centrals.push(ch, n);
    offset += 30 + n.length + d.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(centrals.length / 2, 8); end.writeUInt16LE(centrals.length / 2, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

// Writes the part's zip into dir and returns its catalog record.
async function part(dir, file, version, contents) {
  const members = Object.fromEntries(Object.entries(contents).map(([rel, body]) => [`top/${rel}`, body]));
  const buf = zipOf(members);
  await fsp.writeFile(path.join(dir, file), buf);
  const files = Object.fromEntries(Object.entries(contents).map(([rel, body]) =>
    [rel, { member: `top/${rel}`, sha256: sha(Buffer.from(body)), size: Buffer.byteLength(body) }]));
  return { version, source: 'radio', path: '', file, size: buf.length, sha256: sha(buf), files };
}

const DLL = 'BepInEx/plugins/RadioBigTM.dll';
const SONG = 'BepInEx/plugins/RadioBig/assets/tricky/song.mp3';
const MACP = 'BepInEx/plugins/RadioBig/players/mac-arm64/RadioBigPlayer';
const WINP = 'BepInEx/plugins/RadioBig/players/windows/RadioBigPlayer.exe';

async function setup() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'tmm-parts-'));
  const game = path.join(root, 'game');
  const zips = path.join(root, 'zips');
  await fsp.mkdir(path.join(game, 'BepInEx', 'core'), { recursive: true });
  await fsp.writeFile(path.join(game, 'BepInEx', 'core', 'BepInEx.dll'), 'bep'); // skip the BepInEx download
  await fsp.mkdir(zips);
  return { root, game, zips };
}

async function catalogAt(root, entry) {
  const p = path.join(root, `catalog-${entry.version}.json`);
  await fsp.writeFile(p, JSON.stringify({
    schema: 2, sources: { radio: { mega_path: '/x', link: null } }, entries: [entry],
  }));
  return loadCatalog(p);
}

async function install(t, cat, { reinstall } = {}) {
  const ledger = await readLedger(t.game);
  const steps = plan(cat, ledger, ['radio-big'], 'mac', { reinstall });
  const sizes = await Promise.all(steps.map(async (s) => (s.action === 'current' ? 0 : (await stepDownload(t.game, ledger, s)).size)));
  await applySteps({ catalog: cat, gameDir: t.game, ledger, platform: 'mac', steps, zipsDir: t.zips, onEvent: () => {} });
  return { sizes, ledger: await readLedger(t.game) };
}

function entry(version, parts) {
  return {
    id: 'radio-big', name: 'Radio Big', kind: 'plugin', version, requires: {}, parts,
    builds: { mac: { parts: ['code', 'player-mac', 'music'] }, windows: { parts: ['code', 'player-windows', 'music'] } },
  };
}

test('a schema-2 build joins its parts: summed size, merged files', async () => {
  const t = await setup();
  const parts = {
    code: await part(t.zips, 'Radio Big v1.0.zip', '1.0', { [DLL]: 'dll 1.0' }),
    'player-mac': await part(t.zips, 'Radio Big Player v1.0 (macOS).zip', '1.0', { [MACP]: 'mac player' }),
    'player-windows': await part(t.zips, 'Radio Big Player v1.0 (Windows).zip', '1.0', { [WINP]: 'win player' }),
    music: await part(t.zips, 'Radio Big Music v1.0.zip', '1.0', { [SONG]: 'la la la' }),
  };
  const cat = await catalogAt(t.root, entry('1.0', parts));
  const mac = cat.entries[0].builds.mac;
  assert.deepEqual(mac.parts.map((p) => p.id), ['code', 'player-mac', 'music']);
  assert.equal(mac.size, parts.code.size + parts['player-mac'].size + parts.music.size);
  assert.deepEqual(Object.keys(mac.files).sort(), [DLL, MACP, SONG].sort());
});

test('a code fix downloads only the code part and keeps the rest', async () => {
  const t = await setup();
  const music = await part(t.zips, 'Radio Big Music v1.0.zip', '1.0', { [SONG]: 'la la la' });
  const player = await part(t.zips, 'Radio Big Player v1.0 (macOS).zip', '1.0', { [MACP]: 'mac player' });
  const win = await part(t.zips, 'Radio Big Player v1.0 (Windows).zip', '1.0', { [WINP]: 'win player' });
  const v1 = { code: await part(t.zips, 'Radio Big v1.0.zip', '1.0', { [DLL]: 'dll 1.0' }), 'player-mac': player, 'player-windows': win, music };
  const first = await install(t, await catalogAt(t.root, entry('1.0', v1)));
  assert.equal(first.sizes[0], v1.code.size + player.size + music.size);

  // The release only re-uploads the code zip; the content zips are gone from
  // the local folder, so fetching one would fail the test.
  const code2 = await part(t.zips, 'Radio Big v1.1.zip', '1.1', { [DLL]: 'dll 1.1' });
  await fsp.rm(path.join(t.zips, music.file));
  await fsp.rm(path.join(t.zips, player.file));
  const second = await install(t, await catalogAt(t.root, entry('1.1', { ...v1, code: code2 })));
  assert.deepEqual(second.sizes, [code2.size]);
  assert.equal(await fsp.readFile(path.join(t.game, DLL), 'utf8'), 'dll 1.1');
  assert.equal(await fsp.readFile(path.join(t.game, SONG), 'utf8'), 'la la la');
  const rec = second.ledger.entries['radio-big'];
  assert.equal(rec.version, '1.1');
  assert.deepEqual(Object.keys(rec.files).sort(), [DLL, MACP, SONG].sort());
  assert.equal(rec.files[SONG], music.files[SONG].sha256);
});

test('a missing or changed file makes its part download again', async () => {
  const t = await setup();
  const v1 = {
    code: await part(t.zips, 'Radio Big v1.0.zip', '1.0', { [DLL]: 'dll 1.0' }),
    'player-mac': await part(t.zips, 'Radio Big Player v1.0 (macOS).zip', '1.0', { [MACP]: 'mac player' }),
    'player-windows': await part(t.zips, 'Radio Big Player v1.0 (Windows).zip', '1.0', { [WINP]: 'win player' }),
    music: await part(t.zips, 'Radio Big Music v1.0.zip', '1.0', { [SONG]: 'la la la' }),
  };
  const cat = await catalogAt(t.root, entry('1.0', v1));
  await install(t, cat);
  await fsp.writeFile(path.join(t.game, SONG), 'truncated'); // a different size
  const again = await install(t, cat, { reinstall: false });
  assert.deepEqual(again.sizes, [0], 'same version and nothing to repair is a no-op plan');
  const repair = await install(t, cat, { reinstall: true });
  assert.equal(repair.sizes[0], v1.code.size + v1['player-mac'].size + v1.music.size, 'repair fetches everything');
  assert.equal(await fsp.readFile(path.join(t.game, SONG), 'utf8'), 'la la la');

  // A new release with the music unchanged, but the song deleted on disk.
  await fsp.rm(path.join(t.game, SONG));
  const code2 = await part(t.zips, 'Radio Big v1.1.zip', '1.1', { [DLL]: 'dll 1.1' });
  const next = await install(t, await catalogAt(t.root, entry('1.1', { ...v1, code: code2 })));
  assert.deepEqual(next.sizes, [code2.size + v1.music.size]);
  assert.equal(await fsp.readFile(path.join(t.game, SONG), 'utf8'), 'la la la');
});

test('updating from a one-zip build keeps unchanged files and drops what the new build leaves out', async () => {
  const t = await setup();
  // 1.5.1's shape: one platform-neutral zip carrying both players.
  const all = await part(t.zips, 'Radio Big v1.0 - all.zip', '1.0',
    { [DLL]: 'dll 1.0', [MACP]: 'mac player', [WINP]: 'win player', [SONG]: 'la la la' });
  const old = { id: 'radio-big', name: 'Radio Big', kind: 'plugin', version: '1.0', requires: {}, builds: { any: all } };
  await install(t, await catalogAt(t.root, old));
  assert.ok(await fsp.stat(path.join(t.game, WINP)));

  const parts = {
    code: await part(t.zips, 'Radio Big v1.1.zip', '1.1', { [DLL]: 'dll 1.1' }),
    'player-mac': await part(t.zips, 'Radio Big Player v1.1 (macOS).zip', '1.1', { [MACP]: 'mac player' }),
    'player-windows': await part(t.zips, 'Radio Big Player v1.1 (Windows).zip', '1.1', { [WINP]: 'win player' }),
    music: await part(t.zips, 'Radio Big Music v1.1.zip', '1.1', { [SONG]: 'la la la' }),
  };
  const { sizes, ledger } = await install(t, await catalogAt(t.root, entry('1.1', parts)));
  assert.deepEqual(sizes, [parts.code.size], 'player and music match what 1.0 installed');
  await assert.rejects(fsp.stat(path.join(t.game, WINP)), 'the Windows player is not in the mac build');
  assert.deepEqual(Object.keys(ledger.entries['radio-big'].files).sort(), [DLL, MACP, SONG].sort());
});

test('a build naming a part the entry lacks, or two parts sharing a file, is refused', async () => {
  const t = await setup();
  const code = await part(t.zips, 'a.zip', '1', { [DLL]: 'x' });
  await assert.rejects(catalogAt(t.root, { ...entry('1', { code }), builds: { any: { parts: ['code', 'music'] } } }), /part "music"/);
  await assert.rejects(catalogAt(t.root, { ...entry('2', { code, again: code }), builds: { any: { parts: ['code', 'again'] } } }), /more than one part/);
});
