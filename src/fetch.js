import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { PassThrough, Readable } from 'node:stream';
import { File } from 'megajs';
import { exists, sha256File } from './util.js';

export function cacheDir() {
  if (process.env.TMM_CACHE) return process.env.TMM_CACHE;
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || os.homedir(), 'tm-mod-manager', 'Cache');
  if (process.platform === 'linux') return path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'tm-mod-manager');
  return path.join(os.homedir(), 'Library', 'Caches', 'tm-mod-manager');
}

// MEGA's free-tier transfer cap surfaces as an opaque error; say what it means.
function friendly(err) {
  const m = String(err && err.message || err);
  if (/quota|bandwidth|EOVERQUOTA|\(-17\)|509/i.test(m)) {
    return new Error('MEGA\'s download limit for your network has been reached. Wait a few hours and try again — the download will resume where it stopped.');
  }
  return err;
}

async function megaFile(catalog, build) {
  const src = catalog.sources[build.source];
  if (!src || !src.link) throw new Error(`"${build.file}" isn't shared on MEGA yet`);
  const root = File.fromURL(src.link);
  await root.loadAttributes();
  let node = root;
  for (const part of build.path ? build.path.split('/') : []) {
    node = (node.children || []).find((c) => c.directory && c.name === part);
    if (!node) throw new Error(`MEGA folder is missing "${part}" — the catalog is out of date`);
  }
  const f = (node.children || []).find((c) => !c.directory && c.name === build.file);
  if (!f) throw new Error(`MEGA folder is missing "${build.file}" — the catalog is out of date`);
  return f;
}

// Stream `open(start)` onto the end of `part`, picking up where an earlier
// attempt stopped. Hashes the whole file at the end; a mismatch deletes it.
async function resumable(part, size, open, onProgress) {
  let have = (await exists(part)) ? (await fsp.stat(part)).size : 0;
  if (have > size) { await fsp.rm(part); have = 0; }
  if (have < size) {
    await new Promise((resolve, reject) => {
      const rs = open(have);
      const ws = fs.createWriteStream(part, { flags: 'a' });
      let done = have;
      rs.on('data', (d) => { done += d.length; onProgress?.(done, size); });
      rs.on('error', (e) => { ws.destroy(); reject(e); });
      ws.on('error', reject);
      ws.on('finish', resolve);
      rs.pipe(ws);
    });
  }
}

async function verifyInto(part, final, sha256) {
  const got = await sha256File(part);
  if (got !== sha256) {
    await fsp.rm(part, { force: true });
    throw new Error(`download is corrupt (sha256 ${got.slice(0, 12)}…, expected ${sha256.slice(0, 12)}…) — deleted, try again`);
  }
  await fsp.rename(part, final);
  return final;
}

// Get a catalog build's zip into the cache and return its path.
// opts.localDir: a folder of release zips to use instead of MEGA (still hash-checked).
export async function fetchBuild(catalog, build, { localDir, onProgress } = {}) {
  if (localDir) {
    const p = path.join(localDir, build.file);
    if (await exists(p)) {
      if ((await sha256File(p)) !== build.sha256) throw new Error(`${p} does not match the catalog hash`);
      return p;
    }
  }
  const dir = cacheDir();
  await fsp.mkdir(dir, { recursive: true });
  const final = path.join(dir, `${build.sha256}.zip`);
  if (await exists(final)) return final;
  const part = final + '.part';
  const f = await megaFile(catalog, build);
  try {
    await resumable(part, build.size, (start) => f.download(start ? { start } : {}), onProgress);
  } catch (e) { throw friendly(e); }
  return verifyInto(part, final, build.sha256);
}

// Plain HTTPS download (GitHub release assets), with the same cache + resume.
export async function fetchUrl(url, sha256, size, { onProgress } = {}) {
  const dir = cacheDir();
  await fsp.mkdir(dir, { recursive: true });
  const final = path.join(dir, `${sha256}.zip`);
  if (await exists(final)) return final;
  const part = final + '.part';
  await resumable(part, size, (start) => {
    const out = new PassThrough();
    fetch(url, { headers: start ? { Range: `bytes=${start}-` } : {} }).then((r) => {
      if (!r.ok) return out.destroy(new Error(`download failed: HTTP ${r.status} for ${url}`));
      if (start && r.status !== 206) return out.destroy(new Error('server ignored the resume request'));
      Readable.fromWeb(r.body).on('error', (e) => out.destroy(e)).pipe(out);
    }, (e) => out.destroy(e));
    return out;
  }, onProgress);
  return verifyInto(part, final, sha256);
}
