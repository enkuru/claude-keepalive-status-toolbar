#!/usr/bin/env node

import {
  DEFAULTS,
  getLatestActivityTimestamp,
  getLatestActivityCwd,
  getSessionStartTimestamp,
  fetchUsageLimits,
  fetchExtraUsageStatus,
  limitOk,
  readState,
  formatAge,
} from '../scripts/active-session-core.js';
import { updateUsageHistory } from '../scripts/usage-history.js';
import { existsSync } from 'fs';
import { writeFileSync } from 'fs';
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

function resolveClaudeCliPath() {
  const envCmd = process.env.CLAUDE_CMD;
  if (envCmd && envCmd.includes('/') && existsSync(envCmd)) return envCmd;
  const candidates = [
    path.join(process.env.HOME || '', '.local', 'bin', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    '/usr/bin/claude',
  ];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return envCmd || 'claude';
}

function shellEscape(value) {
  if (typeof value !== 'string' || value.length === 0) return "''";
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function resolveClaudeAppOpenArgs() {
  const envPath = process.env.CLAUDE_APP_PATH;
  if (envPath && existsSync(envPath)) {
    return ['/usr/bin/open', [envPath]];
  }
  const envApp = process.env.CLAUDE_APP || 'Claude Code';
  const candidates = [
    '/Applications/Claude Code.app',
    '/Applications/Claude.app',
    path.join(process.env.HOME || '', 'Applications', 'Claude Code.app'),
    path.join(process.env.HOME || '', 'Applications', 'Claude.app'),
  ];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      return ['/usr/bin/open', [candidate]];
    }
  }
  return ['/usr/bin/open', ['-a', envApp]];
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

function formatResetTimeWithClock(value) {
  if (!value) return 'unknown';
  const ts = new Date(value);
  if (Number.isNaN(ts.getTime())) return 'unknown';
  const relative = formatResetTime(value);
  const clock = ts.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return `${relative} (${clock})`;
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

function formatUsd(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'n/a';
  return `$${value.toFixed(2)}`;
}

function formatExtraUsage(info) {
  let label = 'unknown';
  let color = '#EF4444';
  if (typeof info?.enabled === 'boolean') {
    label = info.enabled ? 'On' : 'Off';
    color = info.enabled ? '#10B981' : '#9CA3AF';
  }
  if (info?.stale) {
    label = `${label} (cached)`;
    color = '#F59E0B';
  }
  return { label, color };
}

function ensureLogFile(filePath) {
  if (existsSync(filePath)) return;
  try {
    writeFileSync(filePath, '', { mode: 0o600 });
  } catch {
    // ignore
  }
}

async function main() {
  const config = getConfigFromEnv();
  const lastActivity = await getLatestActivityTimestamp(config);
  const lastCwd = await getLatestActivityCwd(config);
  const sessionStart = await getSessionStartTimestamp(config);
  const limitsInfo = await fetchUsageLimits({
    allowStale: true,
    allowCache: true,
    maxAgeMinutes: 360,
  });
  let usageSummary = null;
  try {
    usageSummary = await updateUsageHistory();
  } catch {
    usageSummary = null;
  }
  const extraUsageInfo = await fetchExtraUsageStatus({
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
  const now = Date.now();
  const activeWindowMs = config.activeMinutes * 60 * 1000;
  const isActive = !!(lastActivity && now - lastActivity <= activeWindowMs);

  const fiveUtil = limits?.five_hour?.utilization;
  const fiveClamped = clampPercent(fiveUtil);
  const fiveResetTitle = limits?.five_hour?.resets_at;
  const sevenUtil = limits?.seven_day?.utilization;
  const sevenClamped = clampPercent(sevenUtil);
  const sevenResetTitle = limits?.seven_day?.resets_at;
  const fiveFull = !!(
    limits &&
    typeof limits.five_hour?.utilization === 'number' &&
    Number.isFinite(limits.five_hour.utilization) &&
    limits.five_hour.utilization >= 100
  );
  const sevenFull = !!(
    limits &&
    typeof limits.seven_day?.utilization === 'number' &&
    Number.isFinite(limits.seven_day.utilization) &&
    limits.seven_day.utilization >= 100
  );
  let headerState = 'Idle';
  if (!limits) headerState = limitsInfo?.stale ? 'Cached' : 'Unknown';
  else if (fiveFull || sevenFull) headerState = 'Limit';
  else if (limitsInfo?.stale) headerState = 'Cached';
  else if (isActive) headerState = 'Active';
  const limitsOk =
    limits && limitOk(limits.five_hour) && limitOk(limits.seven_day);
  const statusColor = pickStatusColor(headerState);
  const fiveText = fiveFull
    ? `5h: ${formatResetTime(fiveResetTitle)}`
    : fiveClamped === null
    ? '5h: n/a'
    : `5h: ${Math.round(fiveClamped)}%`;
  const sevenText = sevenFull
    ? `7d: ${formatResetTime(sevenResetTitle)}`
    : sevenClamped === null
    ? '7d: n/a'
    : `7d: ${Math.round(sevenClamped)}%`;
  let titleUsage = null;
  if (usageSummary?.ok && Number.isFinite(usageSummary.dayCost)) {
    titleUsage = formatUsd(usageSummary.dayCost);
  }
  const titleParts = ['Claude', titleUsage || null, fiveText, sevenText].filter(Boolean);
  menuLine(`${titleParts.join('  ')} | color=${statusColor} font=SF Pro Text size=12`);
  menuLine('---');
  const keepaliveState = state?.pauseUntil && Date.now() < state.pauseUntil
    ? 'Paused'
    : 'On';
  const authState = limitsInfo?.errorCode === 'token_expired' ? 'Token Expired' : 'OK';
  const limitsState = limitsInfo?.stale ? 'Cached' : limits ? 'Live' : 'Unknown';
  menuLine(`Health: Auth ${authState} · Limits ${limitsState} · Keepalive ${keepaliveState} | color=#94A3B8`);
  const extraUsage = formatExtraUsage(extraUsageInfo);
  menuLine(`Extra usage: ${extraUsage.label} | color=${extraUsage.color}`);
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

  if (usageSummary?.ok) {
    const missingPricing = usageSummary.missingPricing?.length > 0;
    const pricingLoaded = usageSummary.pricingLoaded;
    const usageColor = missingPricing ? '#F59E0B' : '#10B981';
    if (!pricingLoaded) {
      menuLine('Usage: set pricing | color=#F59E0B');
    } else {
      const note = missingPricing ? ' (pricing missing)' : '';
      menuLine(
        `Usage today: ${formatUsd(usageSummary.dayCost)}${note} | color=${usageColor}`
      );
      menuLine(
        `Usage 3d: ${formatUsd(usageSummary.last3Cost)}${note} | color=${usageColor}`
      );
      menuLine(
        `Usage ${usageSummary.monthKey}: ${formatUsd(usageSummary.monthCost)}${note} | color=${usageColor}`
      );
      if (Number.isFinite(usageSummary.allTimeCost)) {
        menuLine(
          `Usage all-time: ${formatUsd(usageSummary.allTimeCost)}${note} | color=${usageColor}`
        );
      }
    }
    if (usageSummary.historyPath) {
      menuLine(
        `Open usage history | color=#60A5FA bash=/usr/bin/open param1=${usageSummary.historyPath} terminal=false`
      );
    }
  } else if (usageSummary?.ok === false) {
    const reason = usageSummary?.reason;
    if (reason === 'ccusage_missing') {
      menuLine('Usage: ccusage missing | color=#9CA3AF');
    } else {
      menuLine('Usage: unavailable | color=#9CA3AF');
    }
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
    menuLine(`5h resets: ${formatResetTimeWithClock(fiveReset)} | color=#93C5FD`);
    menuLine(
      `7d limit: ${progressBar(seven)} (${limitOk(limits.seven_day) ? 'ok' : 'full'}) | color=${sevenColor} font=Menlo`
    );
    menuLine(`7d resets: ${formatResetTimeWithClock(sevenReset)} | color=#93C5FD`);
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
  const forceOnceArgs = keeperPath
    ? [
        nodePath,
        keeperPath,
        '--once',
        '--force',
        '--active-minutes=0',
        '--cooldown-minutes=0',
      ]
    : null;
  const pauseArgs = keeperPath
    ? [nodePath, keeperPath, '--pause-minutes=30']
    : null;
  const resumeArgs = keeperPath
    ? [nodePath, keeperPath, '--resume']
    : null;

  if (limitsOk && runOnceArgs) {
    menuLine(
      `Send hello now | color=#22C55E bash=${runOnceArgs[0]} param1=${runOnceArgs[1]} param2=${runOnceArgs[2]} param3=${runOnceArgs[3]} param4=${runOnceArgs[4]} terminal=false refresh=true`
    );
  } else if (!keeperPath) {
    menuLine('Send hello now (set KEEPALIVE_PATH) | disabled=true');
  } else {
    menuLine('Send hello now (limits full) | disabled=true');
  }
  if (!limitsOk && forceOnceArgs) {
    menuLine(
      `Send hello anyway | color=#F97316 bash=${forceOnceArgs[0]} param1=${forceOnceArgs[1]} param2=${forceOnceArgs[2]} param3=${forceOnceArgs[3]} param4=${forceOnceArgs[4]} param5=${forceOnceArgs[5]} terminal=false refresh=true`
    );
  }
  if (pauseArgs) {
    menuLine(
      `Pause keepalive 30m | color=#F59E0B bash=${pauseArgs[0]} param1=${pauseArgs[1]} param2=${pauseArgs[2]} terminal=false refresh=true`
    );
  }
  if (resumeArgs) {
    menuLine(
      `Resume keepalive | color=#60A5FA bash=${resumeArgs[0]} param1=${resumeArgs[1]} param2=${resumeArgs[2]} terminal=false refresh=true`
    );
  }
  const [openCmd, openArgs] = resolveClaudeAppOpenArgs();
  const openParams = openArgs
    .map((arg, index) => `param${index + 1}=${arg}`)
    .join(' ');
  menuLine(`Open Claude Code app | color=#60A5FA bash=${openCmd} ${openParams} terminal=false`);
  const cliPath = resolveClaudeCliPath();
  const cliArgs = (process.env.CLAUDE_ARGS || '').split(' ').map((s) => s.trim()).filter(Boolean);
  const openCliScript = path.join(repoRoot, 'scripts', 'open-claude-cli.sh');
  if (existsSync(openCliScript)) {
    const cwdParam = lastCwd || '.';
    const params = [
      `param1=${cwdParam}`,
      `param2=${cliPath}`,
      ...cliArgs.map((arg, index) => `param${index + 3}=${arg}`),
    ].join(' ');
    menuLine(
      `Open Claude CLI (last dir) | color=#60A5FA bash=${openCliScript} ${params} terminal=true`
    );
  } else {
    const cliCmd = [shellEscape(cliPath), cliArgs.join(' ')].filter(Boolean).join(' ');
    if (lastCwd) {
      const cmd = `cd ${shellEscape(lastCwd)} && ${cliCmd}`;
      menuLine(
        `Open Claude CLI (last dir) | color=#60A5FA bash=/bin/sh param1=-lc param2=${cmd} terminal=true`
      );
    } else {
      menuLine(
        `Open Claude CLI | color=#60A5FA bash=/bin/sh param1=-lc param2=${cliCmd} terminal=true`
      );
    }
  }
  const keepaliveLogPath = '/tmp/claude-keepalive.err';
  ensureLogFile(keepaliveLogPath);
  menuLine(
    `Open keepalive log | color=#94A3B8 bash=/usr/bin/open param1=-a param2=Console.app param3=${keepaliveLogPath} terminal=false`
  );
  menuLine('Active session keeper status | color=#94A3B8');
}

main().catch((error) => {
  if (process.env.DEBUG_MENU) {
    console.error(error);
  }
  console.log('Claude: Error');
});
