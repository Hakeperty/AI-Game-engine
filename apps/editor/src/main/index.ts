/**
 * Electron main process: windows, dialogs, safeStorage secrets and the host utility process.
 *
 * Process layout:
 *   main (this file) --utilityProcess.fork--> host (dist/host.mjs: Workspace, local API, agent)
 *   main creates a MessageChannelMain per renderer connection: port1 -> renderer, port2 -> host.
 * The renderer never talks to Node directly; it only speaks the host protocol over its MessagePort.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  app,
  BrowserWindow,
  dialog,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  ipcMain,
  Menu,
  MessageChannelMain,
  nativeTheme,
  protocol,
  type Rectangle,
  safeStorage,
  session,
  shell,
  type UtilityProcess,
  utilityProcess,
  type WebContents,
} from 'electron';
import type { ApiKeyStatus, HostToMain, MainToHost } from '../shared/protocol.ts';

const DEV_URL = process.env.AIGE_DEV_SERVER_URL ?? '';
const isDev = DEV_URL !== '';
const distDir = __dirname;
const rendererDir = join(distDir, 'renderer');
const APP_ORIGIN = 'app://aige';

if (process.env.AIGE_USER_DATA) app.setPath('userData', resolve(process.env.AIGE_USER_DATA));
// Automated tests: keep rendering when the window is covered (Windows occlusion tracking pauses
// requestAnimationFrame for hidden windows, which stalls UI tests and the viewport).
if (process.env.AIGE_NO_OCCLUSION) {
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  app.commandLine.appendSwitch('disable-background-timer-throttling');
  // With the display asleep or the session locked there is no vsync: produce frames anyway.
  app.commandLine.appendSwitch('disable-gpu-vsync');
  app.commandLine.appendSwitch('disable-frame-rate-limit');
}

// ---------------------------------------------------------------------------------------------
// Content Security Policy
// ---------------------------------------------------------------------------------------------
// - 'wasm-unsafe-eval': Rapier physics (Play mode) instantiates WebAssembly.
// - blob: scripts: Play mode loads the host-compiled user scripts as blob: ES modules (no 'unsafe-eval').
// - 'unsafe-inline' styles: Monaco and dockview inject <style> elements.
// - dev only: Vite's React refresh preamble is an inline script and HMR uses a WebSocket.
const CSP = [
  "default-src 'self'",
  `script-src 'self' blob: 'wasm-unsafe-eval'${isDev ? " 'unsafe-inline'" : ''}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  `connect-src 'self' data: blob:${isDev ? ' ws://127.0.0.1:* ws://localhost:* http://127.0.0.1:* http://localhost:*' : ''}`,
  "worker-src 'self' blob:",
  "media-src 'self' data: blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'",
  "frame-ancestors 'none'",
].join('; ');

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true } },
]);

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.map': 'application/json',
};

function registerAppProtocol(): void {
  protocol.handle('app', async (request) => {
    const url = new URL(request.url);
    if (url.host !== 'aige') return new Response('Not found', { status: 404 });
    const pathname = decodeURIComponent(url.pathname);
    const file = resolve(rendererDir, `.${pathname === '/' ? '/index.html' : pathname}`);
    const rel = relative(rendererDir, file);
    if (rel.startsWith('..') || isAbsolute(rel)) return new Response('Forbidden', { status: 403 });
    try {
      const body = await readFile(file);
      const ext = extname(file).toLowerCase();
      const headers: Record<string, string> = {
        'content-type': MIME[ext] ?? 'application/octet-stream',
        'x-content-type-options': 'nosniff',
      };
      if (ext === '.html') headers['content-security-policy'] = CSP;
      return new Response(body, { headers });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

function isAppUrl(url: string): boolean {
  return url.startsWith(`${APP_ORIGIN}/`) || (isDev && url.startsWith(DEV_URL));
}

// ---------------------------------------------------------------------------------------------
// Secrets (API keys): encrypted with safeStorage, only ever sent to the host utility process
// ---------------------------------------------------------------------------------------------

const secretsFile = () => join(app.getPath('userData'), 'secrets.json');

function readSecrets(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(secretsFile(), 'utf8')) as Record<string, string>;
  } catch {
    return {};
  }
}

function decryptSecret(name: string): string | null {
  const enc = readSecrets()[name];
  if (!enc || !safeStorage.isEncryptionAvailable()) return null;
  try {
    return safeStorage.decryptString(Buffer.from(enc, 'base64'));
  } catch {
    return null;
  }
}

function writeSecret(name: string, value: string | null): void {
  const all = readSecrets();
  if (value === null) delete all[name];
  else all[name] = safeStorage.encryptString(value).toString('base64');
  mkdirSync(app.getPath('userData'), { recursive: true });
  writeFileSync(secretsFile(), JSON.stringify(all, null, 2));
}

function apiKeyStatus(): ApiKeyStatus {
  return {
    anthropic: !!readSecrets().anthropic,
    anthropicEnv: !!process.env.ANTHROPIC_API_KEY,
    encryptionAvailable: safeStorage.isEncryptionAvailable(),
  };
}

// ---------------------------------------------------------------------------------------------
// Host utility process
// ---------------------------------------------------------------------------------------------

let host: UtilityProcess | null = null;
let hostReady = false;
let quitting = false;
let currentRoot: string | null = null;
let mainWindow: BrowserWindow | null = null;
const pendingConnects = new Set<WebContents>();

function sendToHost(msg: MainToHost, transfer: Electron.MessagePortMain[] = []): void {
  host?.postMessage(msg, transfer);
}

function sendSecrets(): void {
  sendToHost({
    type: 'secrets',
    anthropicApiKey: decryptSecret('anthropic'),
    openaiApiKey: decryptSecret('openai'),
  });
}

function startHost(): void {
  hostReady = false;
  const child = utilityProcess.fork(join(distDir, 'host.mjs'), [], {
    serviceName: 'AIGE Host',
    stdio: 'pipe',
    env: { ...process.env, AIGE_EDITOR: '1' },
  });
  host = child;
  child.stdout?.on('data', (d: Buffer) => process.stdout.write(`[host] ${d}`));
  child.stderr?.on('data', (d: Buffer) => process.stderr.write(`[host] ${d}`));
  child.on('message', (msg: HostToMain) => {
    if (msg.type === 'ready') {
      hostReady = true;
      for (const wc of pendingConnects) if (!wc.isDestroyed()) connectRenderer(wc);
      pendingConnects.clear();
    } else if (msg.type === 'project') {
      currentRoot = msg.root;
      mainWindow?.setTitle(msg.name ? `${msg.name} - AIGE` : 'AIGE');
    } else if (msg.type === 'fatal') {
      dialog.showErrorBox('AIGE host failed', msg.message);
    }
  });
  child.on('exit', (code) => {
    if (host === child) host = null;
    if (quitting) return;
    console.error(`[main] host exited with code ${code}; restarting`);
    setTimeout(() => {
      if (quitting) return;
      startHost();
      if (mainWindow && !mainWindow.isDestroyed()) pendingConnects.add(mainWindow.webContents);
    }, 500);
  });
  sendSecrets();
}

/** Creates a fresh MessageChannel between a renderer and the host. */
function connectRenderer(wc: WebContents): void {
  if (!host || !hostReady) {
    pendingConnects.add(wc);
    return;
  }
  const { port1, port2 } = new MessageChannelMain();
  sendToHost({ type: 'port' }, [port2]);
  wc.postMessage('host:port', null, [port1]);
}

