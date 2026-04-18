import express from 'express';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { insertUsageRecord, getUsageHistory, getAllModelsHistory, getModelsWithLimits, getPreference, setPreference } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, '.env');

let envVars = {};
try {
  const envContent = readFileSync(envPath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
    envVars[key] = val;
  }
} catch {
  console.warn('No .env file found, using defaults');
}

// Provider configuration: env var prefix -> API details
const PROVIDER_CONFIG = {
  zai: {
    prefix: 'zai_',
    baseUrl: 'https://api.z.ai',
    path: '/api/monitor/usage/quota/limit',
    authStyle: 'raw',  // Authorization: <value> (no Bearer)
  },
  minig: {
    prefix: 'minig_',
    baseUrl: 'https://api.minimax.io',
    path: '/v1/api/openplatform/coding_plan/remains',
    authStyle: 'bearer',
  },
  minic: {
    prefix: 'minic_',
    baseUrl: 'https://api.minimaxi.com',
    path: '/v1/api/openplatform/coding_plan/remains',
    authStyle: 'bearer',
  },
};

// Discover API keys from env vars based on prefix
function discoverProviderKeys(env) {
  const keys = [];
  let hasMinimaxPrefix = false;

  for (const [envKey, envValue] of Object.entries(env)) {
    for (const [provider, config] of Object.entries(PROVIDER_CONFIG)) {
      if (envKey.startsWith(config.prefix)) {
        keys.push({ provider, key: envKey, value: envValue, config });
        if (provider === 'minig' || provider === 'minic') hasMinimaxPrefix = true;
        break;
      }
    }
  }

  // Legacy fallback: if API_KEY is set but no minimax prefix keys exist
  if (!hasMinimaxPrefix && env.API_KEY) {
    const apiBase = env.API_BASE || 'https://api.minimaxi.com';
    keys.push({
      provider: 'legacy',
      key: 'API_KEY',
      value: env.API_KEY,
      config: {
        baseUrl: apiBase,
        path: '/v1/api/openplatform/coding_plan/remains',
        authStyle: 'bearer',
      },
    });
  }

  return keys;
}

const providerKeys = discoverProviderKeys(envVars);
const PORT = envVars.PORT || 3000;

const app = express();
app.use(express.static(resolve(__dirname, 'public')));

// Log discovered providers at startup
console.log('Discovered API providers:');
if (providerKeys.length === 0) {
  console.warn('  WARNING: No API keys found. Add zai_*, minig_*, or minic_* keys to .env');
} else {
  providerKeys.forEach(pk => {
    console.log(`  ${pk.key} -> ${pk.provider} (${pk.config.baseUrl})`);
  });
}

// Fetch quota from a single provider with timeout
async function fetchProviderQuota({ provider, key, value, config }) {
  const url = `${config.baseUrl}${config.path}`;
  const headers = { 'Content-Type': 'application/json' };
  if (config.authStyle === 'bearer') {
    headers['Authorization'] = `Bearer ${value}`;
  } else {
    headers['Authorization'] = value;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
    }
    let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error(`Non-JSON response from ${provider}: ${text.slice(0, 200)}`);
      }
      return { provider, key, rawData: parsed };
  } finally {
    clearTimeout(timeout);
  }
}

// Normalize Minimax response (minig/minic/legacy) to unified format
function normalizeMinimaxResponse(rawData, provider) {
  const items = rawData.model_remains || rawData.data || [];
  const itemArray = Array.isArray(items) ? items : [items];
  return itemArray.map(item => ({
    ...item,
    _provider: provider,
  }));
}

