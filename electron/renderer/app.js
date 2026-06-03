/* LabMate renderer — plain ES module, no framework */
'use strict';

// Surface any uncaught error visibly instead of silently halting the script.
window.addEventListener('error', (e) => {
  let bar = document.getElementById('fatal-error-bar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'fatal-error-bar';
    bar.style.cssText = 'position:fixed;bottom:0;left:0;right:0;z-index:99999;background:#3a1b1b;color:#ef5350;padding:8px 16px;font:12px monospace;border-top:1px solid #ef5350;white-space:pre-wrap;max-height:30vh;overflow:auto;';
    document.body && document.body.appendChild(bar);
  }
  bar.textContent = `⚠ Script error: ${e.message}\n  at ${e.filename}:${e.lineno}:${e.colno}`;
});

// ── Navigation ────────────────────────────────────────────────────────────

const navItems = document.querySelectorAll('.nav-item');
const panels   = document.querySelectorAll('.panel');

// Holders for functions defined inside the init IIFE (so module-scope code can call them)
let _renderLog = null;
let _refreshSettings = null;

function showPanel(id) {
  panels.forEach(p => p.classList.toggle('active', p.id === `panel-${id}`));
  navItems.forEach(n => n.classList.toggle('active', n.dataset.panel === id));
  if (id === 'hypotheses') refreshHypotheses();
  if (id === 'report')     refreshReport();
  if (id === 'applog' && _renderLog) _renderLog();
  if (id === 'settings' && _refreshSettings) _refreshSettings();
}

navItems.forEach(n => n.addEventListener('click', () => showPanel(n.dataset.panel)));

// ── AI Guide ──────────────────────────────────────────────────────────────

let _guidePendingIntake = null;
let _guideStreaming = false;

function guideMsgEl(role, text, streaming = false) {
  const wrap = document.createElement('div');
  wrap.className = `guide-msg ${role}`;
  const avatar = document.createElement('div');
  avatar.className = 'guide-avatar';
  avatar.textContent = role === 'user' ? 'You' : '✦';
  const bubble = document.createElement('div');
  bubble.className = 'guide-bubble' + (streaming ? ' streaming' : '');
  // Strip the ```intake ... ``` block from displayed text
  bubble.textContent = text.replace(/```intake[\s\S]*?```/g, '').trim();
  wrap.appendChild(avatar);
  wrap.appendChild(bubble);
  return { wrap, bubble };
}

function guideScrollBottom() {
  const el = document.getElementById('guide-messages');
  el.scrollTop = el.scrollHeight;
}

async function guideSend(userText) {
  if (_guideStreaming || !userText.trim()) return;
  _guideStreaming = true;

  const msgs = document.getElementById('guide-messages');

  // Add user message
  const { wrap: uWrap } = guideMsgEl('user', userText);
  msgs.appendChild(uWrap);

  // Add assistant placeholder
  const { wrap: aWrap, bubble: aBubble } = guideMsgEl('assistant', '', true);
  msgs.appendChild(aWrap);
  guideScrollBottom();

  document.getElementById('guide-input').value = '';
  document.getElementById('btn-guide-send').disabled = true;

  // Stream chunks into bubble
  let fullText = '';
  window.cs.onGuideChunk(chunk => {
    fullText += chunk;
    aBubble.textContent = fullText.replace(/```intake[\s\S]*?```/g, '').trim();
    aBubble.classList.add('streaming');
    guideScrollBottom();
  });

  const result = await window.cs.guideChat(userText);

  aBubble.classList.remove('streaming');
  window.cs.removeAllListeners('guide-chunk');

  // If the call failed and nothing streamed, show the error in the bubble
  if (result && !result.ok && !fullText) {
    aBubble.classList.add('guide-error');
    const msg = result.error || 'Unknown error';
    if (msg.includes('API key') || msg.includes('GOOGLE_API_KEY') || msg.includes('ANTHROPIC_API_KEY') || msg.includes('credentials')) {
      aBubble.textContent = '⚠ No API key configured. Go to Settings → API Key and paste your Google or Anthropic key, then click Save & Activate.';
    } else {
      aBubble.textContent = `⚠ API error: ${msg}`;
    }
    guideScrollBottom();
  }

  _guideStreaming = false;
  document.getElementById('btn-guide-send').disabled = false;
  document.getElementById('guide-input').focus();
}

// Start button — show input and send a first prompt
document.getElementById('btn-guide-start').addEventListener('click', async () => {
  document.getElementById('guide-messages').innerHTML = '';
  document.getElementById('guide-input-row').style.display = 'flex';
  document.getElementById('guide-apply-bar').style.display = 'none';
  _guidePendingIntake = null;
  await window.cs.guideReset();
  await guideSend("Let's get started. I'd like help defining a research goal.");
});

document.getElementById('btn-guide-send').addEventListener('click', () => {
  guideSend(document.getElementById('guide-input').value);
});

document.getElementById('guide-input').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    guideSend(document.getElementById('guide-input').value);
  }
});

// onGuideIntakeReady registered in init (needs window.cs)

// Apply intake to form
document.getElementById('btn-guide-apply').addEventListener('click', () => {
  if (!_guidePendingIntake) return;
  populateForm(_guidePendingIntake);
  document.getElementById('guide-apply-bar').style.display = 'none';
  showTabsArea('research');
});

