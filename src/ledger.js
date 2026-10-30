import fsp from 'node:fs/promises';
import path from 'node:path';

// What the manager installed, so uninstall touches only its own files.
// Written without timestamps and with sorted keys: the same set of installs
// always serialises to the same bytes.
export function ledgerPath(gameDir) {
  return path.join(gameDir, 'BepInEx', 'tm-manager', 'installed.json');
}

export async function readLedger(gameDir) {
  try {
    return JSON.parse(await fsp.readFile(ledgerPath(gameDir), 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return { schema: 1, entries: {} };
    throw e;
  }
}

function sorted(o) {
  return Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
}

export async function writeLedger(gameDir, ledger) {
  const out = { schema: 1, entries: {} };
  for (const [id, e] of Object.entries(sorted(ledger.entries))) {
    out.entries[id] = { version: e.version, platform: e.platform, files: sorted(e.files) };
    // Hand-installed files this entry replaced (backed up; uninstall restores them).
    if (e.replaced?.length) out.entries[id].replaced = [...e.replaced].sort();
  }
  const p = ledgerPath(gameDir);
  await fsp.mkdir(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(out, null, 2) + '\n');
  await fsp.rename(tmp, p);
}

// Which installed entry owns a game-relative path, if any.
export function ownerOf(ledger, rel) {
  for (const [id, e] of Object.entries(ledger.entries)) if (rel in e.files) return id;
  return null;
}
