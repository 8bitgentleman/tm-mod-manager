// Electron main process: a thin IPC layer over the engine in ../src. All file
// and network work happens here; the window only renders what getState returns.
import { app, BrowserWindow, ipcMain, dialog, shell, clipboard } from 'electron';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadCatalog, CATALOG_URL, pickBuild } from '../src/catalog.js';
import { locateGame } from '../src/locate.js';
import { readLedger } from '../src/ledger.js';
import { adopt } from '../src/adopt.js';
import { uninstall } from '../src/install.js';
import { plan, dependents, outdated } from '../src/resolve.js';
import { bepinexState, BEPINEX } from '../src/bepinex.js';
import { gameRunning, applySteps } from '../src/ops.js';
import { launchGame } from '../src/launch.js';
import { hostPlatform, exists, safeJoin, cmpVersion } from '../src/util.js';
import { parseCfg, applyEdits, validate, control, isAdvanced, isAdvancedKey } from '../src/config.js';
import { cacheDir } from '../src/fetch.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// host: how to find, start and watch the game. platform: which builds to install
// (Linux installs the Windows ones, for Proton — see hostPlatform()).
const { os: host, buildPlatform: platform } = hostPlatform();
// What a Linux player sets by hand in Steam (the game's Properties). Steam rewrites
// localconfig.vdf while it runs, so the app never edits it for them.
const LINUX_LAUNCH_OPTION = 'WINEDLLOVERRIDES="winhttp=n,b" %command%';
const SETTINGS_FILE = () => path.join(app.getPath('userData'), 'settings.json');
const DEFAULTS = { gameDir: null, catalog: null, zipsDir: null, showPrerelease: false, showAdvanced: false };

// A plain-text history a tester can send back: what was installed, removed,
// launched, and every error in full (the window shows a friendlier version).
const LOG_FILE = () => path.join(app.getPath('userData'), 'tmm.log');
const LOG_MAX = 1e6;
let logQueue = Promise.resolve();
function log(line) {
  const text = `${new Date().toISOString()}  ${line}\n`;
  logQueue = logQueue.then(async () => {
    try {
      const st = await fsp.stat(LOG_FILE()).catch(() => null);
      if (st && st.size > LOG_MAX) await fsp.rename(LOG_FILE(), `${LOG_FILE()}.old`);
      await fsp.mkdir(path.dirname(LOG_FILE()), { recursive: true });
      await fsp.appendFile(LOG_FILE(), text);
    } catch { /* a log we can't write must never break an install */ }
  });
  return logQueue;
}

// Engine errors are written for developers; say what they mean to a player.
// The original message still goes to the log.
function plain(msg) {
  const m = String(msg);
  if (/catalog download failed|fetch failed|ENOTFOUND|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN/i.test(m))
    return 'Couldn\'t connect to the internet. Check your connection and try again.';
  if (/schema .* newer than this manager/.test(m)) return 'The mod list needs a newer version of this app. Download the latest one and try again.';
  if (/catalog is out of date|isn't shared on MEGA yet/.test(m)) return 'This download isn\'t available right now. Close and reopen the app; if it still fails, tell the mod\'s author.';
  if (/download is corrupt/.test(m)) return 'The download got damaged on the way and was thrown away. Press the button again to retry.';
  if (/already belongs to/.test(m)) return 'Another mod already uses one of these files, so nothing was changed. Ask the mod\'s author which one to keep.';
  if (/does not match the catalog hash|zip is missing/.test(m)) return 'A downloaded file wasn\'t what the mod list expected, so nothing was changed. Tell the mod\'s author.';
  if (/EACCES|EPERM/.test(m)) return 'The computer wouldn\'t let the app change the game folder. Close the game and any open game files, then try again.';
  if (/ENOSPC/.test(m)) return 'Your disk is full. Free up some space and try again.';
  return m;
}

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
  try { catalog = await loadCatalog(catalogSrc()); catalogError = null; } catch (e) { catalog = null; catalogError = plain(e.message); log(`mod list failed: ${e.message}`); }
}

