import 'dotenv/config';
import { app, BrowserWindow, shell } from 'electron';
import path from 'node:path';
import { registerIpcHandlers } from './ipc';

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;

function createWindow() {
  const win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#08080c',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.once('ready-to-show', () => win.show());

  win.webContents.setWindowOpenHandler(({ url }) => {
    // Restrict shell.openExternal to safe URL schemes. Allowing arbitrary
    // schemes (file:, javascript:, custom OS handlers, etc.) would let any
    // renderer-side string become a local command-execution vector via the
    // OS's protocol registration.
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      console.warn('[main] blocked window.open for malformed URL:', url);
      return { action: 'deny' };
    }
    const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);
    if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
      console.warn('[main] blocked window.open for non-http(s) scheme:', url);
      return { action: 'deny' };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });

  if (isDev) {
    win.loadURL('http://localhost:5173');
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    win.loadFile(path.join(__dirname, '../dist/index.html'));
  }
}

app.whenReady().then(() => {
  registerIpcHandlers();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
