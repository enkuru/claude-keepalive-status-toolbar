#!/usr/bin/env node

import { spawn } from 'child_process';
import {
  DEFAULTS,
  getLatestActivityTimestamp,
  fetchUsageLimits,
  limitOk,
  readState,
  writeState,
} from './active-session-core.js';

const VERBOSE = process.env.VERBOSE === '1' || process.env.DEBUG === '1';

function log(...args) {
  if (VERBOSE) {
    console.log(new Date().toISOString(), '-', ...args);
  }
}

function parseArgs(argv) {
  const config = {
    once: false,
    dryRun: false,
    intervalMinutes: DEFAULTS.intervalMinutes,
    activeMinutes: DEFAULTS.activeMinutes,
    helloDelaySeconds: DEFAULTS.helloDelaySeconds,
    cooldownMinutes: DEFAULTS.cooldownMinutes,
    maxDepth: DEFAULTS.maxDepth,
    tailBytes: DEFAULTS.tailBytes,
    transcriptPath: null,
  };

  for (const arg of argv) {
    if (arg === '--once') config.once = true;
    else if (arg === '--dry-run') config.dryRun = true;
    else if (arg.startsWith('--interval-minutes=')) {
      config.intervalMinutes = Number(arg.split('=')[1]);
    } else if (arg.startsWith('--active-minutes=')) {
      config.activeMinutes = Number(arg.split('=')[1]);
    } else if (arg.startsWith('--hello-delay-seconds=')) {
      config.helloDelaySeconds = Number(arg.split('=')[1]);
    } else if (arg.startsWith('--cooldown-minutes=')) {
      config.cooldownMinutes = Number(arg.split('=')[1]);
    } else if (arg.startsWith('--max-depth=')) {
      config.maxDepth = Number(arg.split('=')[1]);
    } else if (arg.startsWith('--tail-bytes=')) {
      config.tailBytes = Number(arg.split('=')[1]);
    } else if (arg.startsWith('--transcript-path=')) {
      config.transcriptPath = arg.split('=')[1] || null;
    }
  }

  return config;
}

function getClaudeCommand() {
  const cmd = process.env.CLAUDE_CMD || 'claude';
  const argsEnv = process.env.CLAUDE_ARGS || '';
  const args = argsEnv.split(' ').map((s) => s.trim()).filter(Boolean);
  return { cmd, args };
}

function launchClaudeHello(delaySeconds, dryRun) {
  const { cmd, args } = getClaudeCommand();

  if (dryRun) {
    log('DRY RUN: would spawn', cmd, args.join(' '));
    return;
  }

  const child = spawn(cmd, args, {
    stdio: ['pipe', 'ignore', 'ignore'],
    detached: true,
  });

  setTimeout(() => {
    try {
      child.stdin.write('hello\n');
      child.stdin.end();
    } catch {
      // ignore
    }
  }, delaySeconds * 1000);

  child.unref();
}

let tickInProgress = false;

async function tick(config) {
  if (tickInProgress) return;
  tickInProgress = true;

  try {
    const lastActivity = await getLatestActivityTimestamp(config);
    const now = Date.now();
    const activeWindowMs = config.activeMinutes * 60 * 1000;

    if (lastActivity && now - lastActivity <= activeWindowMs) {
      log('Active session detected, skipping.');
      return;
    }

    const limits = await fetchUsageLimits();
    if (!limits) {
      log('Unable to fetch limits; skipping.');
      return;
    }

    const okFive = limitOk(limits.five_hour);
    const okSeven = limitOk(limits.seven_day);

    if (!okFive || !okSeven) {
      log('Rate limits reached or unavailable; skipping.', {
        five_hour: limits.five_hour?.utilization,
        seven_day: limits.seven_day?.utilization,
      });
      return;
    }

    const state = await readState();
    const cooldownMs = config.cooldownMinutes * 60 * 1000;
    if (state?.lastLaunch && now - state.lastLaunch < cooldownMs) {
      log('Cooldown active; skipping.');
      return;
    }

    launchClaudeHello(config.helloDelaySeconds, config.dryRun);
    const history = Array.isArray(state?.history) ? state.history.slice(-19) : [];
    history.push(now);
    await writeState({ lastLaunch: now, history });
    log('Launched Claude with hello prompt.');
  } finally {
    tickInProgress = false;
  }
}

async function main() {
  const config = parseArgs(process.argv.slice(2));
  const intervalMs = config.intervalMinutes * 60 * 1000;

  await tick(config);

  if (!config.once) {
    setInterval(() => {
      tick(config).catch(() => {});
    }, intervalMs);
  }
}

main().catch(() => {
  process.exit(1);
});
