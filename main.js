#!/usr/bin/env node
import { createInterface } from 'readline';
import { readFile, writeFile, rm } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import chalk from 'chalk';
import Anthropic from '@anthropic-ai/sdk';

import {
  saveState, loadState, freshState,
  STATE_PATH, saveFinalCorpus, saveFinalReport, logEvent
} from './utils.js';
import { runLoop, isConverged } from './agents/supervisor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Readline helper ────────────────────────────────────────────────────────

function rl() {
  return createInterface({ input: process.stdin, output: process.stdout });
}

function ask(iface, question) {
  return new Promise(resolve => iface.question(question, resolve));
}

async function askMultiline(iface, prompt) {
  console.log(chalk.gray(`${prompt} (one per line, empty line to finish):`));
  const lines = [];
  while (true) {
    const line = await ask(iface, '  > ');
    if (!line.trim()) break;
    lines.push(line.trim());
  }
  return lines;
}

// ── Intake wizard ──────────────────────────────────────────────────────────

async function runIntakeWizard(state) {
  const iface = rl();
  console.log(chalk.white('\n╔══════════════════════════════════════╗'));
  console.log(chalk.white('║   CoScientist — Intake Wizard        ║'));
  console.log(chalk.white('╚══════════════════════════════════════╝\n'));

  state.research_goal = await ask(iface, chalk.cyan('1. Research goal (what question are you investigating?):\n  > '));
  state.domain_context.research_anchor = await ask(iface, chalk.cyan('\n2. Research anchor (domain + primary question):\n  > '));
  state.domain_context.target_population = await ask(iface, chalk.cyan('\n3. Target population and setting:\n  > '));
  state.domain_context.context_setting = await ask(iface, chalk.cyan('\n4. Context setting (study environment, time frame, etc.):\n  > '));

  state.domain_context.hard_constraints = await askMultiline(iface, chalk.cyan('\n5. Hard constraints'));
  state.domain_context.soft_factors = await askMultiline(iface, chalk.cyan('\n6. Soft factors'));

  console.log(chalk.cyan('\n7. Frontier seed list'));
  state.domain_context.frontier_seed_list.core_fronts = await askMultiline(iface, '   Core fronts');
  state.domain_context.frontier_seed_list.cross_disciplinary_targets = await askMultiline(iface, '   Cross-disciplinary targets');
  state.domain_context.frontier_seed_list.frontier_phenomena = await askMultiline(iface, '   Frontier phenomena');

  console.log(chalk.cyan('\n8. Literature hierarchy'));
  state.domain_context.literature_hierarchy.primary = await ask(iface, '   Primary sources:\n  > ');
  state.domain_context.literature_hierarchy.secondary = await ask(iface, '   Secondary sources:\n  > ');
  state.domain_context.literature_hierarchy.tertiary = await ask(iface, '   Tertiary sources:\n  > ');
  state.domain_context.literature_hierarchy.treat_with_caution = await ask(iface, '   Treat with caution:\n  > ');

  state.domain_context.output_language = await ask(iface, chalk.cyan('\n9. Output language [English]: ')) || 'English';
  state.domain_context.output_format_preference = await ask(iface, chalk.cyan('\n10. Output format preference [top 10 ranked hypotheses grouped by theme]: '))
    || 'top 10 ranked hypotheses grouped by theme, abstract-style summary';

  const maxRoundsInput = await ask(iface, chalk.cyan('\n11. Number of rounds [3]: '));
  state.config.max_rounds = parseInt(maxRoundsInput) || 3;

  // Summary
  console.log(chalk.white('\n── Configuration Summary ──────────────────────'));
  console.log(chalk.white(`Research goal:      ${state.research_goal}`));
  console.log(chalk.white(`Target population:  ${state.domain_context.target_population}`));
  console.log(chalk.white(`Hard constraints:   ${state.domain_context.hard_constraints.join(', ') || 'none'}`));
  console.log(chalk.white(`Soft factors:       ${state.domain_context.soft_factors.join(', ') || 'none'}`));
  console.log(chalk.white(`Rounds:             ${state.config.max_rounds}`));
  console.log(chalk.white('────────────────────────────────────────────\n'));

  const confirm = await ask(iface, chalk.cyan('Proceed with this configuration? (y/n): '));
  iface.close();

  if (confirm.toLowerCase() !== 'y') {
    console.log(chalk.yellow('Aborted. Run again to restart wizard.'));
    process.exit(0);
  }

  return state;
}

