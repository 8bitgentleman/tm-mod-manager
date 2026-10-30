import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';

const open = (file) => new Promise((res, rej) =>
  yauzl.open(file, { lazyEntries: true, autoClose: false }, (e, z) => (e ? rej(e) : res(z))));

// Stream the named members out of a zip, one at a time (a pack can be 3 GB).
// wanted: Map(memberName -> destPath). Returns Map(memberName -> {sha256, size, mode}).
export async function extractMembers(zipFile, wanted) {
  const z = await open(zipFile);
  const got = new Map();
  try {
    await new Promise((resolve, reject) => {
      z.on('error', reject);
      z.on('end', resolve);
      z.on('entry', (entry) => {
        const dest = wanted.get(entry.fileName);
        if (!dest) return z.readEntry();
        z.openReadStream(entry, async (err, rs) => {
          if (err) return reject(err);
          try {
            await fsp.mkdir(path.dirname(dest), { recursive: true });
            const h = crypto.createHash('sha256');
            let size = 0;
            rs.on('data', (d) => { h.update(d); size += d.length; });
            await pipeline(rs, fs.createWriteStream(dest));
            got.set(entry.fileName, { sha256: h.digest('hex'), size, mode: (entry.externalFileAttributes >>> 16) & 0o777 });
            z.readEntry();
          } catch (e) { reject(e); }
        });
      });
      z.readEntry();
    });
  } finally {
    z.close();
  }
  return got;
}

// Every file member in the zip (directories skipped).
export async function listMembers(zipFile) {
  const z = await open(zipFile);
  const names = [];
  try {
    await new Promise((resolve, reject) => {
      z.on('error', reject);
      z.on('end', resolve);
      z.on('entry', (e) => { if (!e.fileName.endsWith('/')) names.push(e.fileName); z.readEntry(); });
      z.readEntry();
    });
  } finally { z.close(); }
  return names;
}
