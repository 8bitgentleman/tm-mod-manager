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
  if (cat.schema !== 1) throw new Error(`catalog schema ${cat.schema} is newer than this manager understands`);
  for (const e of cat.entries) {
    checkId(e.id);
    for (const r of Object.keys(e.requires || {})) checkId(r);
  }
  return cat;
}

export function findEntry(cat, id) {
  const e = cat.entries.find((x) => x.id === id);
  if (!e) throw new Error(`no catalog entry "${id}" (try: tmm list)`);
  return e;
}

// The build for this platform, or the platform-neutral one.
export function pickBuild(entry, platform) {
  const b = entry.builds[platform] || entry.builds.any;
  if (!b) throw new Error(`${entry.name} has no ${platform} build`);
  return b;
}
