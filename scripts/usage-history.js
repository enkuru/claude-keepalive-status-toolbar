#!/usr/bin/env node

import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const HOME = os.homedir();
const DEFAULT_STATS_PATH = path.join(HOME, '.claude', 'stats-cache.json');
const CACHE_DIR = path.join(HOME, '.cache', 'claude-dashboard');
const DEFAULT_HISTORY_PATH = path.join(CACHE_DIR, 'usage-history.json');
const CCUSAGE_CACHE_PATH = path.join(CACHE_DIR, 'ccusage-cache.json');
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PRICING_PATH = path.resolve(SCRIPT_DIR, '..', 'config', 'pricing.json');
const DEFAULT_CCUSAGE_CACHE_MINUTES = 0;
const DEFAULT_COST_SOURCE = 'ccusage';
const PRICING_REFRESH_DAYS = 30;
const PRICING_REFRESH_RETRY_HOURS = 12;

const TOKEN_KEYS = ['input', 'output', 'cacheRead', 'cacheWrite'];

function toLocalDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function toLocalMonthKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

function clampDelta(current, previous) {
  if (typeof current !== 'number' || !Number.isFinite(current)) return 0;
  if (typeof previous !== 'number' || !Number.isFinite(previous)) return current;
  const delta = current - previous;
  return delta < 0 ? current : delta;
}

function readJsonSafe(filePath) {
  return readFile(filePath, 'utf-8').then((raw) => JSON.parse(raw)).catch(() => null);
}

function resolvePricing(modelName, pricing) {
  if (!pricing) return null;
  const models = pricing.models || {};
  if (models[modelName]) return models[modelName];
  const wildcards = Object.entries(models).filter(([key]) => key.endsWith('*'));
  for (const [key, value] of wildcards) {
    const prefix = key.slice(0, -1);
    if (modelName.startsWith(prefix)) return value;
  }
  return null;
}

function getCacheReadRate(pricing, baseInput, modelRates) {
  if (typeof modelRates?.cacheRead === 'number') return modelRates.cacheRead;
  const multiplier =
    typeof pricing?.cache?.readMultiplier === 'number' ? pricing.cache.readMultiplier : 0.1;
  return baseInput * multiplier;
}

function getCacheWriteRate(pricing, baseInput, modelRates) {
  if (typeof modelRates?.cacheWrite === 'number') return modelRates.cacheWrite;
  if (typeof modelRates?.cacheWrite5m === 'number' || typeof modelRates?.cacheWrite1h === 'number') {
    const mode = (process.env.CACHE_WRITE_MODE || pricing?.cache?.writeMode || '5m').toLowerCase();
    if (mode === '1h' && typeof modelRates.cacheWrite1h === 'number') return modelRates.cacheWrite1h;
    if (mode === '5m' && typeof modelRates.cacheWrite5m === 'number') return modelRates.cacheWrite5m;
  }
  const mode = (process.env.CACHE_WRITE_MODE || pricing?.cache?.writeMode || '5m').toLowerCase();
  const multiplier =
    mode === '1h'
      ? pricing?.cache?.writeMultiplier1h ?? 2
      : pricing?.cache?.writeMultiplier5m ?? 1.25;
  return baseInput * multiplier;
}

function normalizeTotals(modelUsage = {}) {
  const totals = {};
  for (const [model, usage] of Object.entries(modelUsage)) {
    totals[model] = {
      input: Number(usage?.inputTokens) || 0,
      output: Number(usage?.outputTokens) || 0,
      cacheRead: Number(usage?.cacheReadInputTokens) || 0,
      cacheWrite: Number(usage?.cacheCreationInputTokens) || 0,
    };
  }
  return totals;
}

function addTokens(target, delta) {
  for (const key of TOKEN_KEYS) {
    target[key] = (target[key] || 0) + (delta[key] || 0);
  }
}

function addModelTokens(target, model, delta) {
  if (!target.models) target.models = {};
  if (!target.models[model]) target.models[model] = {};
  addTokens(target.models[model], delta);
}

