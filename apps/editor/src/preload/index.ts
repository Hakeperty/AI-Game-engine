/**
 * Sandboxed preload. Exposes only a MessagePort handshake to the host and a few dialogs as `window.aige`.
 * No Node APIs and no secrets reach the renderer.
 */
import { contextBridge, ipcRenderer } from 'electron';
import { type AigeBridge, type ApiKeyStatus, HOST_PORT_MESSAGE } from '../shared/protocol.ts';

// Forward host ports from main into the page's main world (MessagePorts cannot cross contextBridge).
ipcRenderer.on('host:port', (event) => {
  window.postMessage(
    HOST_PORT_MESSAGE,
    window.location.origin === 'null' ? '*' : window.location.origin,
    event.ports,
  );
});

const bridge: AigeBridge = {
  connectHost: () => ipcRenderer.send('host:connect'),
  openFolderDialog: (title?: string) =>
    ipcRenderer.invoke('dialog:openFolder', title) as Promise<string | null>,
  setApiKey: (provider, key) => ipcRenderer.invoke('secrets:set', provider, key) as Promise<ApiKeyStatus>,
  clearApiKey: (provider) => ipcRenderer.invoke('secrets:clear', provider) as Promise<ApiKeyStatus>,
  apiKeyStatus: () => ipcRenderer.invoke('secrets:status') as Promise<ApiKeyStatus>,
  revealInFolder: (path: string) => ipcRenderer.send('shell:reveal', path),
  toggleDevTools: () => ipcRenderer.send('devtools:toggle'),
  platform: process.platform,
  isDev: window.location.protocol === 'http:',
};

contextBridge.exposeInMainWorld('aige', bridge);
