// The window. Renders whatever window.tmm.state() returns; every action goes
// through window.tmm (preload.cjs) and re-renders from the state it returns.
'use strict';

const $ = (sel) => document.querySelector(sel);
let S = null;           // last state from main
let tab = 'all';
let openId = null;      // entry shown in the drawer
let view = 'detail';    // drawer view: detail | config | settings
let working = false;

// --- helpers -----------------------------------------------------------------

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  return el;
}

function size(n) {
  if (n == null) return '';
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${Math.round(n / 1e6)} MB`;
  return `${Math.max(1, Math.round(n / 1e3))} KB`;
}

let toastTimer;
function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast${err ? ' err' : ''}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, err ? 7000 : 3500);
}

// A modal that resolves to true (confirm) or false.
function ask({ title, body, ok = 'OK', cancel = 'Cancel', danger = false }) {
  const d = $('#modal');
  d.replaceChildren(
    h('div', { class: 'mbody' }, h('h2', {}, title), body),
    h('div', { class: 'mfoot' },
      cancel && h('button', { class: 'btn ghost', value: 'no' }, cancel),
      h('button', { class: `btn${danger ? ' danger' : ''}`, value: 'yes' }, ok)),
  );
  return new Promise((res) => {
    d.querySelectorAll('.mfoot button').forEach((b) => b.addEventListener('click', () => d.close(b.value)));
    d.addEventListener('close', () => res(d.returnValue === 'yes'), { once: true });
    d.returnValue = '';
    d.showModal();
  });
}

async function act(fn, { quiet = false } = {}) {
  try { return await fn(); } catch (e) { if (!quiet) toast(e.message, true); return undefined; }
}

// Placeholder art for entries with no thumbnail: a stable gradient per id.
function placeholder(e) {
  let n = 0;
  for (const c of e.id) n = (n * 31 + c.charCodeAt(0)) >>> 0;
  const hue = n % 360;
  const initials = e.name.split(/\s+/).map((w) => w[0]).join('').slice(0, 3).toUpperCase();
  const el = h('div', { class: 'thumb ph' }, initials);
  el.style.background = `linear-gradient(135deg, hsl(${hue} 60% 52%), hsl(${(hue + 40) % 360} 55% 32%))`;
  return el;
}
function thumb(e) {
  if (!e.thumb) return placeholder(e);
  const img = h('img', { class: 'thumb', src: e.thumb, alt: '' });
  img.addEventListener('error', () => img.replaceWith(placeholder(e)), { once: true });
  return img;
}

function badges(e) {
  return [
    e.status !== 'stable' && h('span', { class: `badge ${e.status}` }, e.status),
    e.outdated && h('span', { class: 'badge update' }, 'update'),
    e.drift && h('span', { class: 'badge drift', title: 'The game has updated since this was last tested' }, 'untested'),
  ];
}

// Only stable entries by default; alpha, beta and unreleased ones need the setting (an installed one always shows, so it can be removed).
const visible = () => (S?.entries || []).filter((e) => e.status === 'stable' || S.settings.showPrerelease || e.installed);

// --- render ------------------------------------------------------------------

function render() {
  if (!S) return;
  const gp = $('#gamepath');
  gp.textContent = S.gameDir || 'Game folder not found';
  gp.disabled = !S.gameDir;

  const pills = [];
  if (S.gameDir) {
    const be = S.bepinex === '5.x' ? ['ok', 'BepInEx ready'] : S.bepinex === '6.x' ? ['bad', 'BepInEx 6 — unsupported'] : ['off', 'BepInEx not installed'];
    pills.push(h('span', { class: `pill ${be[0]}`, title: S.bepinex === 'none' ? 'Installed for you with your first mod' : '' }, be[1]));
    if (S.buildId) pills.push(h('span', { class: 'pill', title: 'Tricky Madness build (from Steam)' }, `TM build ${S.buildId}`));
    if (S.running) pills.push(h('span', { class: 'pill ok' }, 'Game running'));
  }
  $('#status').replaceChildren(...pills);
  $('#play').disabled = !S.gameDir || S.running || S.bepinex !== '5.x' || working;
  $('#play').title = S.bepinex !== '5.x' ? 'Install a mod first' : '';

  renderBanners();
  renderGrid();
  if (openId || view === 'settings') renderDrawer();
}

function renderBanners() {
  const b = [];
  if (S.gameError) b.push(h('div', { class: 'banner err' }, h('span', { class: 'grow' }, S.gameError),
    h('button', { class: 'btn', onclick: pickGame }, 'Choose folder…')));
  if (S.catalogError) b.push(h('div', { class: 'banner err' }, h('span', { class: 'grow' }, `Couldn't load the mod list: ${S.catalogError}`),
    h('button', { class: 'btn ghost', onclick: reload }, 'Try again')));
  const drift = visible().filter((e) => e.drift);
  if (drift.length) b.push(h('div', { class: 'banner' }, h('span', { class: 'grow' },
    `Tricky Madness has updated since ${drift.map((e) => e.name).join(', ')} ${drift.length === 1 ? 'was' : 'were'} last tested. `
    + 'They may still work — if something breaks, check Discord for a new version.')));
  const upd = visible().filter((e) => e.outdated && e.available);
  if (upd.length) b.push(h('div', { class: 'banner info' },
    h('span', { class: 'grow' }, `${upd.length} update${upd.length === 1 ? '' : 's'} available: ${upd.map((e) => e.name).join(', ')}`),
    h('button', { class: 'btn', disabled: working || S.running, onclick: () => install(upd.map((e) => e.id), 'update') }, 'Update all')));
  if (S.appUpdate) b.push(h('div', { class: 'banner info' },
    h('span', { class: 'grow' }, `Tricky Madness Mods ${S.appUpdate.version} is out (you have ${S.appVersion}).`),
    h('button', { class: 'btn', onclick: () => act(() => window.tmm.openExternal(S.appUpdate.url)) }, 'Download')));
  if (S.gameDir && S.bepinex === '6.x') b.push(h('div', { class: 'banner err' },
    'This game has BepInEx 6. These mods need BepInEx 5 — remove BepInEx 6 by hand first.'));
  $('#banners').replaceChildren(...b);
}

