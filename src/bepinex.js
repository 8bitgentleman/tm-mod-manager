import fsp from 'node:fs/promises';
import path from 'node:path';
import { exists, sha256File } from './util.js';
import { fetchUrl } from './fetch.js';
import { listMembers } from './zip.js';
import { installFiles } from './install.js';
import { writeLedger } from './ledger.js';

// Pinned: the version every pack is tested on. Bump deliberately, with new hashes.
export const BEPINEX = {
  version: '5.4.23.5',
  mac: { file: 'BepInEx_macos_universal_5.4.23.5.zip', size: 658168,
    sha256: '01c2ae782eb016dfd6c345a18dbd2dcafffb3d9d318449d6486689f426b4a323' },
  windows: { file: 'BepInEx_win_x64_5.4.23.5.zip', size: 639118,
    sha256: '82f9878551030f54657792c0740d9d51a09500eeae1fba21106b0c441e6732c4' },
};
const URL_BASE = 'https://github.com/BepInEx/BepInEx/releases/download/v5.4.23.5/';

// 'none' | '5.x' | '6.x'. 6.x renamed its core assembly, which is how we tell.
export async function bepinexState(gameDir) {
  const core = path.join(gameDir, 'BepInEx', 'core');
  if (await exists(path.join(core, 'BepInEx.Core.dll'))) return '6.x';
  if (await exists(path.join(core, 'BepInEx.dll'))) return '5.x';
  return 'none';
}

// Install BepInEx if the game has none. An existing 5.x install is left alone
// (the player may have set it up by hand; it works). Returns true if installed.
export async function ensureBepInEx(gameDir, ledger, platform, { log = console.log, onProgress } = {}) {
  const state = await bepinexState(gameDir);
  if (state === '5.x') return false;
  if (state === '6.x') throw new Error('this game has BepInEx 6 installed; these mods need BepInEx 5');
  const pin = BEPINEX[platform];
  if (!pin?.file) throw new Error(`no BepInEx build for ${platform}`);
  log(`Installing BepInEx ${BEPINEX.version}…`);
  const zip = await fetchUrl(URL_BASE + pin.file, pin.sha256, pin.size, { onProgress });
  const files = Object.fromEntries((await listMembers(zip)).map((m) => [m, { member: m }]));
  await installFiles(gameDir, ledger, { id: 'bepinex', version: BEPINEX.version, platform, zip, files }, { log });

  if (platform === 'mac') {
    // The launcher has to be told which app to start (BEPINEX_SETUP.txt step 3).
    const rel = 'run_bepinex.sh';
    const sh = path.join(gameDir, rel);
    const text = await fsp.readFile(sh, 'utf8');
    const patched = text.replace(/^executable_name=.*$/m, 'executable_name="TrickyMadness.app"');
    if (patched === text) throw new Error('run_bepinex.sh has no executable_name line — BepInEx changed its launcher');
    await fsp.writeFile(sh, patched);
    await fsp.chmod(sh, 0o755);
    ledger.entries.bepinex.files[rel] = await sha256File(sh);
    await writeLedger(gameDir, ledger);
  }
  return true;
}
