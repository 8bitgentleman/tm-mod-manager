import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export async function sha256File(file) {
  const h = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) h.update(chunk);
  return h.digest('hex');
}

export async function exists(p) {
  try { await fsp.lstat(p); return true; } catch { return false; }
}

// A catalog install path is relative, '/'-separated and must stay inside the
// game folder. Anything else is a broken or hostile catalog.
export function safeJoin(root, rel) {
  if (typeof rel !== 'string' || rel === '' || rel.includes('\\') || rel.startsWith('/') ||
      /^[A-Za-z]:/.test(rel) || rel.split('/').some((p) => p === '' || p === '.' || p === '..')) {
    throw new Error(`refusing unsafe install path: ${JSON.stringify(rel)}`);
  }
  return path.join(root, ...rel.split('/'));
}

// Remove now-empty parent directories up to (not including) stop.
export async function pruneEmptyDirs(dir, stop) {
  stop = path.resolve(stop);
  for (let d = path.resolve(dir); d !== stop && d.startsWith(stop + path.sep); d = path.dirname(d)) {
    try { await fsp.rmdir(d); } catch { return; }
  }
}

// Numeric dotted versions only ("2.19.0", "1.5"); missing parts count as 0.
export function cmpVersion(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

// ">=2.19.0" is the only form the catalog writes today.
export function satisfies(version, range) {
  const m = /^>=\s*(\S+)$/.exec(range.trim());
  if (!m) throw new Error(`unsupported version range ${range}`);
  return cmpVersion(version, m[1]) >= 0;
}

export function hostPlatform() {
  if (process.platform === 'darwin') return 'mac';
  if (process.platform === 'win32') return 'windows';
  throw new Error(`unsupported platform ${process.platform}`);
}

// Catalog ids become folder names (staging) and ledger keys, so they must be
// plain slugs — an id like "../.." would point a recursive delete outside.
export const ID_RE = /^[a-z0-9][a-z0-9._-]*$/;
export function checkId(id) {
  if (typeof id !== 'string' || !ID_RE.test(id) || id.includes('..')) throw new Error(`bad catalog id ${JSON.stringify(id)}`);
  return id;
}
