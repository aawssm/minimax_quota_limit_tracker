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

const API_KEY = envVars.API_KEY || process.env.API_KEY;
const API_BASE = envVars.API_BASE || 'https://api.minimaxi.com';
const PORT = envVars.PORT || 3000;

const app = express();

app.use(express.static(__dirname));

app.get('/api/quota', async (req, res) => {
  if (!API_KEY) {
    return res.status(500).json({ error: 'API_KEY not configured in .env' });
  }

  try {
    const url = `${API_BASE}/v1/api/openplatform/coding_plan/remains`;
    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
      },
    });

    const text = await response.text();
    if (!response.ok) {
      return res.status(response.status).send(text);
    }

    // Parse response and insert usage records for models with limits
    try {
      const data = JSON.parse(text);
      const items = data.model_remains || data.data || [];
      const itemArray = Array.isArray(items) ? items : [items];
      for (const item of itemArray) {
        if (item && item.current_interval_total_count > 0) {
          const limit = item.current_interval_total_count;
          const remaining = item.current_interval_usage_count;
          const used = Math.max(0, limit - remaining);
          const percentUsed = (used / limit) * 100;
          insertUsageRecord(
            item.model_name,
            used,
            limit,
            percentUsed
          );
        }
      }
    } catch (parseErr) {
      console.warn('Failed to parse quota response for history:', parseErr);
    }

    res.setHeader('Content-Type', 'application/json');
    res.send(text);
  } catch (err) {
    console.error('Proxy error:', err);
    res.status(500).send(err.message);
  }
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
  if (!API_KEY) {
    console.warn('Warning: API_KEY not set in .env - API calls will fail');
  }
});