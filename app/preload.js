'use strict';
// Exposes a minimal, explicit bridge to the renderer. No Node APIs leak into the page.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('euclidean', {
  token: ipcRenderer.sendSync('eu:token'),
  platform: process.platform,
  pickFiles: true,
  setLite: (on) => ipcRenderer.send('eu:lite', !!on),
  toTray: () => ipcRenderer.send('eu:tray'),
  setTheme: (t) => ipcRenderer.send('eu:theme', t),
  notify: (title, body) => ipcRenderer.send('eu:notify', { title, body }),
  // Real path of a file dragged in from the desktop, so large videos are used in place instead of copied.
  pathForFile: (file) => { try { return webUtils.getPathForFile(file) || ''; } catch { return ''; } },
});