function computeCost(deltaByModel, pricing) {
  let total = 0;
  const missing = [];
  const perModel = {};

  for (const [model, delta] of Object.entries(deltaByModel)) {
    const rates = resolvePricing(model, pricing);
    if (!rates) {
      missing.push(model);
      continue;
    }
    const baseInput = rates.input ?? rates.baseInput ?? 0;
    const outputRate = rates.output ?? 0;
    const cacheReadRate = getCacheReadRate(pricing, baseInput, rates);
    const cacheWriteRate = getCacheWriteRate(pricing, baseInput, rates);
    const cost =
      (delta.input / 1_000_000) * baseInput +
      (delta.output / 1_000_000) * outputRate +
      (delta.cacheRead / 1_000_000) * cacheReadRate +
      (delta.cacheWrite / 1_000_000) * cacheWriteRate;
    perModel[model] = cost;
    total += cost;
  }

  return { total, perModel, missing };
}

function trimHistoryKeys(obj, keepCount) {
  const keys = Object.keys(obj || {}).sort();
  if (keys.length <= keepCount) return obj;
  const trimmed = {};
  for (const key of keys.slice(-keepCount)) {
    trimmed[key] = obj[key];
  }
  return trimmed;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parsePricingFromText(text) {
  const cleaned = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const rows = [
    { name: 'Claude Opus 4.5', key: 'claude-opus-4-5*' },
    { name: 'Claude Opus 4.1', key: 'claude-opus-4-1*' },
    { name: 'Claude Opus 4', key: 'claude-opus-4*' },
    { name: 'Claude Sonnet 4.5', key: 'claude-sonnet-4-5*' },
    { name: 'Claude Sonnet 4', key: 'claude-sonnet-4*' },
    { name: 'Claude Sonnet 3.7 (deprecated)', key: 'claude-sonnet-3-7*' },
    { name: 'Claude Haiku 4.5', key: 'claude-haiku-4-5*' },
    { name: 'Claude Haiku 3.5', key: 'claude-haiku-3-5*' },
    { name: 'Claude Opus 3 (deprecated)', key: 'claude-opus-3*' },
    { name: 'Claude Haiku 3', key: 'claude-haiku-3*' },
  ];
  const models = {};
  for (const row of rows) {
    const pattern = new RegExp(
      `${escapeRegex(row.name)}\\s+\\$([0-9.]+)\\s*/\\s*MTok\\s+\\$([0-9.]+)\\s*/\\s*MTok\\s+\\$([0-9.]+)\\s*/\\s*MTok\\s+\\$([0-9.]+)\\s*/\\s*MTok\\s+\\$([0-9.]+)\\s*/\\s*MTok`,
      'i'
    );
    const match = cleaned.match(pattern);
    if (!match) continue;
    const input = Number(match[1]);
    const output = Number(match[5]);
    if (!Number.isFinite(input) || !Number.isFinite(output)) continue;
    models[row.key] = { input, output };
  }
  return models;
}

async function refreshPricingIfStale(pricingPath) {
  const pricing = await readJsonSafe(pricingPath);
  const now = Date.now();
  const updatedAt = pricing?.updatedAt ? Date.parse(pricing.updatedAt) : NaN;
  const lastAttempt = pricing?.lastRefreshAttempt
    ? Date.parse(pricing.lastRefreshAttempt)
    : NaN;
  const maxAgeMs = PRICING_REFRESH_DAYS * 24 * 60 * 60 * 1000;
  const retryMs = PRICING_REFRESH_RETRY_HOURS * 60 * 60 * 1000;
  const stale = Number.isNaN(updatedAt) || now - updatedAt > maxAgeMs;
  const canRetry = Number.isNaN(lastAttempt) || now - lastAttempt > retryMs;
  if (!stale || !canRetry) return pricing;

  let nextPricing = pricing || {};
  nextPricing.lastRefreshAttempt = new Date(now).toISOString();

  try {
    const response = await fetch('https://platform.claude.com/docs/en/about-claude/pricing', {
      method: 'GET',
      headers: {
        Accept: 'text/html',
        'User-Agent': 'claude-keepalive-status-toolbar',
      },
    });
    if (!response.ok) throw new Error('pricing fetch failed');
    const html = await response.text();
    const models = parsePricingFromText(html);
    if (!Object.keys(models).length) throw new Error('pricing parse failed');
    nextPricing = {
      source: 'https://platform.claude.com/docs/en/about-claude/pricing',
      updatedAt: new Date(now).toISOString(),
      lastRefreshAttempt: nextPricing.lastRefreshAttempt,
      cache: {
        readMultiplier: 0.1,
        writeMultiplier5m: 1.25,
        writeMultiplier1h: 2,
        writeMode: '5m',
      },
      models,
    };
  } catch {
    // keep existing pricing
  }

  try {
    await mkdir(path.dirname(pricingPath), { recursive: true, mode: 0o700 });
    await writeFile(pricingPath, JSON.stringify(nextPricing, null, 2), { mode: 0o600 });
  } catch {
    // ignore
  }

  return nextPricing;
}

function getCostSource() {
  const raw = process.env.USAGE_COST_SOURCE || DEFAULT_COST_SOURCE;
  return raw.toLowerCase();
}

function splitCommand(cmd) {
  const parts = [];
  let current = '';
  let quote = null;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ' ') {
      if (current) {
        parts.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (current) parts.push(current);
  return parts;
}

function resolveCcusageCommand() {
  const cmdRaw = process.env.CCUSAGE_CMD || 'ccusage';
  const base = splitCommand(cmdRaw);
  if (!base.length) return null;
  const cmd = base[0];
  if (cmd.includes('/') && existsSync(cmd)) return base;
  if (existsSync(cmd)) return base;
  const candidates = ['/opt/homebrew/bin/ccusage', '/usr/local/bin/ccusage', '/usr/bin/ccusage'];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return [candidate, ...base.slice(1)];
    }
  }
  return base;
}