// Normalize Z.ai response to Minimax-compatible format
function normalizeZaiResponse(rawData) {
  const limits = rawData?.data?.limits || rawData?.limits || [];
  if (!Array.isArray(limits) || limits.length === 0) {
    console.warn('[Z.ai] Unexpected response structure:', JSON.stringify(rawData).slice(0, 500));
    return [];
  }

  const now = Date.now();
  return limits.map(limit => {
    const type = limit.type || 'unknown';
    const hasExplicitCounts = typeof limit.usage === 'number' && typeof limit.remaining === 'number';

    let total, remaining, used;
    if (hasExplicitCounts) {
      total = limit.usage;           // Z.ai "usage" = total limit
      remaining = limit.remaining;   // Z.ai "remaining" = remaining
      used = limit.currentValue || (total - remaining);
    } else {
      // Only percentage available (e.g., TOKENS_LIMIT)
      total = 100;
      remaining = 100 - (limit.percentage || 0);
      used = limit.percentage || 0;
    }

    const resetTime = limit.nextResetTime || (now + 3600000);
    const remainsTime = Math.max(0, resetTime - now);
    // Derive start_time from end_time and an estimated interval duration
    // If remains_time is large, assume interval is the full duration so far
    const estimatedIntervalMs = remainsTime > 0 ? Math.max(remainsTime, 3600000) : 3600000;

    return {
      model_name: `Z.ai - ${type}${(limit.unit != null && limit.number != null) ? ' (x' + limit.number + ')' : ''}`,
      current_interval_total_count: total,
      current_interval_usage_count: remaining,
      current_weekly_total_count: 0,
      current_weekly_usage_count: 0,
      remains_time: remainsTime,
      start_time: resetTime - estimatedIntervalMs,
      end_time: resetTime,
      weekly_remains_time: null,
      weekly_start_time: null,
      weekly_end_time: null,
      _provider: 'zai',
      _zaiDetails: limit.usageDetails || null,
      _zaiLevel: rawData?.data?.level || null,
    };
  });
}

// Route normalization by provider
function normalizeQuotaResponse(provider, rawData) {
  if (provider === 'zai') {
    return normalizeZaiResponse(rawData);
  }
  return normalizeMinimaxResponse(rawData, provider);
}

app.get('/api/version', (req, res) => {
  const { version } = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8'));
  res.json({ version });
});

app.get('/api/quota', async (req, res) => {
  if (providerKeys.length === 0) {
    return res.status(500).json({ error: 'No API keys configured. Add zai_*, minig_*, or minic_* keys to .env' });
  }

  const results = await Promise.allSettled(
    providerKeys.map(pk => fetchProviderQuota(pk))
  );

  const allModels = [];
  const errors = [];

  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      try {
        const normalized = normalizeQuotaResponse(r.value.provider, r.value.rawData);
        allModels.push(...normalized);
      } catch (err) {
        errors.push({ provider: providerKeys[i].provider, key: providerKeys[i].key, error: `Normalization failed: ${err.message}` });
      }
    } else {
      errors.push({ provider: providerKeys[i].provider, key: providerKeys[i].key, error: r.reason?.message || String(r.reason) });
    }
  });

  if (allModels.length === 0 && errors.length > 0) {
    return res.status(502).json({ error: 'All providers failed', details: errors });
  }

  // Insert history records for models with limits
  for (const item of allModels) {
    if (item && item.current_interval_total_count > 0) {
      const limit = item.current_interval_total_count;
      const remaining = item.current_interval_usage_count;
      const used = Math.max(0, limit - remaining);
      const percentUsed = (used / limit) * 100;
      insertUsageRecord(item.model_name, used, limit, percentUsed, item._provider || 'unknown');
    }
  }

  res.json({
    model_remains: allModels,
    ...(errors.length > 0 ? { _errors: errors } : {}),
  });
});

app.get('/api/history', (req, res) => {
  const hours = parseInt(req.query.hours) || 24;
  const endTime = Date.now();
  const startTime = endTime - (hours * 60 * 60 * 1000);

  const history = getAllModelsHistory(startTime, endTime);
  res.json(history);
});

app.get('/api/models-with-limits', (req, res) => {
  const models = getModelsWithLimits();
  res.json(models);
});

app.get('/api/preferences/hidden-models', (req, res) => {
  const value = getPreference('hiddenModels');
  res.json(value || []);
});

app.put('/api/preferences/hidden-models', express.json(), (req, res) => {
  const { hiddenModels } = req.body;
  if (!Array.isArray(hiddenModels)) {
    return res.status(400).json({ error: 'hiddenModels must be an array' });
  }
  setPreference('hiddenModels', hiddenModels);
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Quota dashboard running at http://localhost:${PORT}`);
});