function renderGrid() {
  let list = visible();
  if (tab === 'maps') list = list.filter((e) => e.kind === 'maps');
  if (tab === 'plugin') list = list.filter((e) => e.kind !== 'maps');
  if (tab === 'installed') list = list.filter((e) => e.installed);
  const cards = list.map((e) => h('div', { class: 'card', role: 'button', tabindex: '0', onclick: () => openDetail(e.id),
    onkeydown: (ev) => { if (ev.key === 'Enter' && ev.target === ev.currentTarget) openDetail(e.id); } },
    thumb(e),
    h('div', { class: 'body' },
      h('div', { class: 'row' }, h('h3', {}, e.name), ...badges(e)),
      h('div', { class: 'meta' }, `v${e.version}`, e.size != null && ` · ${size(e.size)}`, e.kind === 'framework' && ' · required by map packs'),
      h('div', { class: 'desc' }, e.description),
      h('div', { class: 'actions' }, cardAction(e)))));
  if (!cards.length) cards.push(h('div', { class: 'empty' }, tab === 'installed' ? 'Nothing installed yet.' : 'Nothing here.'));
  $('#grid').replaceChildren(...cards);
}

// The one button a card shows. Stops the click from also opening the drawer.
function cardAction(e) {
  const stop = (fn) => (ev) => { ev.stopPropagation(); fn(); };
  const off = working || S.running || !S.gameDir;
  if (e.installed && e.outdated && e.available) return h('button', { class: 'btn', disabled: off, onclick: stop(() => install([e.id], 'update')) }, `Update to v${e.version}`);
  if (e.installed) return h('span', { class: 'installed-tag' }, `✓ Installed v${e.installed}`);
  if (!e.available) return h('span', { class: 'meta' }, e.unavailableReason);
  return h('button', { class: 'btn', disabled: off, onclick: stop(() => install([e.id], 'install')) }, 'Install');
}

