// End-to-end check of the install engine against a throwaway game folder.
// Never point it at your real install.
//
//   TMM_E2E_APP=<path to TrickyMadness.app>   cloned (APFS copy-on-write) into the scratch folder
//   TMM_E2E_DIR=<scratch dir, will be wiped>
//   TMM_E2E_ZIPS=<folder of release zips>     e.g. tricky_mods/"Discord Releases"
//   TMM_E2E_CATALOG=<catalog.json>
//   node test/e2e.mjs
//
// Flow: BepInEx (resumed download) -> Blur pack at an older version, which pulls
// in an older Hook -> update both -> uninstall both -> folder must match the
// BepInEx-only snapshot byte for byte. Then a MEGA download (resumed) and the
// edited-.cfg rule.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { extractMembers, listMembers } from '../src/zip.js';
import { sha256File } from '../src/util.js';
import { BEPINEX } from '../src/bepinex.js';

const { TMM_E2E_APP: APP, TMM_E2E_DIR: DIR, TMM_E2E_ZIPS: ZIPS, TMM_E2E_CATALOG: CATALOG } = process.env;
if (!APP || !DIR || !ZIPS || !CATALOG) { console.log('skipped: set TMM_E2E_APP, TMM_E2E_DIR, TMM_E2E_ZIPS, TMM_E2E_CATALOG'); process.exit(0); }
const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const GAME = path.join(DIR, 'Tricky Madness');
const CACHE = path.join(DIR, 'cache');
const step = (s) => console.log(`\n== ${s}`);

function tmm(args, { catalog = CATALOG, zips = true } = {}) {
  const a = [CLI, '--game', GAME, '--platform', 'mac', '--catalog', catalog, ...(zips ? ['--zips', ZIPS] : []), ...args];
  const out = execFileSync(process.execPath, a, { encoding: 'utf8', env: { ...process.env, TMM_CACHE: CACHE } });
  process.stdout.write(out.replace(/^/gm, '   '));
  return out;
}

// path -> "sha256 mode" for files, "dir" for folders. The cloned app is skipped (never touched).
async function snapshot(root) {
  const out = {};
  const walk = async (d) => {
    for (const e of await fsp.readdir(d, { withFileTypes: true })) {
      const abs = path.join(d, e.name), rel = path.relative(root, abs);
      if (rel === 'TrickyMadness.app') continue;
      if (e.isDirectory()) { out[rel + '/'] = 'dir'; await walk(abs); }
      else out[rel] = `${await sha256File(abs)} ${((await fsp.stat(abs)).mode & 0o777).toString(8)}`;
    }
  };
  await walk(root);
  return out;
}
function diff(a, b) {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  return keys.filter((k) => a[k] !== b[k]).map((k) => `${k}: ${a[k] ?? '(none)'} -> ${b[k] ?? '(none)'}`);
}

// Seed a .part with the first half of the real zip, so the next fetch has to resume.
async function seedPart(src, sha) {
  const buf = await fsp.readFile(src);
  await fsp.mkdir(CACHE, { recursive: true });
  await fsp.writeFile(path.join(CACHE, `${sha}.zip.part`), buf.subarray(0, Math.floor(buf.length / 2)));
}

