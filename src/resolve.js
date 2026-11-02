import { findEntry, pickBuild } from './catalog.js';
import { satisfies, cmpVersion } from './util.js';

// Ordered work list for installing `ids`: missing or too-old requirements first.
// Each step: { entry, build, action: 'install'|'update'|'current', reinstall }.
export function plan(catalog, ledger, ids, platform, { reinstall = false } = {}) {
  const steps = [];
  const seen = new Set();
  const visit = (id, chain) => {
    if (chain.includes(id)) throw new Error(`dependency loop: ${[...chain, id].join(' -> ')}`);
    if (seen.has(id)) return;
    const entry = findEntry(catalog, id);
    for (const [dep, range] of Object.entries(entry.requires || {})) {
      const have = ledger.entries[dep];
      if (have && satisfies(have.version, range)) continue;
      const depEntry = findEntry(catalog, dep);
      if (!satisfies(depEntry.version, range)) {
        throw new Error(`${entry.name} needs ${depEntry.name} ${range}, but the catalog only has ${depEntry.version}`);
      }
      visit(dep, [...chain, id]);
    }
    seen.add(id);
    const build = pickBuild(entry, platform);
    const have = ledger.entries[id];
    const action = !have ? 'install'
      : (cmpVersion(entry.version, have.version) !== 0 || reinstall) ? 'update' : 'current';
    steps.push({ entry, build, action, reinstall });
  };
  for (const id of ids) visit(id, []);
  return steps;
}

// Installed entries that would break if `id` went away.
export function dependents(catalog, ledger, id) {
  return Object.keys(ledger.entries).filter((other) => {
    const e = catalog.entries.find((x) => x.id === other);
    return e && e.requires && id in e.requires;
  });
}

// Installed entries the catalog has a different version of.
export function outdated(catalog, ledger) {
  return Object.entries(ledger.entries).flatMap(([id, have]) => {
    const e = catalog.entries.find((x) => x.id === id);
    return e && cmpVersion(e.version, have.version) !== 0 ? [id] : [];
  });
}