const samePath = (a, b) => {
  const norm = (p) => path.resolve(p).replace(/[\\/]+$/, '');
  return host === 'windows' ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
};

async function findGame() {
  let buildId = null;
  let found = null;
  try { ({ gameDir: found, buildId } = await locateGame(host)); } catch { /* fall back to the saved folder */ }
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

// Mods installed by hand before the manager: recorded in the background so a
// first look at a big Maps/ folder (gigabytes to hash) doesn't stall the window.
// The hash cache makes every later pass a stat per file.
const hashCache = new Map();
let adopting = null;
function scheduleAdopt(gameDir) {
  if (adopting || busy || !catalog) return;
  adopting = (async () => {
    try {
      const ids = await adopt(catalog, await readLedger(gameDir), gameDir, platform, { cache: hashCache });
      if (ids.length) send({ type: 'adopted', names: ids.map((id) => catalog.entries.find((e) => e.id === id).name) });
    } catch { /* a folder we can't read just means nothing adopted */ } finally {
      adopting = null;
    }
  })();
}

async function getState() {
  const { gameDir, buildId } = await findGame();
  const base = { platform, host, linuxLaunchOption: LINUX_LAUNCH_OPTION, appVersion: app.getVersion(), appUpdate, settings, catalogError, cacheDir: cacheDir(), bepinexVersion: BEPINEX.version, busy };
  if (!gameDir) return { ...base, gameError: 'Tricky Madness was not found in your Steam libraries. Pick its folder in Settings.' };
  const ledger = await readLedger(gameDir);
  scheduleAdopt(gameDir);
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
    // Linux: no .exe means Steam installed the native Linux build — Proton isn't forced yet.
    needsProton: host === 'linux' && !(await exists(path.join(gameDir, 'Tricky Madness.exe'))),
    running: await gameRunning(host, gameDir),
    managedBepInEx: Boolean(ledger.entries.bepinex), entries,
  };
}