function renderDrawer() {
  const d = $('#detail');
  d.hidden = false;
  $('#scrim').hidden = false;
  if (view === 'settings') return renderSettings(d);
  const e = S.entries.find((x) => x.id === openId);
  if (!e) return closeDrawer();
  if (view === 'config') return renderConfig(d, e);

  const off = working || S.running || !S.gameDir;
  const reqs = Object.entries(e.requires || {}).map(([id, r]) => {
    const dep = S.entries.find((x) => x.id === id);
    return `${dep?.name || id} ${r.replace('>=', '')} or newer`;
  });
  const foot = [];
  if (!e.installed && e.available) foot.push(h('button', { class: 'btn', disabled: off, onclick: () => install([e.id], 'install') }, `Install · ${size(e.size)}`));
  if (e.installed && e.outdated && e.available) foot.push(h('button', { class: 'btn', disabled: off, onclick: () => install([e.id], 'update') }, `Update to v${e.version}`));
  if (e.installed && e.hasConfig) foot.push(h('button', { class: 'btn ghost', onclick: () => { view = 'config'; renderDrawer(); } }, 'Settings'));
  if (e.video) foot.push(h('button', { class: 'btn ghost', onclick: () => act(() => window.tmm.openExternal(e.video)) }, '▶ Watch video'));
  foot.push(h('span', { class: 'grow' }));
  if (e.installed && !e.outdated && e.available) foot.push(h('button', { class: 'btn ghost', disabled: off, title: 'Download and put back every file', onclick: () => install([e.id], 'repair') }, 'Repair'));
  if (e.installed) foot.push(h('button', { class: 'btn danger', disabled: off, onclick: () => remove(e) }, 'Remove'));

  d.replaceChildren(
    h('header', {}, h('h2', {}, e.name), ...badges(e), h('button', { class: 'icon', onclick: closeDrawer, 'aria-label': 'Close' }, '✕')),
    h('div', { class: 'scroll' },
      thumb(e),
      h('p', {}, e.description),
      e.status === 'alpha' && h('p', { class: 'meta' }, 'Alpha: early and rough. Expect bugs.'),
      e.status === 'beta' && h('p', { class: 'meta' }, 'Beta: mostly done, may still have bugs.'),
      e.drift && h('p', { class: 'meta' }, 'Tricky Madness has updated since this was last tested.'),
      h('dl', { class: 'facts' },
        h('dt', {}, 'Version'), h('dd', {}, `v${e.version}`),
        h('dt', {}, 'Installed'), h('dd', {}, e.installed ? `v${e.installed}` : 'No'),
        e.size != null && [h('dt', {}, 'Download'), h('dd', {}, `${size(e.size)} · ${e.fileCount} files`)],
        reqs.length && [h('dt', {}, 'Needs'), h('dd', {}, `${reqs.join(', ')} — installed for you`)],
        h('dt', {}, 'By'), h('dd', {}, e.author),
        !e.available && [h('dt', {}, 'Status'), h('dd', {}, e.unavailableReason)])),
    h('footer', {}, ...foot),
  );
}

// --- config editor -----------------------------------------------------------

let cfg = null;   // { id, files: [...], edits: Map(file -> Map("section\u0000key" -> value)) }

async function renderConfig(d, e) {
  if (!cfg || cfg.id !== e.id) {
    d.replaceChildren(h('header', {}, h('h2', {}, `${e.name} settings`)), h('div', { class: 'scroll' }, 'Loading…'));
    const files = await act(() => window.tmm.config(e.id));
    if (!files) { view = 'detail'; return renderDrawer(); }
    cfg = { id: e.id, files, edits: new Map() };
  }
  const showAdv = S.settings.showAdvanced;
  const body = [];
  for (const f of cfg.files) {
    if (f.missing) {
      body.push(h('div', { class: 'cfg-file' }, h('h3', {}, f.name),
        h('p', { class: 'meta' }, 'Launch the game once to create this mod\'s settings, then come back.')));
      continue;
    }
    const sections = f.sections.filter((s) => s.settings.length && (showAdv || !s.advanced));
    const hidden = f.sections.filter((s) => s.advanced && s.settings.length).length;
    body.push(h('div', { class: 'cfg-file' },
      cfg.files.length > 1 && h('h3', {}, f.name),
      sections.map((s, i) => h('details', { class: 'cfg-section', open: i < 3 || sections.length <= 4 },
        h('summary', {}, s.name || 'General', s.advanced && h('span', { class: 'badge unreleased' }, 'advanced')),
        s.settings.map((st) => settingRow(f.name, s.name, st)))),
      !showAdv && hidden > 0 && h('p', { class: 'meta' }, `${hidden} developer section${hidden === 1 ? ' is' : 's are'} hidden. Turn on "Show advanced settings" in Settings to see ${hidden === 1 ? 'it' : 'them'}.`)));
  }
  const pending = [...cfg.edits.values()].reduce((n, m) => n + m.size, 0);
  const off = working || S.running;
  d.replaceChildren(
    h('header', {}, h('button', { class: 'icon', 'aria-label': 'Back', onclick: () => leaveConfig('detail') }, '←'),
      h('h2', {}, `${e.name} settings`), h('button', { class: 'icon', 'aria-label': 'Close', onclick: () => leaveConfig(null) }, '✕')),
    h('div', { class: 'scroll' }, S.running && h('div', { class: 'banner' }, 'Quit the game to save: it rewrites this file when it closes.'), ...body),
    cfg.files.some((f) => !f.missing) && h('footer', {},
      h('button', { class: 'btn ghost', disabled: off, onclick: resetAll }, 'Reset all to defaults'),
      h('span', { class: 'grow' }),
      pending > 0 && h('button', { class: 'btn ghost', onclick: () => { cfg.edits.clear(); renderDrawer(); } }, 'Discard'),
      h('button', { class: 'btn', disabled: off || pending === 0, onclick: saveCfg }, working ? 'Saving…' : pending ? `Save ${pending} change${pending === 1 ? '' : 's'}` : 'Saved')),
  );
}