// Reset guide
document.getElementById('btn-guide-reset').addEventListener('click', async () => {
  await window.cs.guideReset();
  _guidePendingIntake = null;
  _guideStreaming = false;
  document.getElementById('guide-apply-bar').style.display = 'none';
  document.getElementById('guide-input-row').style.display = 'none';
  document.getElementById('guide-messages').innerHTML = `
    <div class="guide-welcome">
      <div class="guide-welcome-icon">✦</div>
      <h3>Research Goal Guide</h3>
      <p>I'll help you articulate a clear, focused research goal and fill in your intake form. Tell me what you're broadly interested in — a domain, a problem, a population, or even just a vague curiosity — and we'll work from there.</p>
      <button class="btn btn-primary" id="btn-guide-start">Let's start →</button>
    </div>`;
  document.getElementById('btn-guide-start').addEventListener('click', async () => {
    document.getElementById('guide-messages').innerHTML = '';
    document.getElementById('guide-input-row').style.display = 'flex';
    await window.cs.guideReset();
    await guideSend("Let's get started. I'd like help defining a research goal.");
  });
});

// ── Setup tabs ────────────────────────────────────────────────────────────

document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(`tab-${tab.dataset.tab}`).classList.add('active');
  });
});

// ── Welcome screen ────────────────────────────────────────────────────────

function showTabsArea(activeTab = 'research') {
  document.getElementById('setup-welcome').style.display = 'none';
  const area = document.getElementById('setup-tabs-area');
  area.classList.add('visible');
  // Activate the right tab
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === activeTab));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === `tab-${activeTab}`));
}

document.getElementById('card-guide').addEventListener('click', () => showTabsArea('guide'));
document.getElementById('card-load').addEventListener('click', () => {}); // handled by child buttons
document.getElementById('btn-skip-welcome').addEventListener('click', () => showTabsArea('research'));
document.getElementById('btn-back-welcome').addEventListener('click', () => {
  document.getElementById('setup-welcome').style.display = '';
  document.getElementById('setup-tabs-area').classList.remove('visible');
});

// ── Run-mode cards ────────────────────────────────────────────────────────

const MINS_PER_ROUND = 3.5; // rough estimate: gen + reflection + ranking + evolution + meta

function setRunMode(mode) {
  document.getElementById('cfg-run-mode').value = mode;
  document.querySelectorAll('.run-mode-card').forEach(c =>
    c.classList.toggle('selected', c.dataset.mode === mode)
  );
  document.getElementById('run-settings-timed').style.display  = mode === 'timed'  ? '' : 'none';
  document.getElementById('run-settings-rounds').style.display = mode === 'rounds' ? '' : 'none';
  updateRunEstimate();
}

document.querySelectorAll('.run-mode-card').forEach(card => {
  card.addEventListener('click', () => setRunMode(card.dataset.mode));
});

// Init: select timed by default
setRunMode('timed');

// ── Run estimate calculator ───────────────────────────────────────────────

function updateRunEstimate() {
  const mode = document.getElementById('cfg-run-mode').value;

  if (mode === 'timed') {
    const mins = parseFloat(document.getElementById('cfg-duration').value) || 10;
    const estRounds = Math.max(1, Math.floor(mins / MINS_PER_ROUND));
    const lo = Math.max(1, estRounds - 1), hi = estRounds + 1;
    document.getElementById('run-estimate-text').textContent =
      `With ${mins} min, expect roughly ${lo}–${hi} rounds (~${MINS_PER_ROUND} min/round at default settings).`;
  } else {
    const rounds = parseInt(document.getElementById('cfg-rounds').value) || 3;
    const hyp    = parseInt(document.getElementById('cfg-hyp-count').value) || 15;
    const estMins = Math.round(rounds * MINS_PER_ROUND);
    document.getElementById('run-estimate-rounds').textContent =
      `${rounds} round${rounds !== 1 ? 's' : ''} × ${hyp} hypotheses/round ≈ ${estMins} min estimated.`;
  }
}

document.getElementById('cfg-duration').addEventListener('input', updateRunEstimate);
document.getElementById('cfg-rounds')?.addEventListener('input', updateRunEstimate);
document.getElementById('cfg-hyp-count')?.addEventListener('input', updateRunEstimate);

// ── State cache ───────────────────────────────────────────────────────────

let _state       = null;
let _runId       = null;
let _running     = false;
let _stopAt      = null;
let _timerHandle = null;
let _currentAgent = null;

function setRunning(yes) {
  _running = yes;
  document.getElementById('btn-stop').style.display = yes ? '' : 'none';
  document.getElementById('btn-start').disabled = yes;
  document.getElementById('btn-resume').disabled = yes;
  const dot  = document.getElementById('status-dot');
  const text = document.getElementById('status-text');
  dot.className = 'dot' + (yes ? ' running' : (_state?.phase === 'complete' ? ' complete' : ''));
  text.textContent = yes ? 'Running…' : (_state?.phase === 'complete' ? 'Complete' : 'Idle');
}

// ── Config builder ────────────────────────────────────────────────────────

function lines(id) {
  return document.getElementById(id).value.split('\n').map(s => s.trim()).filter(Boolean);
}

function buildConfig() {
  const mode     = document.getElementById('cfg-run-mode').value;
  const duration = parseInt(document.getElementById('cfg-duration').value) || 10;
  const rounds   = parseInt(document.getElementById('cfg-rounds').value) || 3;

  return {
    research_goal: document.getElementById('cfg-goal').value.trim(),
    domain_context: {
      research_anchor:   document.getElementById('cfg-anchor').value.trim(),
      target_population: document.getElementById('cfg-population').value.trim(),
      context_setting:   document.getElementById('cfg-context').value.trim(),
      hard_constraints:  lines('cfg-hard'),
      soft_factors:      lines('cfg-soft'),
      frontier_seed_list: {
        core_fronts:               lines('cfg-fronts'),
        cross_disciplinary_targets: lines('cfg-cross'),
        frontier_phenomena:        lines('cfg-phenomena'),
      },
      literature_hierarchy: {
        primary:          document.getElementById('cfg-lit-primary').value.trim(),
        secondary:        document.getElementById('cfg-lit-secondary').value.trim(),
        tertiary:         document.getElementById('cfg-lit-tertiary').value.trim(),
        treat_with_caution: document.getElementById('cfg-lit-caution').value.trim(),
      },
      output_language: 'English',
      output_format_preference: 'top 10 ranked hypotheses grouped by theme, abstract-style summary',
    },
    config: {
      max_rounds:           rounds,
      hypotheses_per_round: parseInt(document.getElementById('cfg-hyp-count')?.value) || 15,
      n_evolved_per_round:  parseInt(document.getElementById('cfg-evolved')?.value) || 5,
      contender_pool_size:  parseInt(document.getElementById('cfg-contenders')?.value) || 10,
    },
    runMode:    mode,
    durationMs: mode === 'timed' ? duration * 60 * 1000 : null,
  };
}

