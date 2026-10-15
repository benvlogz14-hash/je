'use strict';
/**
 * Euclidean desktop shell (Electron). Starts the engine in-process, opens the
 * window, and lives in the tray so automation keeps running with the window
 * closed. Lite mode swaps the full window for a small one (or none) to free
 * memory for Premiere and Astra.
 */
const { app, BrowserWindow, Tray, Menu, nativeImage, shell, dialog, safeStorage, Notification, ipcMain, nativeTheme, powerSaveBlocker } = require('electron');
const path = require('path');
const fs = require('fs');

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

const ICON = path.join(__dirname, '..', 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png');
const TRAY_ICON = path.join(__dirname, '..', 'build', 'tray.png');
let win = null; let tray = null; let engine = null; let base = ''; let token = ''; let quitting = false; let blocker = null;

function windowState() {
  try { return JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'window.json'), 'utf8')); } catch { return { width: 1440, height: 900 }; }
}
function saveWindowState() {
  if (!win || win.isDestroyed() || win.isMinimized() || win.isMaximized() || win.__lite) return;
  try { fs.writeFileSync(path.join(app.getPath('userData'), 'window.json'), JSON.stringify(win.getBounds())); } catch { /* ignore */ }
}

function createWindow({ lite = false } = {}) {
  if (win && !win.isDestroyed()) { if (!!win.__lite === lite) { win.show(); win.focus(); return win; } win.__replacing = true; win.destroy(); }
  const st = windowState();
  const isWin = process.platform === 'win32';
  win = new BrowserWindow({
    ...(lite ? { width: 380, height: 560, resizable: true, minWidth: 340, minHeight: 420, alwaysOnTop: false } : { width: st.width || 1440, height: st.height || 900, x: st.x, y: st.y, minWidth: 980, minHeight: 640 }),
    title: 'Euclidean', icon: ICON, show: false, autoHideMenuBar: true, backgroundColor: nativeTheme.shouldUseDarkColors ? '#15181b' : '#f4f5f7',
    titleBarStyle: isWin ? 'hidden' : 'hiddenInset',
    titleBarOverlay: isWin ? { color: nativeTheme.shouldUseDarkColors ? '#1c2024' : '#ffffff', symbolColor: nativeTheme.shouldUseDarkColors ? '#e9ecef' : '#1c2024', height: 41 } : undefined,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: false, backgroundThrottling: true, spellcheck: true },
  });
  win.__lite = lite;
  win.loadURL(`${base}/${lite ? '#/lite' : '#/messages'}`);
  win.once('ready-to-show', () => win.show());
  win.on('resize', saveWindowState); win.on('move', saveWindowState);
  win.on('close', (e) => {
    if (quitting || win.__replacing) return;
    // Closing the window keeps the engine running in the tray.
    e.preventDefault(); win.hide();
    if (!app.__toldTray && Notification.isSupported()) { app.__toldTray = true; new Notification({ title: 'Euclidean is still running', body: 'Automation continues in the background. Open it from the tray icon.' }).show(); }
  });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(base)) { e.preventDefault(); if (/^https?:\/\//.test(url)) shell.openExternal(url); } });
  return win;
}

function trayMenu() {
  const ctx = engine?.ctx; const mode = ctx?.setting('resources.mode', 'full');
  const paused = require('../server/jobs/queue').paused;
  return Menu.buildFromTemplate([
    { label: 'Open Euclidean', click: () => createWindow({ lite: false }) },
    { label: 'Open Lite window', click: () => setMode('lite') },
    { type: 'separator' },
    { label: 'Full mode', type: 'radio', checked: mode === 'full', click: () => setMode('full') },
    { label: 'Lite mode (vital functions only)', type: 'radio', checked: mode === 'lite', click: () => setMode('lite') },
    { label: 'Background (no window)', type: 'radio', checked: mode === 'background', click: () => setMode('background') },
    { type: 'separator' },
    paused ? { label: 'Resume automation', click: () => { require('../server/jobs/queue').setPaused(false); ctx.store.setSettings({ _paused: false }); refreshTray(); } }
      : { label: 'Emergency stop', click: () => { require('../server/jobs/queue').setPaused(true); ctx.store.setSettings({ _paused: true }); require('../server/core/audit').log('ryan', 'automation.paused', { via: 'tray' }, 'warn'); refreshTray(); } },
    { label: 'Open data folder', click: () => shell.openPath(ctx.store ? require('../server/core/paths').root : app.getPath('userData')) },
    { type: 'separator' },
    { label: 'Quit Euclidean', click: () => { quitting = true; app.quit(); } },
  ]);
}
function refreshTray() { if (tray) { tray.setContextMenu(trayMenu()); const q = require('../server/jobs/queue').stats(); tray.setToolTip(`Euclidean · ${q.paused ? 'paused' : `${q.running} running, ${q.queued} queued`}`); } }

function setMode(mode) {
  const resources = require('../server/automation/resources');
  if (engine.ctx.setting('resources.mode') !== mode) resources.setMode(mode, 'tray');
  applyMode(mode);
}
function applyMode(mode) {
  if (mode === 'lite') createWindow({ lite: true });
  else if (mode === 'background') { if (win && !win.isDestroyed()) { win.__replacing = true; win.destroy(); win = null; } }
  else createWindow({ lite: false });
  // Keep the computer from sleeping while renders are queued in full mode.
  if (mode === 'full' && blocker == null) blocker = powerSaveBlocker.start('prevent-app-suspension');
  if (mode !== 'full' && blocker != null) { powerSaveBlocker.stop(blocker); blocker = null; }
  refreshTray();
}

app.whenReady().then(async () => {
  app.setAppUserModelId('media.euclidean.app');
  const dataDir = process.env.EUCLIDEAN_DATA || path.join(app.getPath('userData'), 'data');
  const sealer = safeStorage.isEncryptionAvailable() ? { encrypt: (b) => safeStorage.encryptString(b.toString('base64')), decrypt: (b) => Buffer.from(safeStorage.decryptString(b), 'base64') } : null;
  try {
    engine = require('../server/index');
    const r = await engine.start({
      dataDir, sealer, electron: true,
      hooks: {
        openExternal: (u) => shell.openExternal(u),
        openPath: (p) => shell.openPath(p),
        revealFile: (p) => shell.showItemInFolder(p),
        relaunch: () => { quitting = true; app.relaunch(); app.quit(); },
        pickFolder: async (o = {}) => { const res = await dialog.showOpenDialog(win || undefined, { title: o.title || 'Choose a folder', defaultPath: o.defaultPath, properties: ['openDirectory', 'createDirectory'] }); return res.canceled ? null : res.filePaths[0]; },
        pickFiles: async (o = {}) => { const res = await dialog.showOpenDialog(win || undefined, { properties: ['openFile', ...(o.multi !== false ? ['multiSelections'] : [])], filters: o.filters }); return res.canceled ? [] : res.filePaths; },
        uiMemoryMb: () => { try { return Math.round(app.getAppMetrics().filter((m) => m.type !== 'Browser').reduce((t, m) => t + (m.memory?.workingSetSize || 0), 0) / 1024); } catch { return null; } },
      },
    });
    base = `http://127.0.0.1:${r.port}`; token = r.ownerToken;
  } catch (e) {
    dialog.showErrorBox('Euclidean could not start', `${e.message}\n\nIf another copy is running, close it first. If port 4870 is taken, change server.port in the settings file.`);
    app.exit(1); return;
  }
  ipcMain.on('eu:token', (e) => { e.returnValue = token; });
  ipcMain.on('eu:lite', (e, on) => applyMode(on ? 'lite' : 'full'));
  ipcMain.on('eu:tray', () => applyMode('background'));
  ipcMain.on('eu:theme', (e, t) => { nativeTheme.themeSource = t === 'system' ? 'system' : t; });
  ipcMain.on('eu:notify', (e, { title, body }) => { if (Notification.isSupported()) { const n = new Notification({ title, body, icon: ICON }); n.on('click', () => createWindow({ lite: false })); n.show(); } });

  tray = new Tray(nativeImage.createFromPath(TRAY_ICON));
  tray.on('click', () => createWindow({ lite: engine.ctx.setting('resources.mode') === 'lite' }));
  refreshTray(); setInterval(refreshTray, 15000);
  require('../server/core/events').bus.on('mode', (m) => applyMode(m.mode));

  const startMode = engine.ctx.setting('resources.mode', 'full');
  applyMode(startMode === 'background' && !process.argv.includes('--hidden') ? 'full' : startMode);
  if (process.argv.includes('--hidden')) { if (win) win.hide(); }
  app.setLoginItemSettings({ openAtLogin: engine.ctx.setting('app.openAtLogin', false), args: ['--hidden'] });
});

app.on('second-instance', () => createWindow({ lite: false }));
app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', () => { /* stay alive in the tray */ });
app.on('will-quit', async (e) => { if (engine && !app.__stopped) { e.preventDefault(); app.__stopped = true; await engine.stop(); app.quit(); } });
