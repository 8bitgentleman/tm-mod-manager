#!/usr/bin/env node
// tmm — install, update and remove Tricky Madness mods from the catalog.
import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import { loadCatalog, CATALOG_URL } from './catalog.js';
import { locateGame } from './locate.js';
import { readLedger } from './ledger.js';
import fsp from 'node:fs/promises';
import { fetchBuild, cacheDir } from './fetch.js';
import { installFiles, uninstall } from './install.js';
import { plan, dependents, outdated } from './resolve.js';
import { ensureBepInEx, bepinexState } from './bepinex.js';
import { hostPlatform } from './util.js';

const USAGE = `usage: tmm [options] <command>

commands:
  list                   everything in the catalog, with what you have installed
  status                 what's installed, and what has an update
  bepinex                install BepInEx ${'5.4.23.5'} if the game has none
  install <id...>        install mods/packs (and the Level Hook version they need)
  update [id...]         update the named entries, or everything outdated
  uninstall <id>         remove an entry's files (your edited .cfg files are kept)

options:
  --game <dir>           game folder (default: found through Steam)
  --catalog <url|file>   catalog to use (default: the published one)
  --platform mac|windows (default: this computer)
  --zips <dir>           use release zips from this folder instead of MEGA
  --reinstall            install even if this version is already installed
  --force                take over files another entry owns / uninstall a requirement
`;

const { values: o, positionals: [cmd, ...ids] } = parseArgs({
  allowPositionals: true,
  options: {
    game: { type: 'string' }, catalog: { type: 'string' }, platform: { type: 'string' },
    zips: { type: 'string' }, reinstall: { type: 'boolean' }, force: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
});

function gameRunning(platform) {
  try {
    if (platform === 'mac') { execFileSync('pgrep', ['-x', 'TrickyMadness'], { stdio: 'ignore' }); return true; }
    return execFileSync('tasklist', ['/FI', 'IMAGENAME eq Tricky Madness.exe'], { encoding: 'utf8' }).includes('Tricky Madness.exe');
  } catch { return false; }
}

function progress(label) {
  if (!process.stderr.isTTY) return undefined;
  let last = -1;
  return (done, total) => {
    const pct = Math.floor((done / total) * 100);
    if (pct !== last) { last = pct; process.stderr.write(`\r  ${label} ${pct}%`); }
    if (done >= total) process.stderr.write('\n');
  };
}

async function main() {
  if (o.help || !cmd) { console.log(USAGE); return; }
  const platform = o.platform || hostPlatform();
  if (!['mac', 'windows'].includes(platform)) throw new Error('--platform must be mac or windows');
  const gameDir = o.game || (await locateGame(platform)).gameDir;
  const catalog = await loadCatalog(o.catalog || CATALOG_URL);
  const ledger = await readLedger(gameDir);
  const writes = ['bepinex', 'install', 'update', 'uninstall'].includes(cmd);
  if (writes && gameRunning(platform)) throw new Error('quit Tricky Madness first');

  const apply = async (steps) => {
    if (steps.some((s) => s.action !== 'current')) await ensureBepInEx(gameDir, ledger, platform);
    for (const { entry, build, action } of steps) {
      if (action === 'current') { console.log(`${entry.name} ${entry.version} is already installed`); continue; }
      const zip = await fetchBuild(catalog, build, { localDir: o.zips, onProgress: progress(build.file) });
      const platformKey = Object.keys(entry.builds).find((k) => entry.builds[k] === build);
      await installFiles(gameDir, ledger, { id: entry.id, version: entry.version, platform: platformKey, zip, files: build.files }, { force: o.force });
      console.log(`${action === 'install' ? 'Installed' : 'Updated'} ${entry.name} ${entry.version}`);
      // Packs run to gigabytes; a downloaded zip has done its job once installed.
      if (zip.startsWith(cacheDir())) await fsp.rm(zip, { force: true });
    }
  };

  switch (cmd) {
    case 'list':
      for (const e of catalog.entries) {
        const have = ledger.entries[e.id];
        const badge = e.status === 'stable' ? '' : ` [${e.status}]`;
        const avail = e.builds[platform] || e.builds.any ? '' : ` (no ${platform} build)`;
        console.log(`${e.id.padEnd(20)} ${e.version.padEnd(8)} ${have ? `installed ${have.version}` : ''.padEnd(9)}  ${e.name}${badge}${avail}`);
      }
      break;
    case 'status': {
      console.log(`game: ${gameDir}\nBepInEx: ${await bepinexState(gameDir)}`);
      const old = new Set(outdated(catalog, ledger));
      for (const [id, e] of Object.entries(ledger.entries)) {
        const c = catalog.entries.find((x) => x.id === id);
        console.log(`  ${id} ${e.version}${old.has(id) ? ` -> ${c.version} available` : ''} (${Object.keys(e.files).length} files)`);
      }
      break;
    }
    case 'bepinex':
      console.log((await ensureBepInEx(gameDir, ledger, platform)) ? 'BepInEx installed' : 'BepInEx is already installed — left as is');
      break;
    case 'install':
      if (!ids.length) throw new Error('install what? (tmm list)');
      await apply(plan(catalog, ledger, ids, platform, { reinstall: o.reinstall }));
      break;
    case 'update': {
      const targets = ids.length ? ids : outdated(catalog, ledger).filter((id) => id !== 'bepinex');
      if (!targets.length) { console.log('Everything is up to date'); break; }
      await apply(plan(catalog, ledger, targets, platform, { reinstall: o.reinstall }));
      break;
    }
    case 'uninstall': {
      if (ids.length !== 1) throw new Error('uninstall takes one id');
      const [id] = ids;
      const deps = id === 'bepinex' ? Object.keys(ledger.entries).filter((x) => x !== 'bepinex') : dependents(catalog, ledger, id);
      if (deps.length && !o.force) throw new Error(`${deps.join(', ')} need${deps.length === 1 ? 's' : ''} "${id}" — uninstall ${deps.length === 1 ? 'it' : 'them'} first, or use --force`);
      await uninstall(gameDir, ledger, id);
      console.log(`Uninstalled ${id}`);
      break;
    }
    default:
      throw new Error(`unknown command "${cmd}"\n\n${USAGE}`);
  }
}

main().catch((e) => { console.error(`tmm: ${e.message}`); process.exit(1); });
