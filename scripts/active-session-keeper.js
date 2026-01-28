#!/usr/bin/env node

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import os from 'os';
import path from 'path';
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
    reauthCooldownMinutes: 60,
    pauseMinutes: null,
    resume: false,
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
    } else if (arg.startsWith('--reauth-cooldown-minutes=')) {
      config.reauthCooldownMinutes = Number(arg.split('=')[1]);
    } else if (arg.startsWith('--pause-minutes=')) {
      config.pauseMinutes = Number(arg.split('=')[1]);
    } else if (arg === '--resume') {
      config.resume = true;
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

function resolveClaudeCommand() {
  const envCmd = process.env.CLAUDE_CMD;
  const home = os.homedir();
  const candidates = [
    path.join(home, '.local', 'bin', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    '/usr/bin/claude',
  ];
  const extraDirs = candidates.map((p) => path.dirname(p));

  if (envCmd) {
    if (envCmd.includes('/') && existsSync(envCmd)) return envCmd;
    const resolved = resolveCommandInPath(envCmd, extraDirs);
    if (resolved) return resolved;
  }

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return resolveCommandInPath('claude', extraDirs) || envCmd || 'claude';
}

function getClaudeCommand() {
  const cmd = resolveClaudeCommand();
  const argsEnv = process.env.CLAUDE_ARGS || '';
  const args = argsEnv.split(' ').map((s) => s.trim()).filter(Boolean);
  return { cmd, args };
}

function resolveCommandInPath(command, extraDirs = []) {
  if (!command) return null;
  if (command.includes('/') && existsSync(command)) return command;
  const envPath = process.env.PATH || '';
  const dirs = [...new Set([...extraDirs, ...envPath.split(':').filter(Boolean)])];
  for (const dir of dirs) {
    const full = path.join(dir, command);
    if (existsSync(full)) return full;
  }
  return null;
}

function getClaudeAppName() {
  return process.env.CLAUDE_APP || 'Claude Code';
}

function launchClaudeApp(dryRun) {
  const appName = getClaudeAppName();
  if (dryRun) {
    log('DRY RUN: would open app', appName);
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    const child = spawn('open', ['-a', appName], { stdio: 'ignore', detached: true });
    let resolved = false;
    const finish = (ok) => {
      if (resolved) return;
      resolved = true;
      resolve(ok);
    };
    child.once('spawn', () => finish(true));
    child.once('error', (error) => {
      log('Failed to open app.', { error: error?.message || String(error) });
      finish(false);
    });
    child.unref();
  });
}

function launchClaudeHello(delaySeconds, dryRun) {
  const { cmd, args } = getClaudeCommand();

  if (dryRun) {
    log('DRY RUN: would spawn', cmd, args.join(' '));
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    const envPathParts = [
      process.env.PATH,
      path.join(os.homedir(), '.local', 'bin'),
      '/opt/homebrew/bin',
      '/usr/local/bin',
      '/usr/bin',
    ].filter(Boolean);
    const env = { ...process.env, PATH: Array.from(new Set(envPathParts)).join(':') };
    const child = spawn(cmd, args, {
      stdio: ['pipe', 'ignore', 'ignore'],
      detached: true,
      env,
    });

    let resolved = false;
    const finish = (ok) => {
      if (resolved) return;
      resolved = true;
      resolve(ok);
    };

    child.once('spawn', () => finish(true));
    child.once('error', (error) => {
      log('Failed to spawn claude.', { error: error?.message || String(error) });
      finish(false);
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
  });
}

let tickInProgress = false;

async function tick(config) {
  if (tickInProgress) return;
  tickInProgress = true;

  try {
    const state = await readState();
    if (config.resume) {
      if (state && typeof state === 'object') {
        const nextState = { ...state };
        delete nextState.pauseUntil;
        await writeState(nextState);
      }
      log('Resumed keepalive.');
      return;
    }
    if (config.pauseMinutes && config.pauseMinutes > 0) {
      const pauseUntil = Date.now() + config.pauseMinutes * 60 * 1000;
      const nextState = state && typeof state === 'object' ? { ...state } : {};
      nextState.pauseUntil = pauseUntil;
      await writeState(nextState);
      log('Paused keepalive.', { minutes: config.pauseMinutes });
      return;
    }

    if (state?.pauseUntil && Date.now() < state.pauseUntil) {
      log('Keepalive paused; skipping tick.');
      return;
    }

    const lastActivity = await getLatestActivityTimestamp(config);
    const now = Date.now();
    const activeWindowMs = config.activeMinutes * 60 * 1000;

    if (lastActivity && now - lastActivity <= activeWindowMs) {
      log('Active session detected, skipping.');
      return;
    }

    const limitsInfo = await fetchUsageLimits({
      allowStale: true,
      allowCache: true,
      maxAgeMinutes: 360,
    });
    if (!limitsInfo) {
      log('Unable to fetch limits; skipping.');
      return;
    }
    if (limitsInfo.stale) {
      log('Using cached limits (stale).', { ageMinutes: limitsInfo.ageMinutes });
    }
    const limits = limitsInfo.limits;

    if (limitsInfo.errorCode === 'token_expired') {
      const reauthCooldownMs = config.reauthCooldownMinutes * 60 * 1000;
      if (state?.lastReauthOpen && now - state.lastReauthOpen < reauthCooldownMs) {
        log('Re-auth cooldown active; skipping app launch.');
      } else {
        const opened = await launchClaudeApp(config.dryRun);
        if (opened) {
          const nextState = state && typeof state === 'object' ? { ...state } : {};
          nextState.lastReauthOpen = now;
          await writeState(nextState);
          log('Opened Claude Code for re-auth.');
        }
      }
      return;
    }

    const okFive = limitOk(limits.five_hour);
    const okSeven = limitOk(limits.seven_day);

    if (!okFive || !okSeven || limitsInfo.stale) {
      log('Rate limits reached or unavailable; skipping.', {
        five_hour: limits.five_hour?.utilization,
        seven_day: limits.seven_day?.utilization,
        stale: limitsInfo.stale,
      });
      return;
    }

    const cooldownMs = config.cooldownMinutes * 60 * 1000;
    if (state?.lastLaunch && now - state.lastLaunch < cooldownMs) {
      log('Cooldown active; skipping.');
      return;
    }

    const launched = await launchClaudeHello(config.helloDelaySeconds, config.dryRun);
    if (!launched) {
      log('Claude command not available; skipping state update.');
      return;
    }
    const history = Array.isArray(state?.history) ? state.history.slice(-19) : [];
    history.push(now);
    const nextState = state && typeof state === 'object' ? { ...state } : {};
    nextState.lastLaunch = now;
    nextState.history = history;
    await writeState(nextState);
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
