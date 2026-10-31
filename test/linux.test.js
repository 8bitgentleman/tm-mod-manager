// Linux (Steam Deck under Proton): host OS is 'linux', builds are 'windows'.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { hostPlatform, buildPlatformFor } from '../src/util.js';
import { locateGame, linuxSteamRoots, APP_ID } from '../src/locate.js';
import { gameRunning } from '../src/ops.js';
import { launchGame } from '../src/launch.js';
import { BEPINEX } from '../src/bepinex.js';
import { plan } from '../src/resolve.js';
import { cacheDir } from '../src/fetch.js';

test('host OS and build platform are split; only linux differs', () => {
  assert.deepEqual(hostPlatform('darwin'), { os: 'mac', buildPlatform: 'mac' });
  assert.deepEqual(hostPlatform('win32'), { os: 'windows', buildPlatform: 'windows' });
  assert.deepEqual(hostPlatform('linux'), { os: 'linux', buildPlatform: 'windows' });
  assert.throws(() => hostPlatform('freebsd'), /unsupported platform freebsd/);
});

test('linux installs the Windows builds and the Windows BepInEx', () => {
  const cat = { entries: [{ id: 'pack', name: 'Pack', version: '1', builds: { mac: { files: { m: {} } }, windows: { files: { w: {} } } } }] };
  const [step] = plan(cat, { schema: 1, entries: {} }, ['pack'], buildPlatformFor('linux'));
  assert.equal(step.build, cat.entries[0].builds.windows);
  assert.match(BEPINEX[buildPlatformFor('linux')].file, /^BepInEx_win_x64_/);
});

// A fake home with Steam at `root` and the game in a second library.
async function fakeHome(rootRel, { gameInRoot = false } = {}) {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'tmm-linux-'));
  const root = path.join(home, rootRel);
  const lib2 = path.join(home, 'sdcard');
  const lib = gameInRoot ? root : lib2;
  await fsp.mkdir(path.join(root, 'steamapps'), { recursive: true });
  await fsp.mkdir(path.join(lib, 'steamapps/common/Tricky Madness'), { recursive: true });
  await fsp.writeFile(path.join(lib, 'steamapps', `appmanifest_${APP_ID}.acf`), '"AppState"\n{\n "buildid"  "26061059"\n}');
  await fsp.writeFile(path.join(root, 'steamapps/libraryfolders.vdf'),
    `"libraryfolders"\n{\n "0"\n {\n  "path"  "${root}"\n }\n "1"\n {\n  "path"  "${lib2}"\n }\n}`);
  return { home, gameDir: path.join(lib, 'steamapps/common/Tricky Madness') };
}

for (const rootRel of ['.steam/steam', '.local/share/Steam', '.var/app/com.valvesoftware.Steam/.local/share/Steam']) {
  test(`locateGame finds the game through ~/${rootRel} and its libraryfolders.vdf`, async () => {
    const { home, gameDir } = await fakeHome(rootRel);
    try {
      assert.deepEqual(await locateGame('linux', { home }), { gameDir, buildId: '26061059' });
    } finally { await fsp.rm(home, { recursive: true, force: true }); }
  });
}

test('locateGame on linux: game in the Steam root itself', async () => {
  const { home, gameDir } = await fakeHome('.local/share/Steam', { gameInRoot: true });
  try {
    assert.equal((await locateGame('linux', { home })).gameDir, gameDir);
  } finally { await fsp.rm(home, { recursive: true, force: true }); }
});

test('locateGame on linux: no Steam at all says so', async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'tmm-linux-'));
  try {
    await assert.rejects(locateGame('linux', { home }), /Steam not found/);
  } finally { await fsp.rm(home, { recursive: true, force: true }); }
});

test('linuxSteamRoots order: ~/.steam/steam first, Flatpak last', () => {
  assert.deepEqual(linuxSteamRoots('/home/deck'), [
    '/home/deck/.steam/steam', '/home/deck/.local/share/Steam',
    '/home/deck/.var/app/com.valvesoftware.Steam/.local/share/Steam']);
});

test('gameRunning on linux asks pgrep for the Proton exe', async () => {
  const calls = [];
  const running = async (cmd, args) => { calls.push([cmd, ...args]); return { stdout: '4242\n' }; };
  assert.equal(await gameRunning('linux', '/g', { run: running }), true);
  assert.deepEqual(calls, [['pgrep', '-f', 'Tricky Madness\\.exe']]);
  // pgrep exits 1 (a rejection) when nothing matches.
  const none = async () => { throw Object.assign(new Error('exit 1'), { code: 1 }); };
  assert.equal(await gameRunning('linux', '/g', { run: none }), false);
});

test('launchGame on linux goes through Steam even for a non-Steam folder', async () => {
  const opened = [];
  assert.equal(await launchGame('/not/steam', 'linux', { openUrl: async (u) => { opened.push(u); } }), 'steam');
  assert.deepEqual(opened, [`steam://rungameid/${APP_ID}`]);
});

test('cacheDir on linux follows XDG_CACHE_HOME, else ~/.cache', () => {
  const saved = { platform: process.platform, xdg: process.env.XDG_CACHE_HOME, tmm: process.env.TMM_CACHE };
  Object.defineProperty(process, 'platform', { value: 'linux' });
  delete process.env.TMM_CACHE;
  try {
    process.env.XDG_CACHE_HOME = '/x/cache';
    assert.equal(cacheDir(), path.join('/x/cache', 'tm-mod-manager'));
    delete process.env.XDG_CACHE_HOME;
    assert.equal(cacheDir(), path.join(os.homedir(), '.cache', 'tm-mod-manager'));
  } finally {
    Object.defineProperty(process, 'platform', { value: saved.platform });
    if (saved.xdg === undefined) delete process.env.XDG_CACHE_HOME; else process.env.XDG_CACHE_HOME = saved.xdg;
    if (saved.tmm !== undefined) process.env.TMM_CACHE = saved.tmm;
  }
});
