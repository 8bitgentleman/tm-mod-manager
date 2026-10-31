import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { exists } from './util.js';

export const APP_ID = '2743850';
const GAME_DIR = 'Tricky Madness';

// Where Steam lives on Linux, most likely first. ~/.steam/steam is usually a
// symlink to ~/.local/share/Steam (the Deck's layout); Flatpak Steam keeps its
// own tree under ~/.var.
// posix on purpose: these paths only exist on Linux, and the tests run on Windows too.
export function linuxSteamRoots(home = os.homedir()) {
  return [
    path.posix.join(home, '.steam/steam'),
    path.posix.join(home, '.local/share/Steam'),
    path.posix.join(home, '.var/app/com.valvesoftware.Steam/.local/share/Steam'),
  ];
}

// os is the host OS ('mac' | 'windows' | 'linux'), not the build key.
async function steamRoot(os_, { home = os.homedir() } = {}) {
  if (os_ === 'mac') return path.join(home, 'Library/Application Support/Steam');
  if (os_ === 'linux') {
    for (const root of linuxSteamRoots(home)) if (await exists(path.join(root, 'steamapps'))) return root;
    throw new Error('Steam not found');
  }
  const { stdout } = await promisify(execFile)('reg', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath']);
  const m = /SteamPath\s+REG_SZ\s+(.+)/.exec(stdout);
  if (!m) throw new Error('Steam not found in the registry');
  return m[1].trim();
}

// libraryfolders.vdf lists every Steam library as "path" "<dir>".
export function parseLibraryFolders(vdf) {
  return [...vdf.matchAll(/"path"\s+"([^"]+)"/g)].map((m) => m[1].replace(/\\\\/g, '\\'));
}

export function parseBuildId(acf) {
  const m = /"buildid"\s+"(\d+)"/.exec(acf);
  return m ? m[1] : null;
}

// Returns { gameDir, buildId } or throws with a message a player can act on.
// On Linux this finds the game whichever build Steam installed; only the
// Windows (Proton) one has 'Tricky Madness.exe'.
export async function locateGame(os_, opts = {}) {
  const root = await steamRoot(os_, opts);
  let libs = [root];
  try {
    libs = parseLibraryFolders(await fsp.readFile(path.join(root, 'steamapps/libraryfolders.vdf'), 'utf8'));
  } catch { /* single-library install */ }
  for (const lib of libs) {
    const manifest = path.join(lib, 'steamapps', `appmanifest_${APP_ID}.acf`);
    if (!(await exists(manifest))) continue;
    const gameDir = path.join(lib, 'steamapps/common', GAME_DIR);
    if (!(await exists(gameDir))) continue;
    return { gameDir, buildId: parseBuildId(await fsp.readFile(manifest, 'utf8')) };
  }
  throw new Error('Tricky Madness not found in any Steam library — pass --game <folder>');
}