function trusted(e: IpcMainEvent | IpcMainInvokeEvent): boolean {
  const url = e.senderFrame?.url ?? '';
  return isAppUrl(url);
}

// ---------------------------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------------------------

const windowStateFile = () => join(app.getPath('userData'), 'window-state.json');

function loadBounds(): Partial<Rectangle> & { maximized?: boolean } {
  const env = process.env.AIGE_WINDOW_SIZE?.match(/^(\d+)x(\d+)$/);
  if (env) return { width: Number(env[1]), height: Number(env[2]) };
  try {
    return JSON.parse(readFileSync(windowStateFile(), 'utf8'));
  } catch {
    return { width: 1600, height: 960 };
  }
}

function createWindow(): void {
  const b = loadBounds();
  const win = new BrowserWindow({
    width: b.width ?? 1600,
    height: b.height ?? 960,
    ...(b.x !== undefined && b.y !== undefined ? { x: b.x, y: b.y } : {}),
    minWidth: 900,
    minHeight: 560,
    show: false,
    title: 'AIGE',
    backgroundColor: '#17181b',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#17181b', symbolColor: '#c9ccd3', height: 34 },
    webPreferences: {
      preload: join(distDir, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });
  mainWindow = win;
  if (b.maximized) win.maximize();
  // 'ready-to-show' waits for the first presented frame, which never comes while the display sleeps:
  // fall back to showing the window shortly after the page has loaded.
  const show = () => {
    if (!win.isDestroyed() && !win.isVisible()) win.show();
  };
  win.once('ready-to-show', show);
  win.webContents.once('did-finish-load', () => setTimeout(show, 800));
  win.on('close', () => {
    try {
      const bounds = win.getNormalBounds();
      writeFileSync(windowStateFile(), JSON.stringify({ ...bounds, maximized: win.isMaximized() }));
    } catch {
      // ignore
    }
  });
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const key = input.key.toLowerCase();
    if (input.key === 'F12' || (input.control && input.shift && key === 'i')) {
      win.webContents.toggleDevTools();
      event.preventDefault();
    } else if (isDev && (input.key === 'F5' || (input.control && key === 'r'))) {
      win.webContents.reload();
      event.preventDefault();
    }
  });
  void win.loadURL(isDev ? DEV_URL : `${APP_ORIGIN}/index.html`);
}