function runCcusage(args) {
  const cmdRaw = process.env.CCUSAGE_CMD || 'ccusage';
  const base = resolveCcusageCommand() || splitCommand(cmdRaw);
  if (!base.length) return null;
  const extraArgs = process.env.CCUSAGE_ARGS ? splitCommand(process.env.CCUSAGE_ARGS) : [];
  const pathParts = [
    process.env.PATH,
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
  ].filter(Boolean);
  const env = { ...process.env, PATH: Array.from(new Set(pathParts)).join(':') };
  const result = spawnSync(base[0], [...base.slice(1), ...extraArgs, ...args], {
    encoding: 'utf-8',
    timeout: 10000,
    env,
  });
  if (result.error || result.status !== 0) return null;
  const output = (result.stdout || '').trim();
  if (!output) return null;
  return output;
}

async function readCcusageCache(maxAgeMinutes) {
  try {
    const raw = await readFile(CCUSAGE_CACHE_PATH, 'utf-8');
    const payload = JSON.parse(raw);
    const ts = typeof payload.timestamp === 'number' ? payload.timestamp : null;
    if (!ts) return null;
    const ageMs = Date.now() - ts;
    const maxAgeMs = maxAgeMinutes * 60 * 1000;
    if (ageMs > maxAgeMs) return null;
    return payload.data || null;
  } catch {
    return null;
  }
}

async function writeCcusageCache(data) {
  try {
    await mkdir(CACHE_DIR, { recursive: true, mode: 0o700 });
    await writeFile(
      CCUSAGE_CACHE_PATH,
      JSON.stringify({ timestamp: Date.now(), data }, null, 2),
      { mode: 0o600 }
    );
  } catch {
    // ignore
  }
}

