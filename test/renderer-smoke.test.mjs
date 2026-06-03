import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const rendererDir = path.join(here, '..', 'electron', 'renderer');

// A chainable, tolerant fake DOM element: any property access returns the
// element (so method calls and child lookups never blow up), and the common
// value-like props return benign defaults. This lets renderer scripts run their
// load-time code so we can catch ReferenceErrors / TDZ violations.
function makeEl() {
  const benign = {
    classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } },
    style: new Proxy({}, { get: () => '', set: () => true }),
    dataset: new Proxy({}, { get: () => '', set: () => true }),
    options: [],
    value: '', textContent: '', innerHTML: '', placeholder: '', type: 'text',
    className: '', checked: false, scrollTop: 0, scrollHeight: 0,
    parentNode: null, nextSibling: null, firstChild: null,
  };
  const handler = {
    get(_t, prop) {
      if (prop in benign) return benign[prop];
      if (prop === Symbol.iterator) return [][Symbol.iterator].bind([]);
      return el; // callable + chainable for everything else
    },
    set(_t, prop, val) { benign[prop] = val; return true; },
    apply() { return el; },
  };
  const el = new Proxy(function () {}, handler);
  return el;
}

function makeSandbox() {
  const doc = {
    querySelector: () => makeEl(),
    querySelectorAll: () => [makeEl(), makeEl()],
    getElementById: () => makeEl(),
    createElement: () => makeEl(),
    addEventListener: () => {},
    body: makeEl(),
  };
  const sandbox = {
    document: doc,
    navigator: { userAgent: 'node-test (not Electron)' },
    console,
    setTimeout: () => 0, clearTimeout: () => {},
    setInterval: () => 0, clearInterval: () => {},
    confirm: () => true, alert: () => {},
    addEventListener: () => {}, removeEventListener: () => {},
    fetch: () => Promise.resolve({ json: () => Promise.resolve({}) }),
    EventSource: class { constructor() {} },
    JSON, Math, Date, parseInt, parseFloat, String, Number, Object, Array, Boolean,
    Promise, Set, Map, RegExp, Error, isNaN,
    location: { reload() {}, href: '' },
  };
  sandbox.window = sandbox; // window.X resolves to the same global
  return sandbox;
}

function runScript(file, context) {
  const code = readFileSync(path.join(rendererDir, file), 'utf-8');
  vm.runInContext(code, context, { filename: file });
}

// A benign window.cs so app.js's async init settles cleanly (no real fetch).
// getState returns null so all the null-guards short-circuit.
function stubCs() {
  const ok = () => Promise.resolve({ ok: true });
  const noop = () => {};
  return {
    startRun: ok, resumeRun: ok, stopRun: ok, exportReport: ok, resetState: ok,
    saveApiKey: ok, setModel: ok, guideChat: ok, guideReset: ok, saveIntake: ok, loadIntake: ok,
    testApi: ok,
    getState: () => Promise.resolve(null),
    getProviderInfo: () => Promise.resolve({ provider: null, models: [], currentModel: null }),
    getApiKeys: () => Promise.resolve({ activeProvider: null, googleKey: '', anthropicKey: '' }),
    loadExample: () => Promise.resolve({ ok: true, data: {} }),
    onChunk: noop, onAgentDone: noop, onStateUpdate: noop, onRunComplete: noop,
    onRunError: noop, onAppLog: noop, onGuideChunk: noop, onGuideIntakeReady: noop,
    removeAllListeners: noop,
  };
}

const settle = () => new Promise(r => globalThis.setTimeout(r, 30));

test('web-bridge.js loads without throwing and defines window.cs', () => {
  const ctx = vm.createContext(makeSandbox());
  assert.doesNotThrow(() => runScript('web-bridge.js', ctx));
  assert.equal(typeof ctx.cs, 'object');
  assert.equal(typeof ctx.cs.startRun, 'function');
});

test('app.js loads without throwing (catches TDZ / undefined-ref at load)', async () => {
  const sb = makeSandbox();
  sb.window.cs = stubCs();
  const ctx = vm.createContext(sb);
  assert.doesNotThrow(() => runScript('app.js', ctx),
    'app.js threw during load — likely a use-before-declare or undefined reference');
  await settle(); // let the async init drain so leaks surface inside the test
});

test('showPanel() works for every panel (catches handler-scope bugs)', async () => {
  const sb = makeSandbox();
  sb.window.cs = stubCs();
  const ctx = vm.createContext(sb);
  runScript('app.js', ctx);
  await settle();
  assert.equal(typeof ctx.showPanel, 'function', 'showPanel should be a global');
  for (const panel of ['setup', 'live', 'hypotheses', 'report', 'settings', 'applog']) {
    assert.doesNotThrow(() => ctx.showPanel(panel), `showPanel('${panel}') threw`);
  }
  await settle();
});
