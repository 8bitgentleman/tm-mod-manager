// Electron main process: a thin IPC layer over the engine in ../src. All file
// and network work happens here; the window only renders what getState returns.
import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadCatalog, CATALOG_URL, pickBuild } from '../src/catalog.js';
import { locateGame } from '../src/locate.js';
import { readLedger } from '../src/ledger.js';
import { uninstall } from '../src/install.js';
import { plan, dependents, outdated } from '../src/resolve.js';
import { bepinexState, BEPINEX } from '../src/bepinex.js';
import { gameRunning, applySteps } from '../src/ops.js';
import { launchGame } from '../src/launch.js';
import { hostPlatform, exists, safeJoin } from '../src/util.js';
import { parseCfg, applyEdits, validate, control, isAdvanced } from '../src/config.js';
import { cacheDir } from '../src/fetch.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const platform = hostPlatform();
const SETTINGS_FILE = () => path.join(app.getPath('userData'), 'settings.json');
const DEFAULTS = { gameDir: null, catalog: null, zipsDir: null, showPrerelease: false, showAdvanced: false };

let settings = { ...DEFAULTS };
let catalog = null;
let catalogError = null;
let busy = false;
let win;

async function loadSettings() {
  try { settings = { ...DEFAULTS, ...JSON.parse(await fsp.readFile(SETTINGS_FILE(), 'utf8')) }; } catch { /* first run */ }
}
async function saveSettings() {
  await fsp.mkdir(path.dirname(SETTINGS_FILE()), { recursive: true });
  await fsp.writeFile(SETTINGS_FILE(), JSON.stringify(settings, null, 2));
}

// Env vars win over saved settings so a test run can point at a game copy
// without touching the player's settings.
const catalogSrc = () => process.env.TMM_CATALOG || settings.catalog || CATALOG_URL;
const zipsDir = () => process.env.TMM_ZIPS || settings.zipsDir || undefined;

async function refreshCatalog() {
  try { catalog = await loadCatalog(catalogSrc()); catalogError = null; } catch (e) { catalog = null; catalogError = e.message; }
}

const samePath = (a, b) => {
  const norm = (p) => path.resolve(p).replace(/[\\/]+$/, '');
  return platform === 'windows' ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
};

async function findGame() {
  let buildId = null;
  let found = null;
  try { ({ gameDir: found, buildId } = await locateGame(platform)); } catch { /* fall back to the saved folder */ }
  const gameDir = process.env.TMM_GAME || settings.gameDir || found;
  // Steam's build id describes Steam's install only. A copy elsewhere could be
  // any build, so report none rather than a wrong one (it also mutes the drift badge).
  if (!(found && gameDir && samePath(found, gameDir))) buildId = null;
  return { gameDir, buildId, steamDir: found };
}