function extractCostValue(row) {
  if (typeof row?.costUSD === 'number') return row.costUSD;
  if (typeof row?.totalCostUSD === 'number') return row.totalCostUSD;
  if (typeof row?.totalCost === 'number') return row.totalCost;
  if (typeof row?.totalCostUSD === 'string') return Number(row.totalCostUSD) || 0;
  if (typeof row?.totalCost === 'string') return Number(row.totalCost) || 0;
  return 0;
}

function parseCcusageDaily(payload) {
  const rows = Array.isArray(payload?.data)
    ? payload.data
    : Array.isArray(payload?.daily)
    ? payload.daily
    : [];
  return rows
    .filter((row) => typeof row?.date === 'string')
    .map((row) => ({
      date: row.date,
      costUSD: extractCostValue(row),
      inputTokens: Number(row.inputTokens) || 0,
      outputTokens: Number(row.outputTokens) || 0,
      cacheReadTokens: Number(row.cacheReadTokens) || 0,
      cacheCreationTokens: Number(row.cacheCreationTokens) || 0,
    }));
}

function groupMonthlyFromDaily(dailyRows) {
  const buckets = {};
  for (const row of dailyRows) {
    if (!row?.date) continue;
    const monthKey = row.date.slice(0, 7);
    if (!buckets[monthKey]) {
      buckets[monthKey] = {
        month: monthKey,
        costUSD: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      };
    }
    const bucket = buckets[monthKey];
    bucket.costUSD += row.costUSD || 0;
    bucket.inputTokens += row.inputTokens || 0;
    bucket.outputTokens += row.outputTokens || 0;
    bucket.cacheReadTokens += row.cacheReadTokens || 0;
    bucket.cacheCreationTokens += row.cacheCreationTokens || 0;
  }
  return Object.values(buckets).sort((a, b) => a.month.localeCompare(b.month));
}

function computeCcusageSummary(dailyRows, monthlyRows, now) {
  const dailySorted = [...dailyRows].sort((a, b) => a.date.localeCompare(b.date));
  const last3 = dailySorted.slice(-3);
  const last3Cost = last3.reduce((sum, row) => sum + (row.costUSD || 0), 0);
  const dayKey = toLocalDateKey(now);
  const todayRow = dailySorted.find((row) => row.date === dayKey);
  const dayCost = todayRow ? todayRow.costUSD || 0 : 0;
  const monthKey = toLocalMonthKey(now);
  let monthCost = 0;
  const monthMatch = monthlyRows.find((row) => row.month === monthKey);
  if (monthMatch) monthCost = monthMatch.costUSD || 0;
  else if (monthlyRows.length) monthCost = monthlyRows[monthlyRows.length - 1].costUSD || 0;
  const allTimeCost = monthlyRows.reduce((sum, row) => sum + (row.costUSD || 0), 0);
  return { last3Cost, dayCost, dayKey, monthCost, monthKey, allTimeCost };
}

async function fetchCcusageSummary(now) {
  const cacheMinutes = Number(process.env.CCUSAGE_CACHE_MINUTES || DEFAULT_CCUSAGE_CACHE_MINUTES);
  if (Number.isFinite(cacheMinutes) && cacheMinutes > 0) {
    const cached = await readCcusageCache(cacheMinutes);
    if (cached) {
      if (typeof cached.dayCost !== 'number') {
        const dayKey = cached.dayKey || toLocalDateKey(now);
        const dailyRows = Array.isArray(cached.dailyRows) ? cached.dailyRows : [];
        const todayRow = dailyRows.find((row) => row.date === dayKey);
        cached.dayKey = dayKey;
        cached.dayCost = todayRow ? todayRow.costUSD || 0 : 0;
      }
      if (typeof cached.allTimeCost !== 'number') {
        const monthlyRows = Array.isArray(cached.monthlyRows) ? cached.monthlyRows : [];
        cached.allTimeCost = monthlyRows.reduce((sum, row) => sum + (row.costUSD || 0), 0);
      }
      return cached;
    }
  }

  const dailyRaw = runCcusage(['daily', '--json']);
  if (!dailyRaw) return null;

  let dailyPayload = null;
  try {
    dailyPayload = JSON.parse(dailyRaw);
  } catch {
    return null;
  }

  const dailyRows = parseCcusageDaily(dailyPayload);
  const monthlyRows = groupMonthlyFromDaily(dailyRows);
  if (!dailyRows.length && !monthlyRows.length) return null;

  const summary = computeCcusageSummary(dailyRows, monthlyRows, now);
  const data = {
    source: 'ccusage',
    last3Cost: summary.last3Cost,
    dayCost: summary.dayCost,
    dayKey: summary.dayKey,
    monthCost: summary.monthCost,
    monthKey: summary.monthKey,
    allTimeCost: summary.allTimeCost,
    dailyRows,
    monthlyRows,
  };
  await writeCcusageCache(data);
  return data;
}