// ── Checkpoint prompt ──────────────────────────────────────────────────────

async function checkpoint(state) {
  const iface = rl();
  const answer = await ask(iface, chalk.cyan(`\n[Checkpoint] Continue to round ${state.round + 1}? (y/n/stop): `));
  iface.close();
  const a = answer.trim().toLowerCase();
  if (a === 'stop' || a === 'n') return false;
  return true;
}

// ── Status printer ─────────────────────────────────────────────────────────

function printStatus(state) {
  const active = state.hypotheses.filter(h => h.status === 'active');
  const rejected = state.hypotheses.filter(h => h.status === 'rejected');
  const topId = state.tournament.ranking[0];
  const topHyp = state.hypotheses.find(h => h.id === topId);

  console.log(chalk.white('\n── CoScientist Status ─────────────────────────'));
  console.log(chalk.white(`Run ID:        ${state.run_id}`));
  console.log(chalk.white(`Research goal: ${state.research_goal}`));
  console.log(chalk.white(`Phase:         ${state.phase}  (round ${state.round} / ${state.config.max_rounds})`));
  console.log(chalk.white(`Hypotheses:    ${state.hypotheses.length} total, ${active.length} active, ${rejected.length} rejected`));
  if (topHyp) {
    console.log(chalk.white(`Top hypothesis: ${topHyp.id} "${topHyp.title}" (Elo ${topHyp.elo})`));
  }
  const last = state.convergence.per_round[state.convergence.per_round.length - 1];
  if (last) {
    console.log(chalk.white(`Convergence:   Spearman ρ ${last.spearman_vs_prev?.toFixed(3) ?? 'N/A'}, top-5 churn ${last.top5_churn?.toFixed(2) ?? 'N/A'}`));
  }
  console.log(chalk.white('─────────────────────────────────────────────\n'));
}

// ── Main run orchestration ─────────────────────────────────────────────────

