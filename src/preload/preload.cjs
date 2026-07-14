// Preload bridge — exposes a narrow, promise-based API to the renderer.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

async function invoke(channel, ...args) {
  const res = await ipcRenderer.invoke(channel, ...args);
  if (!res.ok) throw new Error(res.error);
  return res.data;
}

contextBridge.exposeInMainWorld('api', {
  settings: {
    get: () => invoke('settings:get'),
    set: (patch) => invoke('settings:set', patch),
  },
  docs: {
    list: () => invoke('docs:list'),
    get: (id) => invoke('docs:get', id),
    addFiles: (paths) => invoke('docs:add-files', paths),
    pickFiles: () => invoke('docs:pick-files'),
    updateExtraction: (id, extraction) => invoke('docs:update-extraction', id, extraction),
    setStatus: (id, status) => invoke('docs:set-status', id, status),
    setVendor: (id, vendor) => invoke('docs:set-vendor', id, vendor),
    remove: (id) => invoke('docs:delete', id),
    fileUrl: (id) => invoke('docs:file-url', id),
  },
  extract: { run: (id) => invoke('extract:run', id) },
  email: { checkNow: () => invoke('email:check-now') },
  qb: {
    push: (id) => invoke('qb:push', id),
    connect: () => invoke('qb:connect'),
    connectManual: (args) => invoke('qb:connect-manual', args),
    status: () => invoke('qb:status'),
    vendors: () => invoke('qb:vendors'),
  },
  drive: {
    connect: () => invoke('drive:connect'),
    status: () => invoke('drive:status'),
  },
  app: {
    openPath: (p) => invoke('app:open-path', p),
    versions: () => invoke('app:versions'),
    openLog: () => invoke('logs:open'),
  },
  // File objects from drag-drop don't expose .path in modern Electron — resolve via webUtils.
  pathForFile: (file) => webUtils.getPathForFile(file),
  onDocsChanged: (cb) => ipcRenderer.on('docs:changed', cb),
  onStatus: (cb) => ipcRenderer.on('app:status', (_e, payload) => cb(payload)),
});