export async function updateUsageHistory(options = {}) {
  const statsPath = options.statsPath || process.env.CLAUDE_STATS_CACHE_PATH || DEFAULT_STATS_PATH;
  const historyPath = options.historyPath || DEFAULT_HISTORY_PATH;
  const pricingPath = options.pricingPath || process.env.CLAUDE_PRICING_PATH || DEFAULT_PRICING_PATH;
  const now = options.now instanceof Date ? options.now : new Date();
  const costSource = getCostSource();

  const stats = await readJsonSafe(statsPath);
  const ccusageSummary = costSource === 'ccusage' ? await fetchCcusageSummary(now) : null;

  const pricing =
    costSource === 'pricing' ? await refreshPricingIfStale(pricingPath) : await readJsonSafe(pricingPath);
  const history = (await readJsonSafe(historyPath)) || { version: 1, daily: {}, monthly: {} };

  if (costSource === 'ccusage') {
    if (!ccusageSummary) {
      return { ok: false, reason: 'ccusage_missing', historyPath };
    }
    const todayKey = toLocalDateKey(now);
    const currentMonthKey = toLocalMonthKey(now);

    if (ccusageSummary.dailyRows) {
      for (const row of ccusageSummary.dailyRows) {
        const isPastDay = row.date < todayKey;
        const existing = history.daily[row.date];
        if (isPastDay && existing) continue;
        history.daily[row.date] = {
          ...existing,
          costUSD: row.costUSD,
          source: 'ccusage',
          updatedAt: now.toISOString(),
        };
      }
    }

    if (ccusageSummary.monthlyRows) {
      for (const row of ccusageSummary.monthlyRows) {
        const isPastMonth = row.month < currentMonthKey;
        const existing = history.monthly[row.month];
        if (isPastMonth && existing) continue;
        history.monthly[row.month] = {
          ...existing,
          costUSD: row.costUSD,
          source: 'ccusage',
          updatedAt: now.toISOString(),
        };
      }
    }

    history.lastUpdated = now.toISOString();
    history.daily = trimHistoryKeys(history.daily, 120);
    history.monthly = trimHistoryKeys(history.monthly, 24);

    await mkdir(path.dirname(historyPath), { recursive: true, mode: 0o700 });
    await writeFile(historyPath, JSON.stringify(history, null, 2), { mode: 0o600 });

    const summary = summarizeUsage(history, now);
    summary.ok = true;
    summary.source = 'ccusage';
    summary.missingPricing = [];
    summary.pricingLoaded = true;
    summary.historyPath = historyPath;
    return summary;
  }

  if (costSource !== 'pricing') {
    return { ok: false, reason: 'invalid_cost_source', historyPath };
  }

  if (!stats?.modelUsage) {
    return { ok: false, reason: 'stats_missing', historyPath };
  }

  const totals = normalizeTotals(stats.modelUsage);
  const lastTotals = history.lastTotals?.models || {};
  const deltaByModel = {};
  let deltaFound = false;

  for (const [model, current] of Object.entries(totals)) {
    const prev = lastTotals[model] || {};
    const delta = {
      input: clampDelta(current.input, prev.input),
      output: clampDelta(current.output, prev.output),
      cacheRead: clampDelta(current.cacheRead, prev.cacheRead),
      cacheWrite: clampDelta(current.cacheWrite, prev.cacheWrite),
    };
    const hasDelta = TOKEN_KEYS.some((key) => delta[key] > 0);
    if (hasDelta) deltaFound = true;
    deltaByModel[model] = delta;
  }

  history.lastTotals = { models: totals };
  history.lastUpdated = now.toISOString();

  if (deltaFound) {
    const dayKey = toLocalDateKey(now);
    const monthKey = toLocalMonthKey(now);
    const dayBucket = history.daily[dayKey] || { models: {}, costUSD: 0 };
    const monthBucket = history.monthly[monthKey] || { models: {}, costUSD: 0 };

    for (const [model, delta] of Object.entries(deltaByModel)) {
      addModelTokens(dayBucket, model, delta);
      addModelTokens(monthBucket, model, delta);
    }

    const cost = computeCost(deltaByModel, pricing);
    dayBucket.costUSD = (dayBucket.costUSD || 0) + cost.total;
    monthBucket.costUSD = (monthBucket.costUSD || 0) + cost.total;
    dayBucket.missingPricing = cost.missing;
    monthBucket.missingPricing = cost.missing;

    history.daily[dayKey] = dayBucket;
    history.monthly[monthKey] = monthBucket;
  }

  history.daily = trimHistoryKeys(history.daily, 120);
  history.monthly = trimHistoryKeys(history.monthly, 24);

  await mkdir(path.dirname(historyPath), { recursive: true, mode: 0o700 });
  await writeFile(historyPath, JSON.stringify(history, null, 2), { mode: 0o600 });

  const summary = summarizeUsage(history, now, pricing);
  summary.historyPath = historyPath;
  summary.pricingLoaded = !!pricing;
  return summary;
}