// The manager's own update check. It runs here, not in the window: the window's CSP
// allows no network. A missing repo or no releases yet (404) or no network means "no update".
const RELEASES_API = process.env.TMM_RELEASES_API || 'https://api.github.com/repos/8bitgentleman/tm-mod-manager/releases/latest';
let appUpdate = null;
async function checkAppUpdate() {
  if (!app.isPackaged && !process.env.TMM_UPDATE_CHECK) return null; // dev runs would always nag
  try {
    const r = await fetch(RELEASES_API, { headers: { accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(10000) });
    if (!r.ok) return null;
    const rel = await r.json();
    const version = String(rel.tag_name || '').replace(/^v/, '');
    if (rel.draft || rel.prerelease || !/^\d+(\.\d+)*$/.test(version)) return null;
    if (cmpVersion(version, app.getVersion()) <= 0) return null;
    return { version, url: rel.html_url };
  } catch {
    return null;
  }
}

const send = (ev) => win?.webContents.send('tmm:event', ev);

// One write at a time; every write re-checks that the game is closed.
async function exclusive(fn) {
  if (busy) throw new Error('Another install is still running');
  busy = true;
  try {
    await adopting; // it writes the ledger too
    const { gameDir } = await findGame();
    if (!gameDir) throw new Error('Pick the game folder in Settings first');
    if (await gameRunning(host, gameDir)) throw new Error('Quit Tricky Madness first — files can\'t change while it is running');
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
      onEvent: (ev) => {
        if (ev.type === 'step') log(`  ${ev.label}${ev.index ? ` (${ev.index} of ${ev.count})` : ''}`);
        send({ type: ev.type, label: ev.label, action: ev.action, id: ev.entry?.id, done: ev.done, total: ev.total, index: ev.index, count: ev.count });
      },
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
    await uninstall(gameDir, ledger, id, { log: (m) => { notes.push(m); log(`  ${m}`); } });
    return { state: await getState(), notes };
  }),

  launch: async () => {
    const { gameDir, steamDir } = await findGame();
    if ((await bepinexState(gameDir)) === 'none') throw new Error('Install a mod first — that sets up BepInEx, which the mods run on');
    if (await gameRunning(host, gameDir)) throw new Error('Tricky Madness is already running');
    // Steam's launch URL always starts Steam's own install, so use it only when
    // that's the folder chosen; any other copy is started from its own exe.
    // Linux always goes through Steam: Proton only runs when Steam starts it.
    const viaSteam = host === 'linux' || (steamDir && samePath(steamDir, gameDir));
    return launchGame(gameDir, host, { openUrl: viaSteam ? (u) => shell.openExternal(u) : undefined });
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
          settings: s.settings.map((st) => ({ ...st, control: control(st), advanced: isAdvancedKey(st.key) })),
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
    if (!(await exists(path.join(dir, marker)))) {
      if (host === 'linux') throw new Error(`That folder has no ${marker}. If it is the game folder, Steam installed the Linux version: force Proton for Tricky Madness in Steam, let it download, then pick the folder again`);
      throw new Error(`That folder has no ${marker} — pick the folder the game is installed in`);
    }
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
  showLog: async () => { await log('log opened'); shell.showItemInFolder(LOG_FILE()); },
  copyLog: async () => {
    await log('log copied');
    const text = await fsp.readFile(LOG_FILE(), 'utf8').catch(() => '');
    clipboard.writeText(text.slice(-200000));
    return true;
  },
  // Only the fixed strings the window shows for Steam setup, never arbitrary text.
  copyText: async (text) => {
    if (text !== LINUX_LAUNCH_OPTION) throw new Error('nothing to copy');
    clipboard.writeText(text);
    return true;
  },
  showFolder: async () => { const { gameDir } = await findGame(); if (gameDir) shell.openPath(gameDir); },
};

// Errors cross IPC as {error} so the window shows our message, not Electron's wrapper.
// Reads (state, plan, config, the log itself) aren't worth a log line; actions are.
const QUIET = new Set(['state', 'plan', 'config', 'showLog', 'copyLog', 'copyText', 'showFolder']);
for (const [name, fn] of Object.entries(handlers)) {
  ipcMain.handle(`tmm:${name}`, async (_e, ...args) => {
    if (!QUIET.has(name)) log(`${name} ${args.map((a) => JSON.stringify(a)).join(' ')}`.trim());
    try {
      const ok = await fn(...args);
      if (!QUIET.has(name)) log(`${name} ok`);
      return { ok };
    } catch (e) {
      log(`${name} FAILED: ${e.stack || e.message}`);
      return { error: plain(e.message) };
    }
  });
}

app.whenReady().then(async () => {
  await loadSettings();
  log(`--- app ${app.getVersion()} started on ${host}, ${platform} builds (${process.platform} ${process.arch})`);
  await refreshCatalog();
  findGame().then(async ({ gameDir, buildId }) => {
    log(`game folder: ${gameDir || 'NOT FOUND'}; Steam build ${buildId || '?'}; BepInEx ${gameDir ? await bepinexState(gameDir) : '-'}`);
    if (gameDir) {
      const l = await readLedger(gameDir);
      log(`installed: ${Object.entries(l.entries).map(([id, e]) => `${id} ${e.version}`).join(', ') || 'nothing'}`);
    }
  }).catch((e) => log(`startup check failed: ${e.message}`));
  win = new BrowserWindow({
    width: 1180, height: 780, minWidth: 820, minHeight: 560,
    title: 'Tricky Madness Mods',
    backgroundColor: '#0f1620',
    webPreferences: { preload: path.join(HERE, 'preload.cjs'), contextIsolation: true, sandbox: true },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  await win.loadFile(path.join(HERE, 'index.html'));
  checkAppUpdate().then((u) => { appUpdate = u; if (u) send({ type: 'appUpdate' }); });
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