function thumbUrl(rel) {
  if (!rel) return null;
  const src = catalogSrc();
  if (/^https?:\/\//.test(src)) return new URL(rel, src).href;
  return pathToFileURL(path.join(path.dirname(path.resolve(src)), rel)).href;
}

function sourceReady(build) {
  return Boolean(zipsDir() || catalog.sources?.[build.source]?.link);
}

async function getState() {
  const { gameDir, buildId } = await findGame();
  const base = { platform, settings, catalogError, cacheDir: cacheDir(), bepinexVersion: BEPINEX.version, busy };
  if (!gameDir) return { ...base, gameError: 'Tricky Madness was not found in your Steam libraries. Pick its folder in Settings.' };
  const ledger = await readLedger(gameDir);
  const old = new Set(catalog ? outdated(catalog, ledger) : []);
  const entries = (catalog?.entries || []).map((e) => {
    let build = null;
    try { build = pickBuild(e, platform); } catch { /* no build for this OS */ }
    const have = ledger.entries[e.id];
    return {
      id: e.id, name: e.name, kind: e.kind, status: e.status, author: e.author, version: e.version,
      description: e.description, video: e.video, thumb: thumbUrl(e.thumb), requires: e.requires,
      hasConfig: Boolean(e.config?.length),
      size: build?.size ?? null, fileCount: build ? Object.keys(build.files).length : 0,
      available: Boolean(build && sourceReady(build)),
      unavailableReason: !build ? `No ${platform === 'mac' ? 'Mac' : 'Windows'} version yet` : (!sourceReady(build) ? 'Not shared for download yet' : null),
      installed: have?.version ?? null,
      outdated: old.has(e.id),
      // Drift: the game updated since this release was checked (MOD_MANAGER_PLAN.md v1 scope).
      drift: Boolean(have && e.tested_tm_build && buildId && e.tested_tm_build !== buildId),
    };
  });
  return {
    ...base, gameDir, buildId, bepinex: await bepinexState(gameDir),
    running: await gameRunning(platform, gameDir),
    managedBepInEx: Boolean(ledger.entries.bepinex), entries,
  };
}

const send = (ev) => win?.webContents.send('tmm:event', ev);

// One write at a time; every write re-checks that the game is closed.
async function exclusive(fn) {
  if (busy) throw new Error('Another install is still running');
  busy = true;
  try {
    const { gameDir } = await findGame();
    if (!gameDir) throw new Error('Pick the game folder in Settings first');
    if (await gameRunning(platform, gameDir)) throw new Error('Quit Tricky Madness first — files can\'t change while it is running');
    return await fn(gameDir);
  } finally {
    busy = false;
  }
}

function summarize(steps) {
  return steps.map(({ entry, build, action }) => ({ id: entry.id, name: entry.name, version: entry.version, action, size: build.size }));
}

const handlers = {
  state: () => getState(),
  reloadCatalog: async () => { await refreshCatalog(); return getState(); },

  // What an install would do, so the window can confirm it (and its download size).
  plan: async (ids, { reinstall } = {}) => {
    const { gameDir } = await findGame();
    const ledger = await readLedger(gameDir);
    const steps = plan(catalog, ledger, ids, platform, { reinstall });
    const bepinex = (await bepinexState(gameDir)) === 'none' && steps.some((s) => s.action !== 'current');
    return { steps: summarize(steps), bepinex };
  },

  install: (ids, { reinstall } = {}) => exclusive(async (gameDir) => {
    const ledger = await readLedger(gameDir);
    const steps = plan(catalog, ledger, ids, platform, { reinstall });
    await applySteps({
      catalog, gameDir, ledger, platform, steps, zipsDir: zipsDir(),
      onEvent: (ev) => send({ type: ev.type, label: ev.label, action: ev.action, id: ev.entry?.id, done: ev.done, total: ev.total }),
    });
    return getState();
  }),

  uninstall: (id) => exclusive(async (gameDir) => {
    const ledger = await readLedger(gameDir);
    const deps = dependents(catalog, ledger, id);
    if (deps.length) {
      const names = deps.map((d) => catalog.entries.find((e) => e.id === d)?.name || d);
      throw new Error(`${names.join(', ')} need${deps.length === 1 ? 's' : ''} this. Remove ${deps.length === 1 ? 'it' : 'them'} first.`);
    }
    const notes = [];
    await uninstall(gameDir, ledger, id, { log: (m) => notes.push(m) });
    return { state: await getState(), notes };
  }),

  launch: async () => {
    const { gameDir, steamDir } = await findGame();
    if ((await bepinexState(gameDir)) === 'none') throw new Error('Install a mod first — that sets up BepInEx, which the mods run on');
    if (await gameRunning(platform, gameDir)) throw new Error('Tricky Madness is already running');
    // Steam's launch URL always starts Steam's own install, so use it only when
    // that's the folder chosen; any other copy is started from its own exe.
    const viaSteam = steamDir && samePath(steamDir, gameDir);
    return launchGame(gameDir, platform, { openUrl: viaSteam ? (u) => shell.openExternal(u) : undefined });
  },

  // Settings screen data for one entry: each cfg it declares, parsed, or a note
  // that it doesn't exist until the mod's first run.
  config: async (id) => {
    const { gameDir } = await findGame();
    const entry = catalog.entries.find((e) => e.id === id);
    const out = [];
    for (const name of entry?.config || []) {
      const file = safeJoin(gameDir, `BepInEx/config/${name}`);
      if (!(await exists(file))) { out.push({ name, missing: true }); continue; }
      const parsed = parseCfg(await fsp.readFile(file, 'utf8'));
      out.push({
        name,
        sections: parsed.sections.map((s) => ({
          name: s.name, advanced: isAdvanced(s.name),
          settings: s.settings.map((st) => ({ ...st, control: control(st) })),
        })),
      });
    }
    return out;
  },

  saveConfig: (id, name, edits) => exclusive(async (gameDir) => {
    const entry = catalog.entries.find((e) => e.id === id);
    if (!entry?.config?.includes(name)) throw new Error(`${name} is not one of ${id}'s settings files`);
    const file = safeJoin(gameDir, `BepInEx/config/${name}`);
    const text = await fsp.readFile(file, 'utf8');
    const parsed = parseCfg(text);
    for (const ed of edits) {
      const st = parsed.sections.find((s) => s.name === ed.section)?.settings.find((x) => x.key === ed.key);
      if (!st) throw new Error(`unknown setting ${ed.section} / ${ed.key}`);
      const err = validate(st, ed.value);
      if (err) throw new Error(`${ed.key}: ${err}`);
    }
    const tmp = `${file}.tmm-tmp`;
    await fsp.writeFile(tmp, applyEdits(text, edits));
    await fsp.rename(tmp, file);
    return true;
  }),

  pickGame: async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Choose the Tricky Madness folder', properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths[0]) return getState();
    const dir = r.filePaths[0];
    const marker = platform === 'mac' ? 'TrickyMadness.app' : 'Tricky Madness.exe';
    if (!(await exists(path.join(dir, marker)))) throw new Error(`That folder has no ${marker} — pick the folder the game is installed in`);
    settings.gameDir = dir;
    await saveSettings();
    return getState();
  },

  pickZips: async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Folder of release zips', properties: ['openDirectory'] });
    if (!r.canceled && r.filePaths[0]) { settings.zipsDir = r.filePaths[0]; await saveSettings(); }
    return getState();
  },

  setSetting: async (key, value) => {
    if (!(key in DEFAULTS)) throw new Error(`unknown setting ${key}`);
    settings[key] = value;
    await saveSettings();
    if (key === 'catalog') await refreshCatalog();
    return getState();
  },

  openExternal: (url) => {
    if (!/^https:\/\//.test(url)) throw new Error('only https links open');
    return shell.openExternal(url);
  },
  showFolder: async () => { const { gameDir } = await findGame(); if (gameDir) shell.openPath(gameDir); },
};