function validateConfig(cfg) {
  if (!cfg.research_goal) return 'Research goal is required.';
  return null;
}

function showError(msg) {
  const el = document.getElementById('setup-error');
  el.textContent = msg;
  el.classList.toggle('visible', !!msg);
}

// ── Start / Stop ──────────────────────────────────────────────────────────

document.getElementById('btn-start').addEventListener('click', async () => {
  const cfg = buildConfig();
  const err = validateConfig(cfg);
  if (err) {
    showError(err);
    document.querySelector('#panel-setup .setup-panel-body').scrollTop = 0;
    return;
  }
  showError('');

  // Auto-fill anchor from goal if blank
  if (!cfg.domain_context.research_anchor) {
    cfg.domain_context.research_anchor = cfg.research_goal;
  }

  document.getElementById('btn-start').textContent = '⏳ Starting…';
  document.getElementById('btn-start').disabled = true;

  const result = await window.cs.startRun(cfg);

  document.getElementById('btn-start').textContent = '▶ Start New Run';

  if (!result.ok) {
    document.getElementById('btn-start').disabled = false;
    showError(`Failed to start: ${result.error}`);
    showPanel('setup');
    return;
  }

  _runId = result.run_id;
  if (cfg.runMode === 'timed') {
    _stopAt = Date.now() + cfg.durationMs;
    startTimer(cfg.durationMs);
  } else {
    _stopAt = null;
  }

  clearLog();
  setRunning(true);
  showPanel('live');
  document.getElementById('setup-run-id-badge').textContent = _runId;
});

document.getElementById('btn-resume').addEventListener('click', async () => {
  const mode     = document.getElementById('cfg-run-mode').value;
  const duration = parseInt(document.getElementById('cfg-duration').value) || 10;
  const opts = {
    runMode:    mode,
    durationMs: mode === 'timed' ? duration * 60 * 1000 : null,
  };
  const result = await window.cs.resumeRun(opts);
  if (!result.ok) { showError(result.error); return; }

  _runId = result.run_id;
  if (opts.runMode === 'timed') {
    _stopAt = Date.now() + opts.durationMs;
    startTimer(opts.durationMs);
  }

  clearLog();
  setRunning(true);
  showPanel('live');
});

document.getElementById('btn-stop').addEventListener('click', async () => {
  await window.cs.stopRun();
  stopTimer();
});

document.getElementById('btn-reset').addEventListener('click', async () => {
  if (!confirm('Clear all run state? This cannot be undone.')) return;
  await window.cs.resetState();
  _state = null;
  _runId = null;
  setRunning(false);
  updateStats(null);
  clearLog();
  document.getElementById('setup-run-id-badge').textContent = 'No active run';
});

// ── Timer ─────────────────────────────────────────────────────────────────

function startTimer(totalMs) {
  document.getElementById('time-card').style.display = '';
  stopTimer();
  const end = Date.now() + totalMs;
  _timerHandle = setInterval(() => {
    const remaining = Math.max(0, end - Date.now());
    const pct = (remaining / totalMs) * 100;
    const mins = Math.floor(remaining / 60000);
    const secs = Math.floor((remaining % 60000) / 1000);
    document.getElementById('time-value').textContent = `${mins}m ${String(secs).padStart(2, '0')}s`;
    document.getElementById('time-label').textContent = 'Remaining';
    const fill = document.getElementById('time-fill');
    fill.style.width = `${pct}%`;
    fill.className = 'time-fill' + (pct < 10 ? ' urgent' : pct < 25 ? ' warning' : '');
    if (remaining === 0) stopTimer();
  }, 1000);
}

function stopTimer() {
  if (_timerHandle) { clearInterval(_timerHandle); _timerHandle = null; }
}

// ── Agent event handlers ──────────────────────────────────────────────────

const AGENT_COLORS = {
  generation: 'generation',
  proximity:  'proximity',
  reflection: 'reflection',
  ranking:    'ranking',
  evolution:  'evolution',
  'meta-review': 'meta-review',
  supervisor: 'supervisor',
};

if (window.cs) {
  window.cs.onChunk(({ agent, chunk }) => {
    appendLog(agent, chunk);
    if (_currentAgent !== agent) {
      _currentAgent = agent;
      markAgentRunning(agent);
    }
  });

  window.cs.onAgentDone(({ agent, summary }) => {
    markAgentDone(agent, summary);
  });

  window.cs.onStateUpdate((state) => {
    _state = state;
    updateStats(state);
  });

  window.cs.onRunComplete((state) => {
    _state = state;
    updateStats(state);
    setRunning(false);
    stopTimer();
    _currentAgent = null;
    resetAgentStatuses();
    appendLog('supervisor', '\n✓ Run complete.\n');
    document.getElementById('status-dot').className = 'dot complete';
    document.getElementById('status-text').textContent = 'Complete';
    document.getElementById('time-card').style.display = 'none';
    setTimeout(() => showPanel('hypotheses'), 800);
  });

  window.cs.onRunError(({ message }) => {
    setRunning(false);
    stopTimer();
    appendLog('supervisor', `\n⚠ Error: ${message}\n`);
  });
}

