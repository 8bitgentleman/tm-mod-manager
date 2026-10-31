// The window's only door to the engine. Sandboxed preloads must be CommonJS.
const { contextBridge, ipcRenderer } = require('electron');

const call = (name) => async (...args) => {
  const r = await ipcRenderer.invoke(`tmm:${name}`, ...args);
  if (r.error) throw new Error(r.error);
  return r.ok;
};

contextBridge.exposeInMainWorld('tmm', {
  state: call('state'),
  reloadCatalog: call('reloadCatalog'),
  plan: call('plan'),
  install: call('install'),
  uninstall: call('uninstall'),
  launch: call('launch'),
  config: call('config'),
  saveConfig: call('saveConfig'),
  pickGame: call('pickGame'),
  pickZips: call('pickZips'),
  setSetting: call('setSetting'),
  openExternal: call('openExternal'),
  showFolder: call('showFolder'),
  showLog: call('showLog'),
  copyLog: call('copyLog'),
  onEvent: (fn) => ipcRenderer.on('tmm:event', (_e, ev) => fn(ev)),
});
