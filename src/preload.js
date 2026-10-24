'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const on = (channel, handler) => {
  const listener = (_event, payload) => handler(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('api', {
  info: () => ipcRenderer.invoke('app:info'),
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch) => ipcRenderer.invoke('settings:set', patch),
  },
  scan: {
    start: (opts) => ipcRenderer.invoke('scan:start', opts),
    stop: () => ipcRenderer.invoke('scan:stop'),
    refresh: () => ipcRenderer.invoke('scan:refresh'),
    state: () => ipcRenderer.invoke('scan:state'),
    onSnapshot: (handler) => on('scan:snapshot', handler),
    onStatus: (handler) => on('scan:status', handler),
  },
  openMap: () => ipcRenderer.invoke('dialog:open-map'),
  openProject: () => ipcRenderer.invoke('dialog:open-project'),
  saveProject: (payload) => ipcRenderer.invoke('dialog:save-project', payload),
  saveDataUrl: (payload) => ipcRenderer.invoke('file:save-dataurl', payload),
  saveText: (payload) => ipcRenderer.invoke('file:save-text', payload),
  saveReport: (payload) => ipcRenderer.invoke('report:pdf', payload),
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
  showItem: (p) => ipcRenderer.invoke('app:show-item', p),
});