const ekey = (section, key) => `${section}\u0000${key}`;
function currentValue(file, section, st) {
  return cfg.edits.get(file)?.get(ekey(section, st.key)) ?? st.value;
}
function setEdit(file, section, st, value) {
  if (!cfg.edits.has(file)) cfg.edits.set(file, new Map());
  const m = cfg.edits.get(file);
  if (value === st.value) m.delete(ekey(section, st.key)); else m.set(ekey(section, st.key), value);
}

function settingRow(file, section, st) {
  const val = currentValue(file, section, st);
  const changed = val !== st.value;
  const update = (v) => { setEdit(file, section, st, v); renderDrawer(); };
  let ctl;
  if (st.control === 'toggle') {
    ctl = h('label', { class: 'switch' },
      h('input', { type: 'checkbox', checked: /^true$/i.test(val), onchange: (ev) => update(ev.target.checked ? 'true' : 'false') }), h('span'));
  } else if (st.control === 'select' && st.flags) {
    // Multi-value enum: one checkbox per choice, saved comma-separated.
    const on = new Set(val.split(',').map((x) => x.trim()).filter(Boolean));
    ctl = h('div', { class: 'ctl', style: 'flex-wrap:wrap;max-width:300px' }, st.choices.map((c) => h('label', { class: 'meta' },
      h('input', { type: 'checkbox', checked: on.has(c), onchange: (ev) => {
        if (ev.target.checked) on.add(c); else on.delete(c);
        update(st.choices.filter((x) => on.has(x)).join(', ') || st.choices[0]);
      } }), ` ${c} `)));
  } else if (st.control === 'select') {
    const opts = st.choices.includes(val) ? st.choices : [val, ...st.choices];
    ctl = h('select', { onchange: (ev) => update(ev.target.value) }, opts.map((c) => h('option', { value: c, selected: c === val }, c)));
  } else {
    // Commit on change (blur/enter), not every keystroke, so focus isn't lost.
    ctl = h('input', { type: st.control === 'number' ? 'number' : 'text', value: val, step: 'any',
      min: st.range?.min, max: st.range?.max, onchange: (ev) => update(ev.target.value) });
  }
  const canReset = st.default != null && val !== st.default;
  return h('div', { class: `setting${changed ? ' changed' : ''}` },
    h('div', { class: 'name' }, st.key),
    h('div', { class: 'ctl' }, ctl, canReset && h('button', { class: 'reset', title: `Default: ${st.default}`, onclick: () => update(st.default) }, 'Reset')),
    st.description && h('div', { class: 'help' }, st.description),
    st.type == null && h('div', { class: 'help' }, 'Left over from an older version of the mod — probably unused.'));
}

async function resetAll() {
  if (!(await ask({ title: 'Reset all settings?', body: h('p', {}, 'Every setting in this mod goes back to its default. Nothing is saved until you press Save.'), ok: 'Reset' }))) return;
  for (const f of cfg.files) {
    if (f.missing) continue;
    for (const s of f.sections) for (const st of s.settings) if (st.default != null) setEdit(f.name, s.name, st, st.default);
  }
  renderDrawer();
}

