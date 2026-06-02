// CommonJS preload — Electron loads preload scripts as CommonJS by default,
// so this must NOT use ESM `import` (the project's package.json sets
// "type":"module", which would otherwise make .js files ESM and break loading).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cs', {
  // Renderer → Main
  startRun: (config) => ipcRenderer.invoke('start-run', config),
  stopRun: () => ipcRenderer.invoke('stop-run'),
  getState: () => ipcRenderer.invoke('get-state'),
  exportReport: () => ipcRenderer.invoke('export-report'),
  resetState: () => ipcRenderer.invoke('reset-state'),
  getProviderInfo: () => ipcRenderer.invoke('get-provider-info'),
  setModel: (model) => ipcRenderer.invoke('set-model', model),
  getApiKeys: () => ipcRenderer.invoke('get-api-keys'),
  saveApiKey: (data) => ipcRenderer.invoke('save-api-key', data),
  guideChat: (msg) => ipcRenderer.invoke('guide-chat', msg),
  guideReset: () => ipcRenderer.invoke('guide-reset'),
  onGuideChunk: (cb) => ipcRenderer.on('guide-chunk', (_, chunk) => cb(chunk)),
  onGuideIntakeReady: (cb) => ipcRenderer.on('guide-intake-ready', (_, intake) => cb(intake)),
  loadExample: () => ipcRenderer.invoke('load-example'),
  saveIntake: (data) => ipcRenderer.invoke('save-intake', data),
  loadIntake: () => ipcRenderer.invoke('load-intake'),
  resumeRun: (opts) => ipcRenderer.invoke('resume-run', opts),

  // Main → Renderer (event subscriptions)
  onChunk: (cb) => ipcRenderer.on('agent-chunk', (_, data) => cb(data)),
  onStateUpdate: (cb) => ipcRenderer.on('state-update', (_, state) => cb(state)),
  onRunComplete: (cb) => ipcRenderer.on('run-complete', (_, state) => cb(state)),
  onRunError: (cb) => ipcRenderer.on('run-error', (_, err) => cb(err)),
  onAgentDone: (cb) => ipcRenderer.on('agent-done', (_, data) => cb(data)),
  onAppLog: (cb) => ipcRenderer.on('app-log', (_, entry) => cb(entry)),

  // Cleanup
  removeAllListeners: (channel) => ipcRenderer.removeAllListeners(channel),
});
