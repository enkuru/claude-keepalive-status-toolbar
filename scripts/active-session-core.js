#!/usr/bin/env node

import { readdir, stat, readFile, writeFile, mkdir, open } from 'fs/promises';
import { execFileSync } from 'child_process';
import path from 'path';
import os from 'os';

export const DEFAULTS = {
  intervalMinutes: 10,
  activeMinutes: 10,
  helloDelaySeconds: 5,
  cooldownMinutes: 10,
  maxDepth: 6,
  tailBytes: 256 * 1024,
};

export const CACHE_DIR = path.join(os.homedir(), '.cache', 'claude-dashboard');
export const STATE_PATH = path.join(CACHE_DIR, 'active-session-keeper.json');

const CLAUDE_CONFIG_DIR_ENV = 'CLAUDE_CONFIG_DIR';

export function getSearchDirs() {
  const dirs = [];
  const baseDirs = [];

  const envDirs = process.env.CLAUDE_TRANSCRIPT_DIRS;
  if (envDirs) {
    for (const dir of envDirs.split(path.delimiter)) {
      if (dir.trim()) dirs.push(dir.trim());
    }
  }

  const configDirsEnv = process.env[CLAUDE_CONFIG_DIR_ENV];
  if (configDirsEnv) {
    for (const part of configDirsEnv.split(',')) {
      const trimmed = part.trim();
      if (trimmed) baseDirs.push(trimmed);
    }
  }

  const home = os.homedir();
  baseDirs.push(path.join(home, '.config', 'claude'), path.join(home, '.claude'));

  for (const base of baseDirs) {
    dirs.push(path.join(base, 'projects'));
  }

  return Array.from(new Set(dirs));
}

function isProjectsFile(filePath) {
  return filePath.split(path.sep).includes('projects') && filePath.endsWith('.jsonl');
}

function looksLikeTranscriptFile(name) {
  const lower = name.toLowerCase();
  return name.endsWith('.jsonl') && (lower.includes('transcript') || lower === 'history.jsonl');
}

function shouldSkipDir(name) {
  return name === 'node_modules' || name === '.git' || name === 'dist';
}

export async function findLatestTranscriptFile(dirs, maxDepth) {
  let latestPath = null;
  let latestMtime = 0;

  async function walk(dir, depth) {
    if (depth < 0) return;

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!shouldSkipDir(entry.name)) {
          await walk(fullPath, depth - 1);
        }
      } else if (entry.isFile()) {
        const isCandidate = isProjectsFile(fullPath) || looksLikeTranscriptFile(entry.name);
        if (isCandidate) {
          try {
            const stats = await stat(fullPath);
            if (stats.mtimeMs > latestMtime) {
              latestMtime = stats.mtimeMs;
              latestPath = fullPath;
            }
          } catch {
            // ignore
          }
        }
      }
    }
  }

  for (const dir of dirs) {
    await walk(dir, maxDepth);
  }

  return latestPath ? { path: latestPath, mtimeMs: latestMtime } : null;
}

export async function readLastTranscriptTimestamp(filePath, tailBytes) {
  try {
    const fileStat = await stat(filePath);
    const readSize = Math.min(fileStat.size, tailBytes);
    const start = Math.max(0, fileStat.size - readSize);

    const fh = await open(filePath, 'r');
    try {
      const buffer = Buffer.alloc(readSize);
      await fh.read(buffer, 0, readSize, start);
      const text = buffer.toString('utf-8');
      const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);

      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const entry = JSON.parse(lines[i]);
          const tsValue =
            entry?.timestamp ||
            entry?.snapshot?.timestamp ||
            entry?.message?.timestamp ||
            entry?.data?.timestamp;
          if (tsValue) {
            const ts = new Date(tsValue).getTime();
            if (!Number.isNaN(ts)) return ts;
          }
        } catch {
          // ignore malformed line
        }
      }
    } finally {
      await fh.close();
    }

    return fileStat.mtimeMs;
  } catch {
    return null;
  }
}

