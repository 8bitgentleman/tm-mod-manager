import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { exists } from './util.js';

export const APP_ID = '2743850';
const GAME_DIR = 'Tricky Madness';

async function steamRoot(platform) {
  if (platform === 'mac') return path.join(os.homedir(), 'Library/Application Support/Steam');
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
export async function locateGame(platform) {
  const root = await steamRoot(platform);
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