// Catalog files map for a zip whose members sit under one top folder.
async function filesFor(zip) {
  const tmp = path.join(DIR, 'hash-tmp');
  const members = (await listMembers(zip)).filter((m) => /\/(BepInEx|Maps)\//.test(m));
  const got = await extractMembers(zip, new Map(members.map((m, i) => [m, path.join(tmp, String(i))])));
  await fsp.rm(tmp, { recursive: true, force: true });
  return Object.fromEntries(members.map((m) => [m.slice(m.indexOf('/') + 1), { member: m, sha256: got.get(m).sha256, size: got.get(m).size, exec: m.endsWith('.dll') || undefined }]));
}

// ---- setup
await fsp.rm(DIR, { recursive: true, force: true });
await fsp.mkdir(GAME, { recursive: true });
execFileSync('cp', ['-cR', APP, path.join(GAME, 'TrickyMadness.app')]);
const real = JSON.parse(await fsp.readFile(CATALOG, 'utf8'));
const old = structuredClone(real);
const hook = old.entries.find((e) => e.id === 'level-hook');
const oldHookZip = path.join(ZIPS, 'Tricky Madness Level Hook v2.18.1 - Tricky Madness Mod.zip');
Object.assign(hook, { version: '2.18.1' });
Object.assign(hook.builds.any, { file: path.basename(oldHookZip), sha256: await sha256File(oldHookZip), size: (await fsp.stat(oldHookZip)).size, files: await filesFor(oldHookZip) });
const blur = old.entries.find((e) => e.id === 'blur-ports');
blur.version = '1.1';
const png = Object.entries(blur.builds.mac.files).find(([k]) => k.endsWith('.png'))[1];
blur.builds.mac.files['Maps/Blur - only in 1.1.png'] = { ...png };   // gone in 1.2: update must remove it
const OLD = path.join(DIR, 'catalog-old.json');
await fsp.writeFile(OLD, JSON.stringify(old));

const s0 = await snapshot(GAME);

step('BepInEx, download resumed from a half-written .part');
await seedPart(path.join(process.env.TMM_E2E_BEPINEX_DIR || '', BEPINEX.mac.file), BEPINEX.mac.sha256).catch(() => console.log('   (no local BepInEx zip to seed; full download)'));
tmm(['bepinex']);
const sh = await fsp.readFile(path.join(GAME, 'run_bepinex.sh'), 'utf8');
assert.match(sh, /^executable_name="TrickyMadness.app"$/m);
assert.equal((await fsp.stat(path.join(GAME, 'run_bepinex.sh'))).mode & 0o777, 0o755);
assert.match(tmm(['bepinex']), /already installed/);
// A Hook the player installed by hand, before the manager: installing the pack
// replaces it, and the uninstall below must put it back (the s1 diff checks that).
const HAND_HOOK = path.join(GAME, 'BepInEx/plugins/TrickyMaddnessLevelHook.dll');
await fsp.mkdir(path.dirname(HAND_HOOK), { recursive: true });
await fsp.writeFile(HAND_HOOK, 'hand-installed hook\n');
const s1 = await snapshot(GAME);
console.log(`   ${Object.keys(s1).length - Object.keys(s0).length} paths added`);

step('install blur-ports 1.1 (old catalog) -> pulls in level-hook 2.18.1');
assert.match(tmm(['install', 'blur-ports'], { catalog: OLD }), /replaced your BepInEx\/plugins\/TrickyMaddnessLevelHook\.dll/);
tmm(['status'], { catalog: OLD });
assert.ok(fs.existsSync(path.join(GAME, 'Maps/Blur - only in 1.1.png')));
assert.equal((await fsp.stat(path.join(GAME, 'BepInEx/plugins/TrickyMaddnessLevelHook.dll'))).mode & 0o777, 0o755);
assert.match(tmm(['install', 'blur-ports'], { catalog: OLD }), /already installed/);

step('update everything (real catalog)');
assert.match(tmm(['status']), /-> 2\.19\.0 available/);
tmm(['update']);
assert.ok(!fs.existsSync(path.join(GAME, 'Maps/Blur - only in 1.1.png')), 'file dropped in 1.2 was not removed');
assert.equal(await sha256File(path.join(GAME, 'BepInEx/plugins/TrickyMaddnessLevelHook.dll')),
  real.entries.find((e) => e.id === 'level-hook').builds.any.files['BepInEx/plugins/TrickyMaddnessLevelHook.dll'].sha256);
assert.match(tmm(['update']), /up to date/);

step('uninstall: the Hook is refused while the pack needs it');
assert.throws(() => tmm(['uninstall', 'level-hook']), /need/);
tmm(['uninstall', 'blur-ports']);
assert.match(tmm(['uninstall', 'level-hook']), /restored your earlier BepInEx\/plugins\/TrickyMaddnessLevelHook\.dll/);
const d1 = diff(s1, await snapshot(GAME));
console.log(d1.length ? d1.join('\n') : '   folder matches the BepInEx-only snapshot exactly');
assert.deepEqual(d1, []);

step('MEGA: couch-coop, download resumed from a half-written .part');
const cc = real.entries.find((e) => e.id === 'couch-coop').builds.any;
await seedPart(path.join(ZIPS, cc.file), cc.sha256);
tmm(['install', 'couch-coop'], { zips: false });
tmm(['uninstall', 'couch-coop']);
assert.deepEqual(diff(s1, await snapshot(GAME)), []);

step('an edited .cfg survives reinstall and uninstall');
tmm(['install', 'character-hook']);
const cfg = path.join(GAME, 'BepInEx/config/CharacterHook.cfg');
await fsp.appendFile(cfg, '\n# player edit\n');
const edited = await sha256File(cfg);
assert.match(tmm(['install', '--reinstall', 'character-hook']), /kept your BepInEx\/config\/CharacterHook\.cfg/);
assert.equal(await sha256File(cfg), edited);
assert.match(tmm(['uninstall', 'character-hook']), /kept BepInEx\/config\/CharacterHook\.cfg/);
const d2 = diff(s1, await snapshot(GAME));
assert.deepEqual(d2, ['BepInEx/config/: (none) -> dir', `BepInEx/config/CharacterHook.cfg: (none) -> ${edited} 644`]);
console.log('   only the edited cfg remains');

console.log('\nE2E PASSED');