// ---------------------------------------------------------------------------------------------
// App lifecycle and security hardening
// ---------------------------------------------------------------------------------------------

if (!process.env.AIGE_ALLOW_MULTIPLE && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

app.on('web-contents-created', (_e, contents) => {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (event, url) => {
    if (!isAppUrl(url)) event.preventDefault();
  });
  contents.on('will-redirect', (event, url) => {
    if (!isAppUrl(url)) event.preventDefault();
  });
  contents.on('will-attach-webview', (event) => event.preventDefault());
});

ipcMain.on('host:connect', (e) => {
  if (trusted(e)) connectRenderer(e.sender);
});
ipcMain.handle('dialog:openFolder', async (e, title: unknown) => {
  if (!trusted(e)) return null;
  const win = BrowserWindow.fromWebContents(e.sender);
  const opts: Electron.OpenDialogOptions = {
    title: typeof title === 'string' ? title : 'Open AIGE project folder',
    properties: ['openDirectory', 'createDirectory'],
  };
  const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
  return res.canceled ? null : (res.filePaths[0] ?? null);
});
ipcMain.handle('secrets:set', (e, provider: unknown, key: unknown) => {
  if (!trusted(e) || provider !== 'anthropic' || typeof key !== 'string') return apiKeyStatus();
  const k = key.trim();
  if (!k || k.length > 400) return apiKeyStatus();
  if (!safeStorage.isEncryptionAvailable())
    throw new Error('Secure storage is not available on this system.');
  writeSecret('anthropic', k);
  sendSecrets();
  return apiKeyStatus();
});
ipcMain.handle('secrets:clear', (e, provider: unknown) => {
  if (trusted(e) && provider === 'anthropic') {
    writeSecret('anthropic', null);
    sendSecrets();
  }
  return apiKeyStatus();
});
ipcMain.handle('secrets:status', (e) => (trusted(e) ? apiKeyStatus() : null));
ipcMain.on('shell:reveal', (e, path: unknown) => {
  if (!trusted(e) || typeof path !== 'string' || !currentRoot) return;
  const full = resolve(currentRoot, path);
  const rel = relative(currentRoot, full);
  if (rel.startsWith('..') || isAbsolute(rel) || !existsSync(full)) return;
  shell.showItemInFolder(full);
});
ipcMain.on('devtools:toggle', (e) => {
  if (trusted(e)) e.sender.toggleDevTools();
});

app.whenReady().then(() => {
  nativeTheme.themeSource = 'dark';
  Menu.setApplicationMenu(null);
  registerAppProtocol();
  const allowed = new Set(['pointerLock', 'fullscreen', 'clipboard-sanitized-write']);
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(allowed.has(permission)));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));
  if (isDev) {
    session.defaultSession.webRequest.onHeadersReceived({ urls: [`${DEV_URL}*`] }, (details, cb) => {
      const headers = { ...details.responseHeaders };
      if (details.resourceType === 'mainFrame') headers['Content-Security-Policy'] = [CSP];
      cb({ responseHeaders: headers });
    });
  }
  startHost();
  createWindow();
});

app.on('window-all-closed', () => app.quit());

app.on('will-quit', (event) => {
  quitting = true;
  const child = host;
  if (!child) return;
  event.preventDefault();
  host = null;
  const done = () => app.exit(0);
  child.once('exit', done);
  sendToHostDirect(child, { type: 'shutdown' });
  setTimeout(() => {
    child.kill();
    done();
  }, 2500);
});

function sendToHostDirect(child: UtilityProcess, msg: MainToHost): void {
  try {
    child.postMessage(msg);
  } catch {
    child.kill();
  }
}

// Remove a stale secrets file written by a failed encryption attempt.
app.on('ready', () => {
  const f = secretsFile();
  if (existsSync(f)) {
    try {
      JSON.parse(readFileSync(f, 'utf8'));
    } catch {
      rmSync(f, { force: true });
    }
  }
});