async function saveCfg() {
  if (working) return;
  // The game-running check before each write can take seconds (tasklist under Wine: 4-7 s),
  // so lock the footer meanwhile or a second click queues a second save.
  working = true;
  renderDrawer();
  try {
    for (const [file, m] of cfg.edits) {
      if (!m.size) continue;
      const edits = [...m].map(([k, value]) => { const [section, key] = k.split('\u0000'); return { section, key, value }; });
      const ok = await act(() => window.tmm.saveConfig(cfg.id, file, edits));
      if (ok === undefined) return;
    }
  } finally {
    working = false;
    if (cfg) renderDrawer();
  }
  const id = cfg.id;
  cfg = null;
  toast('Settings saved. They take effect the next time you start the game.');
  openId = id;
  renderDrawer();
}

async function leaveConfig(next) {
  const pending = cfg ? [...cfg.edits.values()].reduce((n, m) => n + m.size, 0) : 0;
  if (pending && !(await ask({ title: 'Discard changes?', body: h('p', {}, `You have ${pending} unsaved change${pending === 1 ? '' : 's'}.`), ok: 'Discard', danger: true }))) return;
  cfg = null;
  if (next) { view = next; renderDrawer(); } else closeDrawer();
}

// --- app settings ------------------------------------------------------------

function renderSettings(d) {
  const sw = (key, label, help) => h('div', { class: 'opt' },
    h('div', { class: 'grow' }, h('div', {}, label), h('div', { class: 'help' }, help)),
    h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: S.settings[key],
      onchange: async (ev) => { S = (await act(() => window.tmm.setSetting(key, ev.target.checked))) || S; render(); } }), h('span')));
  d.replaceChildren(
    h('header', {}, h('h2', {}, 'Settings'), h('button', { class: 'icon', onclick: closeDrawer, 'aria-label': 'Close' }, '✕')),
    h('div', { class: 'scroll' },
      h('div', { class: 'opt' },
        h('div', { class: 'grow' }, h('div', {}, 'Game folder'), h('div', { class: 'help' }, h('code', {}, S.gameDir || 'not found'))),
        h('button', { class: 'btn ghost', onclick: pickGame }, 'Change…')),
      sw('showPrerelease', 'Show test versions', 'Also list alpha, beta and unannounced mods and maps. They can be rough or broken.'),
      sw('showAdvanced', 'Show advanced settings', 'Show developer sections (Debug, Probe, Harness…) in each mod\'s settings.'),
      h('div', { class: 'opt' },
        h('div', { class: 'grow' }, h('div', {}, 'Install from a folder of zips'),
          h('div', { class: 'help' }, S.settings.zipsDir ? h('code', {}, S.settings.zipsDir) : 'Off: downloads come from MEGA. For mod authors testing their own release zips.')),
        S.settings.zipsDir
          ? h('button', { class: 'btn ghost', onclick: async () => { S = (await act(() => window.tmm.setSetting('zipsDir', null))) || S; render(); } }, 'Turn off')
          : h('button', { class: 'btn ghost', onclick: async () => { S = (await act(() => window.tmm.pickZips())) || S; render(); } }, 'Choose…')),
      h('div', { class: 'opt' },
        h('div', { class: 'grow' }, h('div', {}, 'Download cache'), h('div', { class: 'help' }, h('code', {}, S.cacheDir),
          h('br'), 'Half-finished downloads wait here so they can resume. Finished packs are deleted once installed.'))),
      h('div', { class: 'opt' },
        h('div', { class: 'grow' }, h('div', {}, 'Mod list'), h('div', { class: 'help' }, 'Fetched from GitHub when the app starts.')),
        h('button', { class: 'btn ghost', onclick: reload }, 'Refresh'))),
  );
}

// --- actions -----------------------------------------------------------------

function openDetail(id) { openId = id; view = 'detail'; cfg = null; renderDrawer(); }
function closeDrawer() {
  openId = null; view = 'detail'; cfg = null;
  $('#detail').hidden = true; $('#scrim').hidden = true;
}

async function refresh() { S = (await act(() => window.tmm.state())) || S; render(); }
async function reload() { S = (await act(() => window.tmm.reloadCatalog())) || S; render(); toast('Mod list refreshed'); }
async function pickGame() { S = (await act(() => window.tmm.pickGame())) || S; render(); }

