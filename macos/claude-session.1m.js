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

function resolveNodePath() {
  const envNode = process.env.KEEPALIVE_NODE || process.env.NODE_PATH;
  if (envNode && existsSync(envNode)) return envNode;
  const candidates = ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node'];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return 'node';
}

function pickColorByPercent(percent) {
  const clamped = clampPercent(percent);
  if (clamped === null) return '#9CA3AF'; // gray
  if (clamped >= 90) return '#EF4444'; // red
  if (clamped >= 70) return '#F59E0B'; // amber
  return '#10B981'; // emerald
}

function pickStatusColor(state) {
  switch (state) {
    case 'Unknown':
      return '#EF4444';
    case 'Cached':
      return '#F59E0B';
    case 'Limit':
      return '#EF4444';
    case 'Active':
      return '#10B981';
    case 'Idle':
    default:
      return '#9CA3AF';
  }
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
  return `${'█'.repeat(filled)}${'░'.repeat(empty)} ${Math.round(clamped)}%`;
}

function formatResetTime(value) {
  if (!value) return 'unknown';
  const ts = new Date(value).getTime();
  if (Number.isNaN(ts)) return 'unknown';
  const deltaMs = ts - Date.now();
  const totalMinutes = Math.max(0, Math.ceil(deltaMs / 60000));
  if (totalMinutes === 0) return 'now';
  if (totalMinutes < 60) return `${totalMinutes}m`;
  if (totalMinutes < 1440) {
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return `${hours}h ${minutes}m`;
  }
  const days = Math.floor(totalMinutes / 1440);
  const remainder = totalMinutes % 1440;
  const hours = Math.floor(remainder / 60);
  const minutes = remainder % 60;
  return `${days}d ${hours}h ${minutes}m`;
}

function formatAgeFromMinutes(minutes) {
  if (typeof minutes !== 'number' || !Number.isFinite(minutes)) return 'unknown';
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
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
  const limitsInfo = await fetchUsageLimits({
    allowStale: true,
    allowCache: true,
    maxAgeMinutes: 360,
  });
  const limits = limitsInfo?.limits ?? null;
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
  const nodePath = resolveNodePath();
  const runOnceArgs = keeperPath
    ? [
        nodePath,
        keeperPath,
        '--once',
        '--active-minutes=0',
        '--cooldown-minutes=0',
      ]
    : null;

  const now = Date.now();
  const activeWindowMs = config.activeMinutes * 60 * 1000;
  const isActive = !!(lastActivity && now - lastActivity <= activeWindowMs);

  const fiveUtil = limits?.five_hour?.utilization;
  const fiveClamped = clampPercent(fiveUtil);
  let headerState = 'Idle';
  if (!limits) headerState = 'Unknown';
  else if (fiveClamped !== null && fiveClamped >= 100) headerState = 'Limit';
  else if (isActive) headerState = 'Active';
  const limitsOk =
    limits && limitOk(limits.five_hour) && limitOk(limits.seven_day);
  const statusColor = pickStatusColor(headerState);
  const fiveText =
    fiveClamped === null ? '5h: n/a' : `5h: ${Math.round(fiveClamped)}%`;
  const sevenUtil = limits?.seven_day?.utilization;
  const sevenClamped = clampPercent(sevenUtil);
  const sevenText =
    sevenClamped === null ? '7d: n/a' : `7d: ${Math.round(sevenClamped)}%`;
  menuLine(
    `Claude ${fiveText}  ${sevenText} | color=${statusColor} font=SF Pro Text size=12`
  );
  menuLine('---');
  menuLine(`Status: ${isActive ? 'Active' : 'Idle'} | color=${statusColor}`);
  menuLine(
    `Session start: ${formatAge(sessionStart)}   ·   Last activity: ${formatAge(
      lastActivity
    )} | color=#CBD5F5`
  );
  if (limitsInfo?.stale) {
    menuLine(
      `Limits: cached (${formatAgeFromMinutes(limitsInfo.ageMinutes)} ago) | color=#F59E0B`
    );
  }
  if (limitsInfo?.errorCode === 'token_expired') {
    menuLine('Auth: token expired (open Claude Code) | color=#F97316');
  }

  if (limits) {
    const seven = limits.seven_day?.utilization;
    const fiveReset = limits.five_hour?.resets_at;
    const sevenReset = limits.seven_day?.resets_at;
    const fiveColor = pickColorByPercent(fiveUtil);
    const sevenColor = pickColorByPercent(seven);
    menuLine(
      `5h limit: ${progressBar(fiveUtil)} (${limitOk(limits.five_hour) ? 'ok' : 'full'}) | color=${fiveColor} font=Menlo`
    );
    menuLine(`5h resets: ${formatResetTime(fiveReset)} | color=#93C5FD`);
    menuLine(
      `7d limit: ${progressBar(seven)} (${limitOk(limits.seven_day) ? 'ok' : 'full'}) | color=${sevenColor} font=Menlo`
    );
    menuLine(`7d resets: ${formatResetTime(sevenReset)} | color=#93C5FD`);
  } else {
    menuLine('5h limit: n/a | color=#9CA3AF');
    menuLine('7d limit: n/a | color=#9CA3AF');
  }

  if (state?.lastLaunch) {
    menuLine(`Last hello: ${formatAge(state.lastLaunch)} ago | color=#A7F3D0`);
  } else {
    menuLine('Last hello: never | color=#A7F3D0');
  }
  menuLine(
    `Hello history: ${formatHistory(state?.history, state?.lastLaunch)} | color=#A7F3D0`
  );

  menuLine('---');
  if (limitsOk && runOnceArgs) {
    menuLine(
      `Send hello now | color=#22C55E bash=${runOnceArgs[0]} param1=${runOnceArgs[1]} param2=${runOnceArgs[2]} param3=${runOnceArgs[3]} param4=${runOnceArgs[4]} terminal=false refresh=true`
    );
  } else if (!keeperPath) {
    menuLine('Send hello now (set KEEPALIVE_PATH) | disabled=true');
  } else {
    menuLine('Send hello now (limits full) | disabled=true');
  }
  menuLine('Active session keeper status | color=#94A3B8');
}

main().catch((error) => {
  if (process.env.DEBUG_MENU) {
    console.error(error);
  }
  console.log('Claude: Error');
});