export function summarizeUsage(history, now = new Date(), pricing = null) {
  const dayKey = toLocalDateKey(now);
  const monthKey = toLocalMonthKey(now);
  const dailyKeys = Object.keys(history?.daily || {}).sort();
  const last3 = dailyKeys.slice(-3);
  const last3Cost = last3.reduce((sum, key) => sum + (history.daily[key]?.costUSD || 0), 0);
  const monthCost = history?.monthly?.[monthKey]?.costUSD || 0;
  const dayCost = history?.daily?.[dayKey]?.costUSD || 0;
  const allTimeCost = Object.values(history?.monthly || {}).reduce(
    (sum, entry) => sum + (entry?.costUSD || 0),
    0
  );

  const missing = new Set();
  if (pricing) {
    for (const key of last3) {
      const models = history.daily[key]?.models || {};
      for (const model of Object.keys(models)) {
        if (!resolvePricing(model, pricing)) missing.add(model);
      }
    }
    const monthModels = history?.monthly?.[monthKey]?.models || {};
    for (const model of Object.keys(monthModels)) {
      if (!resolvePricing(model, pricing)) missing.add(model);
    }
  } else {
    for (const key of last3) {
      (history.daily[key]?.missingPricing || []).forEach((model) => missing.add(model));
    }
    (history?.monthly?.[monthKey]?.missingPricing || []).forEach((model) => missing.add(model));
  }

  return {
    ok: true,
    dayKey,
    monthKey,
    dayCost,
    last3Cost,
    monthCost,
    allTimeCost,
    missingPricing: Array.from(missing),
    historyPath: history?.historyPath || null,
  };
}

export async function updateUsageHistoryCli() {
  const summary = await updateUsageHistory();
  if (!summary?.ok) {
    console.error(JSON.stringify({ ok: false, reason: summary?.reason || 'unknown' }));
    process.exit(1);
  }
  console.log(JSON.stringify(summary, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  updateUsageHistoryCli().catch((err) => {
    console.error(JSON.stringify({ ok: false, reason: err?.message || 'error' }));
    process.exit(1);
  });
}