export async function readFirstTranscriptTimestamp(filePath, headBytes) {
  try {
    const fileStat = await stat(filePath);
    const readSize = Math.min(fileStat.size, headBytes);

    const fh = await open(filePath, 'r');
    try {
      const buffer = Buffer.alloc(readSize);
      await fh.read(buffer, 0, readSize, 0);
      const text = buffer.toString('utf-8');
      const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);

      for (let i = 0; i < lines.length; i++) {
        try {
          const entry = JSON.parse(lines[i]);
          const tsValue =
            entry?.timestamp ||
            entry?.snapshot?.timestamp ||
            entry?.message?.timestamp ||
            entry?.data?.timestamp;
          if (tsValue) {
            const ts = new Date(tsValue).getTime();
            if (!Number.isNaN(ts)) return ts;
          }
        } catch {
          // ignore malformed line
        }
      }
    } finally {
      await fh.close();
    }

    return fileStat.mtimeMs;
  } catch {
    return null;
  }
}

export async function getLatestActivityTimestamp(config) {
  if (config.transcriptPath) {
    return await readLastTranscriptTimestamp(config.transcriptPath, config.tailBytes);
  }

  const dirs = getSearchDirs();
  const latest = await findLatestTranscriptFile(dirs, config.maxDepth);
  if (!latest) return null;

  return await readLastTranscriptTimestamp(latest.path, config.tailBytes);
}

export async function getSessionStartTimestamp(config) {
  const headBytes = Math.min(config.tailBytes || DEFAULTS.tailBytes, 256 * 1024);
  if (config.transcriptPath) {
    return await readFirstTranscriptTimestamp(config.transcriptPath, headBytes);
  }

  const dirs = getSearchDirs();
  const latest = await findLatestTranscriptFile(dirs, config.maxDepth);
  if (!latest) return null;

  return await readFirstTranscriptTimestamp(latest.path, headBytes);
}

export async function getOAuthToken() {
  try {
    if (process.platform === 'darwin') {
      const result = execFileSync(
        'security',
        ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }
      ).trim();

      const creds = JSON.parse(result);
      return creds?.claudeAiOauth?.accessToken ?? null;
    }
  } catch {
    // fall back to file
  }

  try {
    const credPath = path.join(os.homedir(), '.claude', '.credentials.json');
    const content = await readFile(credPath, 'utf-8');
    const creds = JSON.parse(content);
    return creds?.claudeAiOauth?.accessToken ?? null;
  } catch {
    return null;
  }
}

export async function fetchUsageLimits() {
  const token = await getOAuthToken();
  if (!token) return null;

  try {
    const response = await fetch('https://api.anthropic.com/api/oauth/usage', {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'claude-dashboard/active-session-keeper',
        Authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
      },
    });

    if (!response.ok) return null;

    const data = await response.json();
    return {
      five_hour: data.five_hour ?? null,
      seven_day: data.seven_day ?? null,
    };
  } catch {
    return null;
  }
}

export function limitOk(limit) {
  return (
    limit &&
    typeof limit.utilization === 'number' &&
    Number.isFinite(limit.utilization) &&
    limit.utilization < 100
  );
}

export async function readState() {
  try {
    const raw = await readFile(STATE_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function writeState(state) {
  try {
    await mkdir(CACHE_DIR, { recursive: true, mode: 0o700 });
    await writeFile(STATE_PATH, JSON.stringify(state, null, 2), { mode: 0o600 });
  } catch {
    // ignore
  }
}

export function formatAge(timestampMs) {
  if (!timestampMs) return 'unknown';
  const deltaMs = Date.now() - timestampMs;
  if (deltaMs < 0) return 'in future';

  const seconds = Math.floor(deltaMs / 1000);
  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;

  const days = Math.floor(hours / 24);
  return `${days}d`;
}
