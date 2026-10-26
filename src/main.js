'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');

const { Scanner } = require('./scanner');

const APP_ID = 'netspot-clone';
const screenshotArg = process.argv.find((a) => a.startsWith('--screenshot='));
const screenshotPath = screenshotArg ? screenshotArg.split('=').slice(1).join('=') : null;
const screenshotViewArg = process.argv.find((a) => a.startsWith('--screenshot-view='));
const startupView = screenshotViewArg ? screenshotViewArg.split('=')[1] : null;

let mainWindow = null;
let scanner = null;
let settings = null;
let quitting = false;

function settingsFile() {
  return path.join(app.getPath('userData'), 'settings.json');
}

const DEFAULT_SETTINGS = {
  theme: 'dark',
  intervalSeconds: 5,
  units: 'm',
  language: 'pt-BR',
  goodRssi: -67,
  fairRssi: -75,
  autoStart: true,
  showHidden: true,
  lastMode: 'inspector',
};

function loadSettings() {
  try {
    const raw = fs.readFileSync(settingsFile(), 'utf8');
    const stored = JSON.parse(raw);
    // Compatibilidade com versões antigas que guardavam a opção de demonstração.
    delete stored.demo;
    return { ...DEFAULT_SETTINGS, ...stored };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

async function saveSettings(patch) {
  settings = { ...settings, ...patch };
  try {
    await fsp.mkdir(path.dirname(settingsFile()), { recursive: true });
    await fsp.writeFile(settingsFile(), JSON.stringify(settings, null, 2), 'utf8');
  } catch (err) {
    console.error('Falha ao salvar configurações:', err);
  }
  return settings;
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function createScanner() {
  scanner = new Scanner({ settings });
  scanner.on('snapshot', (snapshot) => send('scan:snapshot', snapshot));
  scanner.on('status', (status) => send('scan:status', status));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 680,
    backgroundColor: '#0d1117',
    title: 'NetSpot Clone — Analisador Wi-Fi',
    show: false,
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  Menu.setApplicationMenu(null);
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i')) {
      mainWindow.webContents.toggleDevTools();
      event.preventDefault();
    }
    if (input.control && input.key.toLowerCase() === 'r') {
      mainWindow.webContents.reload();
      event.preventDefault();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  if (screenshotPath) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          if (startupView) {
            await mainWindow.webContents.executeJavaScript(
              `window.__setView && window.__setView(${JSON.stringify(startupView)})`
            );
          }
          await new Promise((r) => setTimeout(r, 1800));
          const image = await mainWindow.webContents.capturePage();
          await fsp.writeFile(screenshotPath, image.toPNG());
          console.log('Screenshot salvo em ' + screenshotPath);
        } catch (err) {
          console.error('Falha no screenshot:', err);
        } finally {
          quitting = true;
          app.quit();
        }
      }, 2200);
    });
  }
}

