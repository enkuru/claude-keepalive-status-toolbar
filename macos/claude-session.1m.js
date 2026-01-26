#!/usr/bin/env node

import {
  DEFAULTS,
  getLatestActivityTimestamp,
  getSessionStartTimestamp,
  fetchUsageLimits,
  limitOk,
  readState,
  formatAge,
} from '../scripts/active-session-core.js';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

function getConfigFromEnv() {
  const toNumber = (value, fallback) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  return {
    activeMinutes: toNumber(process.env.ACTIVE_MINUTES, DEFAULTS.activeMinutes),
    maxDepth: toNumber(process.env.MAX_DEPTH, DEFAULTS.maxDepth),
    tailBytes: toNumber(process.env.TAIL_BYTES, DEFAULTS.tailBytes),
    transcriptPath: process.env.TRANSCRIPT_PATH || null,
  };
}

function menuLine(text) {
  console.log(text);
}

function clampPercent(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, value));
}

function progressBar(percent, width = 10) {
  const clamped = clampPercent(percent);
  if (clamped === null) return 'n/a';
  const filled = Math.round((clamped / 100) * width);
  const empty = Math.max(0, width - filled);
  return `[${'█'.repeat(filled)}${'░'.repeat(empty)}] ${Math.round(clamped)}%`;
}

function formatResetTime(value) {
  if (!value) return 'unknown';
  const ts = new Date(value).getTime();
  if (Number.isNaN(ts)) return 'unknown';
  const deltaMs = ts - Date.now();
  const minutes = Math.round(deltaMs / 60000);
  if (minutes <= 0) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  const days = Math.round(hours / 24);
  return `${days}d`;
}

function formatHistory(history, lastLaunch, maxItems = 3) {
  const base = Array.isArray(history) ? history : [];
  const itemsRaw = base.length ? base : lastLaunch ? [lastLaunch] : [];
  if (!itemsRaw.length) return 'none';
  const items = itemsRaw.slice(-maxItems).reverse();
  return items.map((ts) => formatAge(ts)).join(', ');
}

async function main() {
  const config = getConfigFromEnv();
  const lastActivity = await getLatestActivityTimestamp(config);
  const sessionStart = await getSessionStartTimestamp(config);
  const limits = await fetchUsageLimits();
  const state = await readState();
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(scriptDir, '..');
  const envKeeperPath = process.env.KEEPALIVE_PATH;
  const envRepoPath = process.env.KEEPALIVE_REPO;
  let keeperPath =
    envKeeperPath ||
    (envRepoPath ? path.join(envRepoPath, 'scripts', 'active-session-keeper.js') : null);
  if (!keeperPath) {
    const candidate = path.join(repoRoot, 'scripts', 'active-session-keeper.js');
    if (existsSync(candidate)) keeperPath = candidate;
  }

  const now = Date.now();
  const activeWindowMs = config.activeMinutes * 60 * 1000;
  const isActive = !!(lastActivity && now - lastActivity <= activeWindowMs);

  let header = 'Claude: Idle';
  if (isActive) header = 'Claude: Active';
  if (!limits) header = 'Claude: Limits Unknown';

  const fiveUtil = limits?.five_hour?.utilization;
  const fiveClamped = clampPercent(fiveUtil);
  if (fiveClamped !== null && fiveClamped >= 100) {
    header = `${header} (Limit)`;
  }
  const limitsOk =
    limits && limitOk(limits.five_hour) && limitOk(limits.seven_day);

  menuLine(header);
  menuLine('---');
  menuLine(`Status: ${isActive ? 'Active' : 'Idle'}`);
  menuLine(`Last activity: ${formatAge(lastActivity)}`);
  menuLine(`Session start: ${formatAge(sessionStart)}`);

  if (limits) {
    const seven = limits.seven_day?.utilization;
    const fiveReset = limits.five_hour?.resets_at;
    const sevenReset = limits.seven_day?.resets_at;
    menuLine(
      `5h limit: ${progressBar(fiveUtil)} (${limitOk(limits.five_hour) ? 'ok' : 'full'})`
    );
    menuLine(`5h resets: ${formatResetTime(fiveReset)}`);
    menuLine(
      `7d limit: ${progressBar(seven)} (${limitOk(limits.seven_day) ? 'ok' : 'full'})`
    );
    menuLine(`7d resets: ${formatResetTime(sevenReset)}`);
  } else {
    menuLine('5h limit: n/a');
    menuLine('7d limit: n/a');
  }

  if (state?.lastLaunch) {
    menuLine(`Last hello: ${formatAge(state.lastLaunch)} ago`);
  } else {
    menuLine('Last hello: never');
  }
  menuLine(`Hello history: ${formatHistory(state?.history, state?.lastLaunch)}`);

  menuLine('---');
  if (limitsOk && keeperPath) {
    menuLine(
      `Send hello now | bash=/usr/bin/env param1=node param2=${keeperPath} param3=--once param4=--active-minutes=0 param5=--cooldown-minutes=0 terminal=false refresh=true`
    );
  } else if (!keeperPath) {
    menuLine('Send hello now (set KEEPALIVE_PATH) | disabled=true');
  } else {
    menuLine('Send hello now (limits full) | disabled=true');
  }
  menuLine('Active session keeper status');
}

main().catch(() => {
  console.log('Claude: Error');
});