async function install(ids, kind) {
  const p = await act(() => window.tmm.plan(ids, { reinstall: kind === 'repair' }));
  if (!p) return;
  const todo = p.steps.filter((s) => s.action !== 'current');
  if (!todo.length) return toast('Already up to date');
  const extra = todo.filter((s) => !ids.includes(s.id));
  const total = todo.reduce((n, s) => n + s.size, 0);
  // Ask only when something beyond the click will happen, or the download is big.
  if (extra.length || p.bepinex || total > 500e6) {
    const ok = await ask({
      title: kind === 'update' ? 'Update?' : 'Install?',
      body: h('div', {},
        h('ul', {}, todo.map((s) => h('li', {}, `${s.name} v${s.version} — ${size(s.size)}`)), p.bepinex && h('li', {}, 'BepInEx (the mod loader) — 1 MB')),
        extra.length && h('p', {}, `${extra.map((s) => s.name).join(', ')} ${extra.length === 1 ? 'is' : 'are'} needed and will be ${extra.some((s) => s.action === 'update') ? 'updated' : 'installed'} too.`),
        h('p', {}, `Total download: ${size(total)}.`)),
      ok: kind === 'update' ? 'Update' : 'Install',
    });
    if (!ok) return;
  }
  working = true;
  showProgress('Starting…', null);
  render();
  const next = await act(() => window.tmm.install(ids, { reinstall: kind === 'repair' }));
  working = false;
  hideProgress();
  if (next) {
    S = next;
    toast(kind === 'update' ? 'Updated' : kind === 'repair' ? 'Repaired' : `Installed ${todo.map((s) => s.name).join(', ')}`);
  } else await refresh();
  render();
}

async function remove(e) {
  const ok = await ask({
    title: `Remove ${e.name}?`,
    body: h('p', {}, 'Its files are deleted from the game folder. Settings you changed are kept, so they come back if you reinstall.'),
    ok: 'Remove', danger: true,
  });
  if (!ok) return;
  working = true; render();
  const r = await act(() => window.tmm.uninstall(e.id));
  working = false;
  if (r) {
    S = r.state;
    const kept = r.notes.filter((n) => /kept/i.test(n));
    toast(kept.length ? `Removed ${e.name}. Kept ${kept.length} file${kept.length === 1 ? '' : 's'} you changed.` : `Removed ${e.name}`);
  }
  render();
}

async function play() {
  const how = await act(() => window.tmm.launch());
  if (!how) return;
  toast(how === 'steam' ? 'Starting through Steam…' : 'Starting Tricky Madness…');
  // The game takes a few seconds to appear; pick up "running" once it has.
  setTimeout(refresh, 6000);
}

// --- progress ----------------------------------------------------------------

function showProgress(label, frac, text = '') {
  $('#progress').hidden = false;
  $('#plabel').textContent = label;
  $('#pnum').textContent = text;
  const fill = $('#pfill');
  fill.classList.toggle('indet', frac == null);
  fill.style.width = frac == null ? '' : `${Math.round(frac * 100)}%`;
}
function hideProgress() { $('#progress').hidden = true; }

window.tmm.onEvent((ev) => {
  if (ev.type === 'appUpdate') return refresh();
  if (!working) return; // only show progress for an install this window started
  if (ev.type === 'step') showProgress(ev.label.startsWith('Installing') ? `${ev.label}…` : `Downloading ${ev.label}…`, null);
  if (ev.type === 'progress') showProgress(`Downloading ${ev.label}…`, ev.done / ev.total, `${size(ev.done)} of ${size(ev.total)}`);
});

// --- wire-up -----------------------------------------------------------------

$('#tabs').addEventListener('click', (ev) => {
  const b = ev.target.closest('button[data-tab]');
  if (!b) return;
  tab = b.dataset.tab;
  document.querySelectorAll('#tabs button').forEach((x) => x.classList.toggle('on', x === b));
  renderGrid();
});
$('#scrim').addEventListener('click', () => (view === 'config' ? leaveConfig(null) : closeDrawer()));
$('#open-settings').addEventListener('click', () => { openId = null; view = 'settings'; renderDrawer(); });
$('#play').addEventListener('click', play);
$('#gamepath').addEventListener('click', () => act(() => window.tmm.showFolder()));
document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && !$('#modal').open && !$('#detail').hidden) $('#scrim').click(); });
// Notice the game starting/stopping while the window is open.
window.addEventListener('focus', () => { if (!working) refresh(); });

refresh();