// Errors cross IPC as {error} so the window shows our message, not Electron's wrapper.
for (const [name, fn] of Object.entries(handlers)) {
  ipcMain.handle(`tmm:${name}`, async (_e, ...args) => {
    try { return { ok: await fn(...args) }; } catch (e) { return { error: e.message }; }
  });
}

app.whenReady().then(async () => {
  await loadSettings();
  await refreshCatalog();
  win = new BrowserWindow({
    width: 1180, height: 780, minWidth: 820, minHeight: 560,
    title: 'Tricky Madness Mods',
    backgroundColor: '#0f1620',
    webPreferences: { preload: path.join(HERE, 'preload.cjs'), contextIsolation: true, sandbox: true },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  await win.loadFile(path.join(HERE, 'index.html'));
  if (process.env.TMM_SCREENSHOT) {
    // Test hook: capture the window and quit (used to check the UI without a person).
    setTimeout(async () => {
      try {
        const img = await win.webContents.capturePage();
        await fsp.writeFile(process.env.TMM_SCREENSHOT, img.toPNG());
      } catch (e) {
        console.error(`screenshot failed: ${e.message}`);
        process.exitCode = 1;
      }
      app.quit();
    }, Number(process.env.TMM_SCREENSHOT_DELAY || 2500));
  }
});

app.on('window-all-closed', () => app.quit());