// ── Log pane ──────────────────────────────────────────────────────────────

function clearLog() {
  document.getElementById('log-pane').innerHTML = '';
}

let _currentSpan = null;
let _currentSpanAgent = null;

function appendLog(agent, text) {
  const pane = document.getElementById('log-pane');
  // Reuse span if same agent
  if (_currentSpanAgent !== agent || !_currentSpan) {
    _currentSpan = document.createElement('span');
    _currentSpan.className = `log-chunk ${AGENT_COLORS[agent] || ''}`;
    pane.appendChild(_currentSpan);
    _currentSpanAgent = agent;
  }
  _currentSpan.textContent += text;
  pane.scrollTop = pane.scrollHeight;
}

// ── Agent status ──────────────────────────────────────────────────────────

function markAgentRunning(agent) {
  const key = agent.toLowerCase().replace(/\s/g, '-');
  const el = document.getElementById(`ag-${key}`);
  if (!el) return;
  el.textContent = 'running';
  el.className = 'agent-status running';
}

function markAgentDone(agent, summary) {
  const key = agent.toLowerCase().replace(/\s/g, '-');
  const el = document.getElementById(`ag-${key}`);
  if (!el) return;
  el.textContent = summary || 'done';
  el.className = 'agent-status done';
}

function resetAgentStatuses() {
  document.querySelectorAll('.agent-status').forEach(el => {
    el.textContent = '—';
    el.className = 'agent-status';
  });
}

// ── Stats pane ────────────────────────────────────────────────────────────

function updateStats(state) {
  if (!state) return;

  const active   = state.hypotheses.filter(h => h.status === 'active');
  const rejected = state.hypotheses.filter(h => h.status === 'rejected');
  const evolved  = state.hypotheses.filter(h => h.origin === 'evolution');
  const last     = state.convergence?.per_round?.slice(-1)[0];
  const ranking  = state.tournament?.ranking || [];

  setText('st-round', state.round || '—');
  setText('st-phase', state.phase || '—');
  setText('st-total', state.hypotheses.length);
  setText('st-active', active.length);
  setText('st-rejected', rejected.length);
  setText('st-evolved', evolved.length);

  document.getElementById('live-round-badge').textContent =
    `Round ${state.round} / ${state.config?.max_rounds || '?'}`;

  // Phase progress
  const phaseOrder = { idle: 0, generate: 1, debate: 2, evolve: 3, complete: 4 };
  const pct = ((phaseOrder[state.phase] || 0) / 4) * 100;
  document.getElementById('st-progress').style.width = `${pct}%`;

  // Convergence
  if (last) {
    const spearman = last.spearman_vs_prev;
    const churn = last.top5_churn;
    const spread = last.elo_spread;
    const singletons = last.singleton_clusters;
    const totalClusters = last.total_clusters;

    const spEl = document.getElementById('st-spearman');
    spEl.textContent = spearman !== null ? spearman.toFixed(3) : '—';
    spEl.className = 'stat-value' + (spearman > 0.8 ? ' green' : spearman > 0.5 ? ' yellow' : '');

    const chEl = document.getElementById('st-churn');
    chEl.textContent = churn !== null ? churn.toFixed(2) : '—';
    chEl.className = 'stat-value' + (churn < 0.3 ? ' green' : churn > 0.7 ? ' red' : ' yellow');

    setText('st-spread', spread !== undefined ? spread : '—');
    setText('st-singletons', singletons !== undefined ? `${singletons}/${totalClusters}` : '—');

    // Spearman chart
    updateSpearmanChart(state.convergence.per_round);
  }

  // Elo
  if (active.length) {
    const sorted = [...active].sort((a, b) => (b.elo || 1200) - (a.elo || 1200));
    setText('st-best-elo', sorted[0].elo || 1200);
    const top10Avg = sorted.slice(0, 10).reduce((s, h) => s + (h.elo || 1200), 0) / Math.min(10, sorted.length);
    setText('st-avg-elo', Math.round(top10Avg));

    const top3 = ranking.slice(0, 3).map(id => state.hypotheses.find(h => h.id === id)).filter(Boolean);
    document.getElementById('top3-list').innerHTML = top3.map((h, i) =>
      `<div>${['🥇','🥈','🥉'][i]} <span style="color:var(--text)">${h.id}</span> ${escHtml(h.title?.substring(0, 30) || '')} <span style="color:var(--accent2)">${h.elo}</span></div>`
    ).join('');
  }

  // Hypothesis count badge
  document.getElementById('hyp-count-badge').textContent = `${state.hypotheses.length} hypotheses`;
}

function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

// ── Mini Spearman chart ────────────────────────────────────────────────────

