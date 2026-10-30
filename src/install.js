import fsp from 'node:fs/promises';
import path from 'node:path';
import { safeJoin, exists, sha256File, pruneEmptyDirs, checkId } from './util.js';
import { extractMembers } from './zip.js';
import { ownerOf, writeLedger } from './ledger.js';

// A .cfg the player may have edited. We never overwrite or delete one that
// differs from what we last installed.
const isConfig = (rel) => rel.endsWith('.cfg');

function stagingDir(gameDir, id) {
  return path.join(gameDir, 'BepInEx', 'tm-manager', 'staging', checkId(id));
}

// Where a file the player put there by hand goes when an install replaces it.
// Uninstall moves it back, so removing the manager's Hook doesn't take away the
// Hook the player's own maps were already using.
const backupRoot = (gameDir) => path.join(gameDir, 'BepInEx', 'tm-manager', 'backup');

// Remove folders an uninstall emptied. BepInEx and the game recreate any they
// need (plugins/, Maps/), and keeping them would leave the folder different
// from before the install.
async function prune(gameDir, rel) {
  for (let d = path.dirname(safeJoin(gameDir, rel)); d.startsWith(gameDir + path.sep); d = path.dirname(d)) {
    try { await fsp.rmdir(d); } catch { return; }
  }
}

// Remove a file we installed, unless it changed since (then it's the player's now).
async function removeOwned(gameDir, rel, sha256, log) {
  const abs = safeJoin(gameDir, rel);
  if (!(await exists(abs))) return;
  if ((await sha256File(abs)) !== sha256) { log(`  kept ${rel} (changed since install)`); return; }
  await fsp.rm(abs);
  await prune(gameDir, rel);
}

// Put back the file an install replaced, if nothing has taken its place since.
async function restoreBackup(gameDir, rel, log) {
  const saved = safeJoin(backupRoot(gameDir), rel);
  if (!(await exists(saved))) return;
  const dest = safeJoin(gameDir, rel);
  if (await exists(dest)) { log(`  left your earlier ${rel} in ${path.relative(gameDir, saved)}`); return; }
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await fsp.rename(saved, dest);
  await pruneEmptyDirs(path.dirname(saved), path.join(gameDir, 'BepInEx'));
  log(`  restored your earlier ${rel}`);
}

async function stageAndPlace(gameDir, ledger, id, zip, files, prev, { force, log }) {
  for (const rel of Object.keys(files)) {
    safeJoin(gameDir, rel);
    const owner = ownerOf(ledger, rel);
    if (owner && owner !== id && !force) throw new Error(`${rel} already belongs to "${owner}" (use --force to take it over)`);
  }

  const stage = stagingDir(gameDir, id);
  await fsp.rm(stage, { recursive: true, force: true });
  try {
    // dest paths grouped by zip member; a member listed twice is extracted once and copied.
    const byMember = new Map();
    for (const [rel, f] of Object.entries(files)) byMember.set(f.member, [...(byMember.get(f.member) || []), rel]);
    const wanted = new Map([...byMember].map(([m, rels]) => [m, safeJoin(stage, rels[0])]));
    const got = await extractMembers(zip, wanted);
    for (const [m, rels] of byMember) {
      const g = got.get(m);
      if (!g) throw new Error(`zip is missing ${m}`);
      for (const rel of rels) {
        const f = files[rel];
        if (f.sha256 && (g.sha256 !== f.sha256 || g.size !== f.size)) throw new Error(`${m} in the zip doesn't match the catalog`);
        if (rel !== rels[0]) await fsp.copyFile(safeJoin(stage, rels[0]), safeJoin(stage, rel));
      }
    }

    const placed = {};
    const replaced = [];
    for (const [rel, f] of Object.entries(files)) {
      const dest = safeJoin(gameDir, rel);
      const staged = safeJoin(stage, rel);
      const sha = f.sha256 || got.get(f.member).sha256;
      if (isConfig(rel) && (await exists(dest))) {
        const onDisk = await sha256File(dest);
        const ours = prev?.files[rel];
        if (onDisk !== sha && onDisk !== ours) { log(`  kept your ${rel}`); placed[rel] = sha; continue; }
      }
      // A file no entry owns was put there by hand: keep it to restore on uninstall.
      if (prev?.replaced?.includes(rel)) replaced.push(rel);
      else if (!isConfig(rel) && !ownerOf(ledger, rel) && (await exists(dest))) {
        const saved = safeJoin(backupRoot(gameDir), rel);
        await fsp.mkdir(path.dirname(saved), { recursive: true });
        await fsp.rename(dest, saved);
        replaced.push(rel);
        log(`  replaced your ${rel} (kept a copy; uninstalling puts it back)`);
      }
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.rename(staged, dest);
      // Executable if the catalog says so or the zip itself marks it (BepInEx's own zip).
      if (process.platform !== 'win32') {
        await fsp.chmod(dest, f.exec || (got.get(f.member).mode & 0o111) ? 0o755 : 0o644);
      }
      placed[rel] = sha;
    }
    return { placed, replaced };
  } finally {
    await fsp.rm(stage, { recursive: true, force: true });
    await pruneEmptyDirs(path.dirname(stage), path.join(gameDir, 'BepInEx'));
  }
}

// Install or update one entry from an already-downloaded, hash-checked zip.
// files: catalog `files` map (install path -> {member, sha256, size, exec}).
export async function installFiles(gameDir, ledger, { id, version, platform, zip, files }, { force = false, log = console.log } = {}) {
  const prev = ledger.entries[id];
  const { placed, replaced } = await stageAndPlace(gameDir, ledger, id, zip, files, prev, { force, log });
  // Files the previous version had and this one doesn't.
  for (const [rel, sha] of Object.entries(prev?.files || {})) {
    if (!(rel in placed)) {
      await removeOwned(gameDir, rel, sha, log);
      if (prev.replaced?.includes(rel)) await restoreBackup(gameDir, rel, log);
    }
  }
  ledger.entries[id] = { version, platform, files: placed, replaced };
  await writeLedger(gameDir, ledger);
}

export async function uninstall(gameDir, ledger, id, { log = console.log } = {}) {
  const e = ledger.entries[id];
  if (!e) throw new Error(`"${id}" isn't installed`);
  for (const [rel, sha] of Object.entries(e.files)) {
    await removeOwned(gameDir, rel, sha, log);
    if (e.replaced?.includes(rel)) await restoreBackup(gameDir, rel, log);
  }
  delete ledger.entries[id];
  await writeLedger(gameDir, ledger);
}