async function startRun(configPath) {
  // Load API key
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error(chalk.red('Error: ANTHROPIC_API_KEY environment variable not set.'));
    console.error(chalk.gray('Copy .env.example to .env and fill in your key, then: source .env'));
    process.exit(1);
  }

  const anthropic = new Anthropic({ apiKey });

  // Build run ID
  const now = new Date();
  const runId = `run-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;

  let state = freshState(runId);

  if (configPath) {
    const raw = await readFile(configPath, 'utf-8');
    const intake = JSON.parse(raw);
    // Merge intake into state
    if (intake.research_goal) state.research_goal = intake.research_goal;
    if (intake.domain_context) Object.assign(state.domain_context, intake.domain_context);
    if (intake.config) Object.assign(state.config, intake.config);
    console.log(chalk.white(`[Supervisor] Loaded config from ${configPath}`));
  } else {
    state = await runIntakeWizard(state);
  }

  await saveState(state);

  console.log(chalk.white(`\n[Supervisor] Starting run ${runId} — ${state.config.max_rounds} rounds planned\n`));
  logEvent(state, 'supervisor', `Run started: ${runId}`);

  let stopped = false;
  state = await runLoop(state, anthropic, {
    onChunk: (agent, chunk) => process.stdout.write(chunk),
    onAgentDone: () => {},
    onRoundComplete: async (s) => {
      if (!stopped && s.round < s.config.max_rounds) {
        const cont = await checkpoint(s);
        if (!cont) { stopped = true; }
      }
    },
    stopAt: null,
    shouldStop: () => stopped,
  });

  console.log(chalk.white('\n[Supervisor] Run complete — generating output files...'));
  state.phase = 'complete';
  await saveState(state);
  await saveFinalCorpus(state);
  await saveFinalReport(state);
  console.log(chalk.green(`\n[Supervisor] Done! Output saved to output/${state.run_id}/`));
  console.log(chalk.green(`  final-report.md`));
  console.log(chalk.green(`  final-corpus.json`));
}

async function resumeRun() {
  if (!existsSync(STATE_PATH)) {
    console.error(chalk.red('No state file found. Run `node main.js run` to start a new run.'));
    process.exit(1);
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error(chalk.red('Error: ANTHROPIC_API_KEY environment variable not set.'));
    process.exit(1);
  }

  const anthropic = new Anthropic({ apiKey });
  let state = await loadState();

  console.log(chalk.white(`[Supervisor] Resuming run ${state.run_id} from round ${state.round}, phase: ${state.phase}`));
  logEvent(state, 'supervisor', `Run resumed at round ${state.round}, phase ${state.phase}`);

  let stopped = false;
  state = await runLoop(state, anthropic, {
    onChunk: (agent, chunk) => process.stdout.write(chunk),
    onAgentDone: () => {},
    onRoundComplete: async (s) => {
      if (!stopped) {
        const cont = await checkpoint(s);
        if (!cont) stopped = true;
      }
    },
    stopAt: null,
    shouldStop: () => stopped,
  });

  state.phase = 'complete';
  await saveState(state);
  await saveFinalCorpus(state);
  await saveFinalReport(state);
  console.log(chalk.green(`\n[Supervisor] Done! Output saved to output/${state.run_id}/`));
}

// ── CLI ────────────────────────────────────────────────────────────────────

const [,, cmd, ...args] = process.argv;

switch (cmd) {
  case 'run': {
    const configFlag = args.indexOf('--config');
    const configPath = configFlag !== -1 ? args[configFlag + 1] : null;
    startRun(configPath).catch(err => {
      console.error(chalk.red(`\nFatal error: ${err.message}`));
      console.error(err.stack);
      process.exit(1);
    });
    break;
  }

  case 'resume':
    resumeRun().catch(err => {
      console.error(chalk.red(`\nFatal error: ${err.message}`));
      process.exit(1);
    });
    break;

  case 'status':
    if (!existsSync(STATE_PATH)) {
      console.log(chalk.yellow('No active run. Use `node main.js run` to start.'));
    } else {
      loadState().then(printStatus).catch(console.error);
    }
    break;

  case 'export':
    if (!existsSync(STATE_PATH)) {
      console.log(chalk.yellow('No state to export.'));
    } else {
      loadState().then(async state => {
        await saveFinalCorpus(state);
        await saveFinalReport(state);
        console.log(chalk.green(`Exported to output/${state.run_id}/`));
      }).catch(console.error);
    }
    break;

  case 'reset': {
    const iface = rl();
    ask(iface, chalk.red('This will delete state/state.json. Are you sure? (yes/no): ')).then(async ans => {
      iface.close();
      if (ans.trim().toLowerCase() === 'yes') {
        if (existsSync(STATE_PATH)) await rm(STATE_PATH);
        console.log(chalk.yellow('State cleared.'));
      } else {
        console.log('Cancelled.');
      }
    });
    break;
  }

  default:
    console.log(chalk.white(`CoScientist — multi-agent hypothesis generation

Usage:
  node main.js run                       Start a new run (launches intake wizard)
  node main.js run --config intake.json  Skip wizard, use saved intake
  node main.js resume                    Resume from state/state.json
  node main.js status                    Print current state summary
  node main.js export                    Export final report from current state
  node main.js reset                     Clear state, start fresh
`));
}