function updateSpearmanChart(perRound) {
  const line = document.getElementById('spearman-line');
  const dots = document.getElementById('spearman-dots');
  const values = perRound.map(r => r.spearman_vs_prev).filter(v => v !== null);
  if (values.length === 0) return;

  const W = 260, H = 60;
  const xStep = values.length > 1 ? W / (values.length - 1) : W / 2;

  const points = values.map((v, i) => {
    const x = values.length === 1 ? W / 2 : i * xStep;
    const y = H - (v * H);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  line.setAttribute('points', points.join(' '));

  dots.innerHTML = values.map((v, i) => {
    const x = values.length === 1 ? W / 2 : i * xStep;
    const y = H - (v * H);
    return `<circle class="chart-dot" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3"/>`;
  }).join('');
}

// ── Hypotheses table ──────────────────────────────────────────────────────

let _hypSortCol = 'elo';
let _hypSortDir = -1; // -1 = desc
let _expandedId = null;

async function refreshHypotheses() {
  const state = await window.cs.getState();
  _state = state;
  if (!state) { document.getElementById('hyp-tbody').innerHTML = ''; return; }
  document.getElementById('hyp-count-badge').textContent = `${state.hypotheses.length} hypotheses`;
  renderHypTable(state.hypotheses);
}

document.getElementById('btn-refresh-hyp').addEventListener('click', refreshHypotheses);
document.getElementById('hyp-search').addEventListener('input', () => renderHypTable(_state?.hypotheses || []));
document.getElementById('hyp-filter-status').addEventListener('change', () => renderHypTable(_state?.hypotheses || []));
document.getElementById('hyp-filter-origin').addEventListener('change', () => renderHypTable(_state?.hypotheses || []));

document.querySelectorAll('.hyp-table th[data-sort]').forEach(th => {
  th.addEventListener('click', () => {
    const col = th.dataset.sort;
    if (_hypSortCol === col) _hypSortDir *= -1;
    else { _hypSortCol = col; _hypSortDir = col === 'elo' ? -1 : 1; }
    document.querySelectorAll('.hyp-table th').forEach(t => t.classList.remove('sorted'));
    th.classList.add('sorted');
    th.querySelector('.sort-arrow').textContent = _hypSortDir === 1 ? '↑' : '↓';
    renderHypTable(_state?.hypotheses || []);
  });
});

function renderHypTable(hypotheses) {
  const query  = document.getElementById('hyp-search').value.toLowerCase();
  const status = document.getElementById('hyp-filter-status').value;
  const origin = document.getElementById('hyp-filter-origin').value;

  let filtered = hypotheses.filter(h => {
    if (status && h.status !== status) return false;
    if (origin && h.origin !== origin) return false;
    if (query && !`${h.id} ${h.title} ${h.statement} ${h.front}`.toLowerCase().includes(query)) return false;
    return true;
  });

  filtered.sort((a, b) => {
    let av = a[_hypSortCol], bv = b[_hypSortCol];
    if (_hypSortCol === 'elo') { av = a.elo || 1200; bv = b.elo || 1200; }
    if (typeof av === 'string') return av.localeCompare(bv) * _hypSortDir;
    return ((av || 0) - (bv || 0)) * _hypSortDir;
  });

  document.getElementById('hyp-shown-count').textContent = `${filtered.length} shown`;

  const tbody = document.getElementById('hyp-tbody');
  tbody.innerHTML = '';

  for (const h of filtered) {
    const latest = h.reviews[h.reviews.length - 1];
    const scores = latest?.scores;

    const tr = document.createElement('tr');
    tr.className = 'hyp-row';
    tr.dataset.id = h.id;
    tr.innerHTML = `
      <td class="hyp-id">${h.id}</td>
      <td><div class="hyp-title">${escHtml(h.title || '')}</div><div class="hyp-front">${escHtml(h.front || '')}</div></td>
      <td>${escHtml(h.theme || '')}</td>
      <td><span class="elo-pill">${h.elo || 1200}</span></td>
      <td><span class="status-pill ${h.status}">${h.status}</span></td>
      <td>${renderScoreBars(scores)}</td>
      <td>${h.origin}${h.parent_ids?.length ? ` ↑${h.parent_ids.join(',')}` : ''}</td>
    `;
    tr.addEventListener('click', () => toggleDetail(tr, h));
    tbody.appendChild(tr);

    // If was expanded, re-expand
    if (_expandedId === h.id) {
      const detail = buildDetailRow(h);
      tbody.insertBefore(detail, tr.nextSibling);
    }
  }
}

function toggleDetail(tr, h) {
  const next = tr.nextSibling;
  if (next && next.classList?.contains('hyp-detail')) {
    next.remove();
    _expandedId = null;
    return;
  }
  // Close any open detail
  document.querySelectorAll('.hyp-detail').forEach(el => el.remove());
  _expandedId = h.id;
  const detail = buildDetailRow(h);
  tr.parentNode.insertBefore(detail, tr.nextSibling);
}

function buildDetailRow(h) {
  const latest = h.reviews[h.reviews.length - 1];
  const scores = latest?.scores;
  const tr = document.createElement('tr');
  tr.className = 'hyp-detail';
  const scoreHtml = scores ? `
    <div style="display:flex;gap:16px;margin-top:6px;flex-wrap:wrap">
      ${['alignment','plausibility','novelty','testability'].map(k =>
        `<div><span style="color:var(--muted);font-size:11px">${k}</span> <strong>${scores[k]}/5</strong></div>`
      ).join('')}
      <div><span style="color:var(--muted);font-size:11px">safety</span> <strong>${scores.safety}</strong></div>
    </div>` : '';

  const evolTargets = latest?.evolution_targets?.length
    ? `<dt>Evolution targets</dt><dd>${escHtml(latest.evolution_targets.join('; '))}</dd>`
    : '';

  tr.innerHTML = `<td colspan="7">
    <div class="hyp-detail-box">
      <dl class="dl">
        <dt>Statement</dt><dd>${escHtml(h.statement || '')}</dd>
        <dt>Grounding</dt><dd>${escHtml(h.grounding || '')}</dd>
        <dt>Constructs</dt><dd>${escHtml((h.constructs || []).join(', '))}</dd>
        <dt>Source field</dt><dd>${escHtml(h.source_field || '')}</dd>
        <dt>Novelty signal</dt><dd>${escHtml(h.novelty_signal || '')}</dd>
        <dt>Round created</dt><dd>${h.round_created}</dd>
        <dt>Matches</dt><dd>${h.match_count} (${h.wins}W / ${h.losses}L)</dd>
        ${evolTargets}
        ${latest?.review_summary ? `<dt>Review</dt><dd>${escHtml(latest.review_summary)}</dd>` : ''}
      </dl>
      ${scoreHtml}
    </div>
  </td>`;
  return tr;
}

function renderScoreBars(scores) {
  if (!scores) return '<span style="color:var(--muted);font-size:11px">—</span>';
  return ['alignment','plausibility','novelty','testability'].map(k => {
    const v = scores[k] || 0;
    return `<div class="score-bar-wrap">${[1,2,3,4,5].map(i =>
      `<div class="score-bar ${i <= v ? 'filled' : ''}"></div>`
    ).join('')}</div>`;
  }).join('');
}

// ── Report panel ──────────────────────────────────────────────────────────

async function refreshReport() {
  const state = await window.cs.getState();
  if (!state) return;
  const el = document.getElementById('report-content');

  if (!state.meta_review?.research_overview) {
    el.innerHTML = '<div class="empty">No report yet — complete at least one round.</div>';
    return;
  }

  const active = [...state.hypotheses.filter(h => h.status === 'active')]
    .sort((a, b) => (b.elo || 1200) - (a.elo || 1200));
  const top10 = active.slice(0, 10);

  // Group by theme
  const byTheme = {};
  for (const h of top10) {
    const t = h.theme || 'Uncategorised';
    if (!byTheme[t]) byTheme[t] = [];
    byTheme[t].push(h);
  }

  const convRows = (state.convergence?.per_round || []).map(r =>
    `  Round ${r.round}: ρ=${r.spearman_vs_prev?.toFixed(3) ?? 'N/A'}  churn=${r.top5_churn?.toFixed(2) ?? 'N/A'}  best=${r.best_elo}  spread=${r.elo_spread ?? '—'}  singletons=${r.singleton_clusters ?? '—'}/${r.total_clusters ?? '—'}`
  ).join('\n');

  const themeBlocks = Object.entries(byTheme).map(([theme, hyps]) =>
    `── ${theme} ──\n` + hyps.map(h =>
      `  ${h.id} [${h.elo}]  ${h.title}\n  ${h.statement}\n`
    ).join('\n')
  ).join('\n');

  const critiques = (state.meta_review.recurring_critiques || [])
    .map(c => `  • ${c.theme} (×${c.occurrences})`).join('\n') || '  none';

  const contacts = (state.meta_review.research_contacts || [])
    .map(c => `  • ${c.name} — ${c.relevance}`).join('\n') || '  none';

  el.textContent = `═══════════════════════════════════════════════════
LabMate Report  ·  ${state.run_id}
═══════════════════════════════════════════════════

Research goal: ${state.research_goal}
Rounds completed: ${state.round}
Hypotheses: ${state.hypotheses.length} total · ${active.length} active · ${state.hypotheses.filter(h=>h.status==='rejected').length} rejected

── Convergence ──────────────────────────────────
${convRows || '  (no rounds complete)'}

── Research Overview ────────────────────────────
${state.meta_review.research_overview || '—'}

── Top 10 Hypotheses by Theme ───────────────────
${themeBlocks}

── Recurring Critiques ──────────────────────────
${critiques}

── Generation Feedback (next round) ─────────────
${state.meta_review.feedback_for_generation || '—'}

── Research Contacts ────────────────────────────
${contacts}
`;
}

document.getElementById('btn-refresh-report').addEventListener('click', refreshReport);
document.getElementById('btn-export').addEventListener('click', async () => {
  const r = await window.cs.exportReport();
  if (!r.ok) alert(`Export failed: ${r.error}`);
  else alert(`Exported to output/${_runId || _state?.run_id}/`);
});

// ── Load example / populate form ─────────────────────────────────────────

function populateForm(intake) {
  const dc = intake.domain_context || {};
  const cfg = intake.config || {};
  const fl = dc.frontier_seed_list || {};
  const lit = dc.literature_hierarchy || {};

  setField('cfg-goal',       intake.research_goal || '');
  setField('cfg-anchor',     dc.research_anchor || '');
  setField('cfg-population', dc.target_population || '');
  setField('cfg-context',    dc.context_setting || '');
  setField('cfg-hard',       (dc.hard_constraints || []).join('\n'));
  setField('cfg-soft',       (dc.soft_factors || []).join('\n'));
  setField('cfg-fronts',     (fl.core_fronts || []).join('\n'));
  setField('cfg-cross',      (fl.cross_disciplinary_targets || []).join('\n'));
  setField('cfg-phenomena',  (fl.frontier_phenomena || []).join('\n'));
  setField('cfg-lit-primary',   lit.primary || '');
  setField('cfg-lit-secondary', lit.secondary || '');
  setField('cfg-lit-tertiary',  lit.tertiary || '');
  setField('cfg-lit-caution',   lit.treat_with_caution || '');
  if (cfg.hypotheses_per_round) setField('cfg-hyp-count', cfg.hypotheses_per_round);
  if (cfg.n_evolved_per_round)  setField('cfg-evolved',   cfg.n_evolved_per_round);
  if (cfg.max_rounds) {
    setField('cfg-rounds', cfg.max_rounds);
    setRunMode('rounds');
  }
  if (cfg.hypotheses_per_round) setField('cfg-hyp-count', cfg.hypotheses_per_round);
  if (cfg.n_evolved_per_round)  setField('cfg-evolved',   cfg.n_evolved_per_round);
  if (cfg.contender_pool_size)  setField('cfg-contenders', cfg.contender_pool_size);
}

function setField(id, val) {
  const el = document.getElementById(id);
  if (el) el.value = val;
}

function readForm() {
  const mode = document.getElementById('cfg-run-mode').value;
  return {
    research_goal: document.getElementById('cfg-goal').value.trim(),
    domain_context: {
      research_anchor:   document.getElementById('cfg-anchor').value.trim(),
      target_population: document.getElementById('cfg-population').value.trim(),
      context_setting:   document.getElementById('cfg-context').value.trim(),
      hard_constraints:  lines('cfg-hard'),
      soft_factors:      lines('cfg-soft'),
      frontier_seed_list: {
        core_fronts:                lines('cfg-fronts'),
        cross_disciplinary_targets: lines('cfg-cross'),
        frontier_phenomena:         lines('cfg-phenomena'),
      },
      literature_hierarchy: {
        primary:            document.getElementById('cfg-lit-primary').value.trim(),
        secondary:          document.getElementById('cfg-lit-secondary').value.trim(),
        tertiary:           document.getElementById('cfg-lit-tertiary').value.trim(),
        treat_with_caution: document.getElementById('cfg-lit-caution').value.trim(),
      },
    },
    config: {
      hypotheses_per_round: parseInt(document.getElementById('cfg-hyp-count').value) || 15,
      n_evolved_per_round:  parseInt(document.getElementById('cfg-evolved').value) || 5,
      max_rounds:           parseInt(document.getElementById('cfg-rounds').value) || 3,
    },
    runMode:    mode,
    durationMs: mode === 'timed' ? (parseInt(document.getElementById('cfg-duration').value) || 10) * 60000 : null,
  };
}

function showTabsAreaAfterLoad(tab = 'research') {
  showTabsArea(tab);
  updateRunEstimate();
}

document.getElementById('btn-save-intake').addEventListener('click', async () => {
  const result = await window.cs.saveIntake(readForm());
  if (result.cancelled) return;
  if (!result.ok) { showError(`Save failed: ${result.error}`); return; }
  showError('');
});

document.getElementById('btn-load-intake').addEventListener('click', async () => {
  if (!window.cs) return;
  const result = await window.cs.loadIntake();
  if (result.cancelled) return;
  if (!result.ok) { showError(`Load failed: ${result.error}`); return; }
  populateForm(result.data);
  showError('');
  showTabsAreaAfterLoad('research');
});

document.getElementById('btn-load-example').addEventListener('click', async () => {
  if (!window.cs) return;
  const result = await window.cs.loadExample();
  if (!result.ok) { showError(`Could not load example: ${result.error}`); return; }
  populateForm(result.data);
  showError('');
  showTabsAreaAfterLoad('research');
});

// ── Utilities ─────────────────────────────────────────────────────────────

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Init — load existing state ────────────────────────────────────────────

(async () => {
  if (!window.cs) {
    // The preload bridge failed to load — make it loud instead of silently
    // disabling every feature. (In a plain browser preview this is expected.)
    const isElectron = navigator.userAgent.includes('Electron');
    if (isElectron) {
      const banner = document.createElement('div');
      banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999;background:#3a1b1b;color:#ef5350;padding:12px 20px;font:14px sans-serif;border-bottom:1px solid #ef5350;';
      banner.textContent = '⚠ Internal bridge (preload) failed to load — the app cannot talk to its backend. Check the terminal for a preload error.';
      document.body.appendChild(banner);
    }
    return;
  }

  // ── App Log panel ─────────────────────────────────────────────────────────
  const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
  let _logEntries  = [];
  let _logMinLevel = 'debug';
  let _errorCount  = 0;

  const logBadge   = document.getElementById('log-error-badge');
  const logEntries = document.getElementById('log-entries');

  document.querySelectorAll('.log-lvl-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.log-lvl-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _logMinLevel = btn.dataset.level;
      renderLog();
    });
  });

  document.getElementById('btn-clear-log').addEventListener('click', () => {
    _logEntries = [];
    _errorCount = 0;
    logBadge.style.display = 'none';
    renderLog();
  });

  function renderLog() {
    const minLevel = LOG_LEVELS[_logMinLevel] ?? 0;
    const visible  = _logEntries.filter(e => (LOG_LEVELS[e.level] ?? 0) >= minLevel).slice(-300);
    logEntries.innerHTML = '';
    for (const e of visible) {
      const row = document.createElement('div');
      row.className = `log-entry ${e.level}`;
      const time = new Date(e.ts).toLocaleTimeString([], { hour12: false });
      row.innerHTML = `<span class="log-entry-level">${e.level}</span><span class="log-entry-time">${time}</span><span class="log-entry-msg">${escHtml(e.message)}</span>`;
      logEntries.appendChild(row);
    }
    logEntries.scrollTop = logEntries.scrollHeight;
  }
  _renderLog = renderLog; // expose to module scope (showPanel)

  window.cs.onAppLog(entry => {
    _logEntries.push({ level: entry.level, message: `[${entry.agent}] ${entry.message}`, ts: entry.ts || new Date().toISOString() });
    if (_logEntries.length > 500) _logEntries.shift();
    if (entry.level === 'error' || entry.level === 'warn') {
      if (entry.level === 'error') _errorCount++;
      logBadge.textContent = _errorCount || '!';
      logBadge.style.display = '';
    }
    // Always re-render (panel-body scrolls, so it's cheap)
    renderLog();
  });

  // ── Settings panel ───────────────────────────────────────────────────────
  // NOTE: all event listeners below are attached SYNCHRONOUSLY (no await before
  // them) so a failure in refreshSettings() can never leave the Save buttons
  // unwired. refreshSettings is fully guarded and called last.

  async function refreshSettings() {
    let info = null, keys = { activeProvider: null };
    try {
      [info, keys] = await Promise.all([
        window.cs.getProviderInfo(),
        window.cs.getApiKeys(),
      ]);
    } catch (err) {
      console.error(`[settings] refresh failed: ${err.message}`);
    }
    keys = keys || { activeProvider: null };

    const gStatus = document.getElementById('key-status-google');
    const aStatus = document.getElementById('key-status-anthropic');
    const gBlock  = document.getElementById('key-block-google');
    const aBlock  = document.getElementById('key-block-anthropic');

    if (keys.activeProvider === 'google') {
      if (gStatus) { gStatus.textContent = '✓ Active'; gStatus.className = 'settings-key-status active'; }
      if (aStatus) { aStatus.textContent = 'Inactive'; aStatus.className = 'settings-key-status inactive'; }
      gBlock?.classList.add('active-provider');
      aBlock?.classList.remove('active-provider');
      const gi = document.getElementById('key-input-google');
      if (gi) gi.placeholder = keys.googleKey || 'AIzaSy…';
    } else if (keys.activeProvider === 'anthropic') {
      if (aStatus) { aStatus.textContent = '✓ Active'; aStatus.className = 'settings-key-status active'; }
      if (gStatus) { gStatus.textContent = 'Inactive'; gStatus.className = 'settings-key-status inactive'; }
      aBlock?.classList.add('active-provider');
      gBlock?.classList.remove('active-provider');
      const ai = document.getElementById('key-input-anthropic');
      if (ai) ai.placeholder = keys.anthropicKey || 'sk-ant-…';
    } else {
      if (gStatus) { gStatus.textContent = 'No key'; gStatus.className = 'settings-key-status inactive'; }
      if (aStatus) { aStatus.textContent = 'No key'; aStatus.className = 'settings-key-status inactive'; }
    }

    const modelSelect = document.getElementById('cfg-model');
    const badge       = document.getElementById('settings-provider-badge');
    if (!modelSelect || !badge) return;

    if (!info || info.error || !info.provider) {
      modelSelect.innerHTML = '<option value="">Save an API key first</option>';
      badge.textContent = 'None'; badge.className = 'provider-badge';
      return;
    }

    const prevVal = modelSelect.value;
    modelSelect.innerHTML = info.models.map(m =>
      `<option value="${m.id}">${m.label}</option>`
    ).join('');
    const target = info.currentModel || prevVal || info.models[0]?.id;
    if (target) {
      modelSelect.value = target;
      try { await window.cs.setModel(target); } catch {}
    }

    const providerLabel = info.provider === 'google' ? 'Google AI' : 'Anthropic';
    badge.textContent = providerLabel;
    badge.className   = `provider-badge ${info.provider}`;
  }
  _refreshSettings = refreshSettings; // expose to module scope (showPanel)

  async function saveKey(provider) {
    const inputId  = provider === 'google' ? 'key-input-google' : 'key-input-anthropic';
    const statusId = provider === 'google' ? 'key-status-google' : 'key-status-anthropic';
    const input  = document.getElementById(inputId);
    const status = document.getElementById(statusId);
    const key = (input?.value || '').trim();
    if (!key) {
      if (status) { status.textContent = '⚠ Enter a key first'; status.className = 'settings-key-status inactive'; }
      input?.focus();
      return;
    }
    if (status) { status.textContent = 'Saving…'; status.className = 'settings-key-status'; }
    try {
      const result = await window.cs.saveApiKey({ provider, key });
      if (result && result.ok) {
        if (input) input.value = '';
        await refreshSettings();
      } else {
        if (status) { status.textContent = `⚠ ${result?.error || 'Save failed'}`; status.className = 'settings-key-status inactive'; }
      }
    } catch (err) {
      if (status) { status.textContent = `⚠ ${err.message}`; status.className = 'settings-key-status inactive'; }
    }
  }

  // Attach listeners synchronously
  document.getElementById('btn-save-google')?.addEventListener('click', () => saveKey('google'));
  document.getElementById('btn-save-anthropic')?.addEventListener('click', () => saveKey('anthropic'));

  document.getElementById('btn-test-api')?.addEventListener('click', async () => {
    const btn    = document.getElementById('btn-test-api');
    const status = document.getElementById('test-api-status');
    if (!btn || !status) return;
    btn.disabled = true;
    status.style.color = 'var(--muted)';
    status.textContent = 'Testing…';
    try {
      const r = await window.cs.testApi();
      if (r && r.ok) {
        status.style.color = 'var(--green)';
        status.textContent = `✓ Connected — ${r.provider} replied: "${r.reply}"`;
      } else {
        status.style.color = 'var(--red)';
        const msg = r?.error || 'Unknown error';
        if (msg.includes('API key') || msg.includes('GOOGLE_API_KEY') || msg.includes('ANTHROPIC_API_KEY') || msg.includes('No key')) {
          status.textContent = '⚠ No API key set. Save a key above first.';
        } else {
          status.textContent = `⚠ ${msg}`;
        }
      }
    } catch (err) {
      status.style.color = 'var(--red)';
      status.textContent = `⚠ ${err.message}`;
    }
    btn.disabled = false;
  });
  document.getElementById('cfg-model')?.addEventListener('change', async (e) => {
    try { await window.cs.setModel(e.target.value); } catch {}
  });
  // Enter-to-save inside key inputs
  document.getElementById('key-input-google')?.addEventListener('keydown', e => { if (e.key === 'Enter') saveKey('google'); });
  document.getElementById('key-input-anthropic')?.addEventListener('keydown', e => { if (e.key === 'Enter') saveKey('anthropic'); });

  document.querySelectorAll('.settings-key-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const input = document.getElementById(btn.dataset.target);
      if (!input) return;
      const show  = input.type === 'password';
      input.type  = show ? 'text' : 'password';
      btn.textContent = show ? 'Hide' : 'Show';
    });
  });

  // Now refresh (listeners already wired, so a throw here is harmless)
  await refreshSettings();

  // ── Register guide intake handler ────────────────────────────────────────
  window.cs.onGuideIntakeReady(intake => {
    _guidePendingIntake = intake;
    document.getElementById('guide-apply-bar').style.display = 'flex';
    guideScrollBottom();
  });

  const state = await window.cs.getState();
  if (state) {
    _state = state;
    _runId = state.run_id;
    updateStats(state);
    document.getElementById('setup-run-id-badge').textContent = state.run_id;
    document.getElementById('status-text').textContent =
      state.phase === 'complete' ? 'Complete' : 'Paused';
    document.getElementById('status-dot').className =
      'dot' + (state.phase === 'complete' ? ' complete' : '');
  }
})();