function initIpc() {
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    startupView,
    userData: app.getPath('userData'),
  }));

  ipcMain.handle('settings:get', () => settings);
  ipcMain.handle('settings:set', async (_e, patch) => {
    const next = await saveSettings(patch || {});
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'intervalSeconds')) {
      scanner.start({ intervalSeconds: next.intervalSeconds });
    }
    return next;
  });

  ipcMain.handle('scan:start', (_e, opts = {}) => {
    scanner.start({ intervalSeconds: opts.intervalSeconds || settings.intervalSeconds });
    return scanner.getState();
  });

  ipcMain.handle('scan:stop', () => {
    scanner.stop();
    return scanner.getState();
  });

  ipcMain.handle('scan:refresh', async () => {
    try {
      return await scanner.scanNow({ manual: true });
    } catch (err) {
      return { error: String(err.message || err) };
    }
  });

  ipcMain.handle('scan:state', () => scanner.getState());

  ipcMain.handle('dialog:open-map', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: 'Selecionar planta baixa',
      properties: ['openFile'],
      filters: [{ name: 'Imagens', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'] }],
    });
    if (canceled || !filePaths.length) return null;
    const filePath = filePaths[0];
    const data = await fsp.readFile(filePath);
    const ext = path.extname(filePath).slice(1).toLowerCase();
    const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
    return {
      name: path.basename(filePath),
      dataUrl: `data:${mime};base64,${data.toString('base64')}`,
    };
  });

  ipcMain.handle('dialog:save-project', async (_e, { json, suggestedName }) => {
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: 'Salvar projeto',
      defaultPath: suggestedName || 'projeto.nspc',
      filters: [{ name: 'Projeto NetSpot Clone', extensions: ['nspc'] }, { name: 'JSON', extensions: ['json'] }],
    });
    if (canceled || !filePath) return null;
    await fsp.writeFile(filePath, json, 'utf8');
    return { path: filePath };
  });

  ipcMain.handle('dialog:open-project', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: 'Abrir projeto',
      properties: ['openFile'],
      filters: [{ name: 'Projeto NetSpot Clone', extensions: ['nspc', 'json'] }],
    });
    if (canceled || !filePaths.length) return null;
    const text = await fsp.readFile(filePaths[0], 'utf8');
    return { path: filePaths[0], json: text };
  });

  ipcMain.handle('file:save-dataurl', async (_e, { dataUrl, suggestedName, filters }) => {
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: 'Exportar',
      defaultPath: suggestedName || 'export.png',
      filters: filters || [{ name: 'PNG', extensions: ['png'] }],
    });
    if (canceled || !filePath) return null;
    const base64 = String(dataUrl).replace(/^data:[^;]+;base64,/, '');
    await fsp.writeFile(filePath, Buffer.from(base64, 'base64'));
    return { path: filePath };
  });

  ipcMain.handle('file:save-text', async (_e, { text, suggestedName, filters }) => {
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: 'Exportar',
      defaultPath: suggestedName || 'export.csv',
      filters: filters || [{ name: 'CSV', extensions: ['csv'] }],
    });
    if (canceled || !filePath) return null;
    await fsp.writeFile(filePath, text, 'utf8');
    return { path: filePath };
  });

  ipcMain.handle('report:pdf', async (_e, { html, suggestedName }) => {
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: 'Salvar relatório PDF',
      defaultPath: suggestedName || 'relatorio-netspot.pdf',
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (canceled || !filePath) return null;

    const tmpFile = path.join(app.getPath('temp'), `netspot-report-${crypto.randomBytes(6).toString('hex')}.html`);
    await fsp.writeFile(tmpFile, html, 'utf8');
    const reportWindow = new BrowserWindow({
      show: false,
      webPreferences: { offscreen: true, javascript: false, sandbox: true },
    });
    try {
      await reportWindow.loadFile(tmpFile);
      await new Promise((r) => setTimeout(r, 600));
      const pdf = await reportWindow.webContents.printToPDF({
        printBackground: true,
        pageSize: 'A4',
        margins: { top: 0.5, bottom: 0.5, left: 0.5, right: 0.5 },
      });
      await fsp.writeFile(filePath, pdf);
      return { path: filePath };
    } finally {
      if (!reportWindow.isDestroyed()) reportWindow.destroy();
      fsp.unlink(tmpFile).catch(() => {});
    }
  });

  ipcMain.handle('app:open-external', (_e, url) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) shell.openExternal(url);
  });

  ipcMain.handle('app:show-item', (_e, p) => {
    if (typeof p === 'string') shell.showItemInFolder(p);
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    app.setAppUserModelId(APP_ID);
    settings = loadSettings();
    createScanner();
    initIpc();
    createWindow();

    if (!screenshotPath && settings.autoStart || screenshotPath) {
      scanner.start({ intervalSeconds: settings.intervalSeconds });
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    quitting = true;
    if (scanner) scanner.dispose();
  });
}
