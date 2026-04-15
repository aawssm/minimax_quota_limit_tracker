import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = join(__dirname, 'data', 'usage_history.db');

// Ensure data directory exists
mkdirSync(join(__dirname, 'data'), { recursive: true });

const db = new Database(dbPath);

// Create table
db.exec(`
  CREATE TABLE IF NOT EXISTS usage_history (
    id INTEGER PRIMARY KEY,
    model_name TEXT NOT NULL,
    model_id TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    usage_count INTEGER NOT NULL,
    limit_count INTEGER NOT NULL,
    percent_used REAL NOT NULL
  )
`);

// Create index on (model_name, timestamp)
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_model_timestamp ON usage_history (model_name, timestamp)
`);

// Create preferences table
db.exec(`
  CREATE TABLE IF NOT EXISTS preferences (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )
`);

function getPreference(key) {
  const stmt = db.prepare('SELECT value FROM preferences WHERE key = ?');
  const row = stmt.get(key);
  if (!row) return null;
  try {
    return JSON.parse(row.value);
  } catch {
    return null;
  }
}

function setPreference(key, value) {
  const stmt = db.prepare('INSERT OR REPLACE INTO preferences (key, value) VALUES (?, ?)');
  stmt.run(key, JSON.stringify(value));
}

// Generate a simple hash from model name for model_id
function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36);
}

function insertUsageRecord(modelName, usageCount, limitCount, percentUsed) {
  const modelId = hashString(modelName);
  const stmt = db.prepare(`
    INSERT INTO usage_history (model_name, model_id, timestamp, usage_count, limit_count, percent_used)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  return stmt.run(modelName, modelId, Date.now(), usageCount, limitCount, percentUsed);
}

function getUsageHistory(modelName, startTime, endTime) {
  const stmt = db.prepare(`
    SELECT timestamp, usage_count AS used_count, limit_count, percent_used
    FROM usage_history
    WHERE model_name = ? AND timestamp >= ? AND timestamp <= ?
    ORDER BY timestamp ASC
  `);
  return stmt.all(modelName, startTime, endTime);
}

function getAllModelsHistory(startTime, endTime) {
  const stmt = db.prepare(`
    SELECT model_id, model_name, timestamp, usage_count AS used_count, limit_count, percent_used
    FROM usage_history
    WHERE timestamp >= ? AND timestamp <= ?
    ORDER BY model_name, timestamp ASC
  `);
  return stmt.all(startTime, endTime);
}

function getModelsWithLimits() {
  const stmt = db.prepare(`
    SELECT DISTINCT model_name, model_id, limit_count AS current_interval_total_count
    FROM usage_history
    WHERE limit_count > 0
  `);
  return stmt.all();
}

export { insertUsageRecord, getUsageHistory, getAllModelsHistory, getModelsWithLimits, getPreference, setPreference };
