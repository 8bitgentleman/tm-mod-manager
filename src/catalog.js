import fsp from 'node:fs/promises';
import { checkId } from './util.js';

export const CATALOG_URL =
  'https://raw.githubusercontent.com/8bitgentleman/tm-mod-catalog/main/catalog.json';

export async function loadCatalog(src = CATALOG_URL) {
  let text;
  if (/^https?:\/\//.test(src)) {
    const r = await fetch(src);
    if (!r.ok) throw new Error(`catalog download failed: HTTP ${r.status}`);
    text = await r.text();
  } else {
    text = await fsp.readFile(src, 'utf8');
  }
  const cat = JSON.parse(text);
  if (cat.schema !== 1 && cat.schema !== 2) throw new Error(`catalog schema ${cat.schema} is newer than this manager understands`);
  for (const e of cat.entries) {
    checkId(e.id);
    for (const r of Object.keys(e.requires || {})) checkId(r);
    joinParts(e);
  }
  return cat;
}

// Schema 2: a build may list part ids instead of naming one zip, so a code fix
// ships without re-downloading a mod's large content (Radio Big's music). Each
// such build becomes { parts: [{id, file, size, sha256, files, ...}], size, files }
// with size and files summed over its parts, so code that only wants "what does
// this build install" reads it the same way as a one-zip build.
export function joinParts(entry) {
  for (const [key, b] of Object.entries(entry.builds || {})) {
    if (!Array.isArray(b.parts) || typeof b.parts[0] !== 'string') continue;
    const parts = b.parts.map((id) => {
      const p = entry.parts?.[id];
      if (!p) throw new Error(`${entry.name}: the ${key} build lists a part "${id}" the entry doesn't have`);
      return { id, ...p };
    });
    const files = {};
    for (const p of parts) {
      for (const [rel, f] of Object.entries(p.files)) {
        if (rel in files) throw new Error(`${entry.name}: ${rel} is in more than one part of the ${key} build`);
        files[rel] = f;
      }
    }
    entry.builds[key] = { parts, size: parts.reduce((n, p) => n + p.size, 0), files };
  }
}

// The zips a build is made of: its parts, or the build itself when it is one zip.
export const partsOf = (build) => build.parts || [build];

export function findEntry(cat, id) {
  const e = cat.entries.find((x) => x.id === id);
  if (!e) throw new Error(`no catalog entry "${id}" (try: tmm list)`);
  return e;
}

// The build for this platform, or the platform-neutral one. platform is the
// build key ('mac' | 'windows'), never 'linux' — see hostPlatform().
export function pickBuild(entry, platform) {
  const b = entry.builds[platform] || entry.builds.any;
  if (!b) throw new Error(`${entry.name} has no ${platform} build`);
  return b;
}
