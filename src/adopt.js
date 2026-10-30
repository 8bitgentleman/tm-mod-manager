import fsp from 'node:fs/promises';
import { safeJoin, sha256File } from './util.js';
import { ownerOf, writeLedger } from './ledger.js';

const isConfig = (rel) => rel.endsWith('.cfg');

// Hash a file, reusing an earlier answer while its size and mtime are unchanged.
// Map packs run to gigabytes, so the app keeps one cache for its whole run.
async function hashOf(abs, st, cache) {
  const key = `${abs}\0${st.size}\0${st.mtimeMs}`;
  if (cache?.has(key)) return cache.get(key);
  const sha = await sha256File(abs);
  cache?.set(key, sha);
  return sha;
}

// Does the game folder already hold exactly this build, put there by hand?
// Every non-.cfg file must be present byte for byte (sizes first, so a
// mismatch costs a stat, not a hash). A .cfg is the player's to edit, so it
// counts whether or not it still matches, or exists at all.
async function matches(gameDir, files, cache) {
  const check = Object.entries(files).filter(([rel]) => !isConfig(rel));
  if (!check.length) return false; // nothing that identifies the mod on disk
  const stats = [];
  for (const [rel, f] of check) {
    if (!f.sha256 || typeof f.size !== 'number') return false;
    const abs = safeJoin(gameDir, rel);
    let st;
    try { st = await fsp.stat(abs); } catch { return false; }
    if (!st.isFile() || st.size !== f.size) return false;
    stats.push([abs, st, f.sha256]);
  }
  for (const [abs, st, sha] of stats) if ((await hashOf(abs, st, cache)) !== sha) return false;
  return true;
}

// Record mods and packs the player installed by hand before using the manager,
// so they show as installed instead of asking to be installed again. Only an
// exact match of the catalog's current build counts; an older hand-installed
// version still shows "Install", and installing it backs the old files up.
// BepInEx is left out: the manager never takes over a BepInEx it didn't install.
// Returns the ids it adopted.
export async function adopt(catalog, ledger, gameDir, platform, { cache, log = () => {} } = {}) {
  const adopted = [];
  for (const e of catalog.entries) {
    if (e.id === 'bepinex' || ledger.entries[e.id]) continue;
    const build = e.builds?.[platform] || e.builds?.any;
    if (!build?.files) continue;
    const rels = Object.keys(build.files);
    // A file another entry already owns belongs to that entry.
    if (rels.some((rel) => ownerOf(ledger, rel))) continue;
    if (!(await matches(gameDir, build.files, cache))) continue;
    // Same shape installFiles writes; a .cfg records the catalog's hash, so an
    // edited one reads as the player's and is never overwritten or deleted.
    const files = Object.fromEntries(rels.map((rel) => [rel, build.files[rel].sha256]));
    ledger.entries[e.id] = { version: e.version, platform, files, replaced: [] };
    adopted.push(e.id);
    log(`Found ${e.name} ${e.version} already installed`);
  }
  if (adopted.length) await writeLedger(gameDir, ledger);
  return adopted;
}
