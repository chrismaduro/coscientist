/* Web bridge — provides window.cs over HTTP + Server-Sent Events when the app
 * runs in a browser (served by server.js). If window.cs already exists (e.g. an
 * Electron preload set it), this does nothing, so one index.html works in both. */
(function () {
  if (window.cs) return; // already provided by an Electron preload

  const post = (url, body) =>
    fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) })
      .then(r => r.json())
      .catch(err => ({ ok: false, error: String(err) }));

  const get = (url) => fetch(url).then(r => r.json()).catch(() => null);

  // SSE event dispatch
  const handlers = {};
  const on = (type) => (cb) => { (handlers[type] = handlers[type] || []).push(cb); };
  function connect() {
    const es = new EventSource('/api/events');
    es.onmessage = (e) => {
      try {
        const { type, data } = JSON.parse(e.data);
        (handlers[type] || []).forEach(cb => { try { cb(data); } catch (err) { console.error(err); } });
      } catch {}
    };
    es.onerror = () => { /* EventSource auto-reconnects */ };
  }
  connect();

  window.cs = {
    // request/response
    startRun:        (config) => post('/api/start-run', config),
    resumeRun:       (opts)   => post('/api/resume-run', opts),
    stopRun:         ()       => post('/api/stop-run'),
    getState:        ()       => get('/api/state'),
    exportReport:    ()       => post('/api/export-report'),
    resetState:      ()       => post('/api/reset-state'),
    getProviderInfo: ()       => get('/api/provider-info'),
    setModel:        (model)  => post('/api/set-model', { model }),
    getApiKeys:      ()       => get('/api/api-keys'),
    saveApiKey:      (data)   => post('/api/save-api-key', data),
    guideChat:       (msg)    => post('/api/guide-chat', { message: msg }),
    guideReset:      ()       => post('/api/guide-reset'),
    testApi:         ()       => post('/api/test-api'),
    loadExample:     ()       => get('/api/load-example'),
    saveIntake:      (data)   => post('/api/save-intake', data),
    loadIntake:      ()       => post('/api/load-intake'),

    // event subscriptions
    onChunk:            on('agent-chunk'),
    onAgentDone:        on('agent-done'),
    onStateUpdate:      on('state-update'),
    onRunComplete:      on('run-complete'),
    onRunError:         on('run-error'),
    onAppLog:           on('app-log'),
    onGuideChunk:       on('guide-chunk'),
    onGuideIntakeReady: on('guide-intake-ready'),

    removeAllListeners: (type) => {
      // map IPC channel names to SSE types where they differ
      const map = { 'guide-chunk': 'guide-chunk', 'agent-chunk': 'agent-chunk' };
      const key = map[type] || type;
      handlers[key] = [];
    },
  };
})();
