const API_BASE = window.location.origin;
let refreshTimer = null;
let hiddenModels = new Set();

// Dark mode
const themeBtn = document.getElementById('themeBtn');
const themes = ['system', 'light', 'dark'];
let themeIndex = 0;

// Rate display mode: 'percent' or 'absolute'
let rateMode = 'percent';
let cachedData = null;
const rateToggleBtn = document.getElementById('rateToggleBtn');
rateToggleBtn.addEventListener('click', () => {
  rateMode = rateMode === 'percent' ? 'absolute' : 'percent';
  rateToggleBtn.textContent = rateMode === 'percent' ? '% / hr' : 'req / hr';
  if (cachedData) {
    renderFromCache(cachedData);
  }
});

function applyTheme(theme) {
  if (theme === 'system') {
    document.documentElement.removeAttribute('data-theme');
  } else {
    document.documentElement.setAttribute('data-theme', theme);
  }
  const icon = theme === 'dark' ? '&#9790;' : theme === 'light' ? '&#9788;' : '&#9788;';
  themeBtn.innerHTML = icon;
}

const savedTheme = localStorage.getItem('theme');
if (savedTheme) {
  themeIndex = themes.indexOf(savedTheme);
  if (themeIndex === -1) themeIndex = 0;
}
applyTheme(themes[themeIndex]);

themeBtn.addEventListener('click', () => {
  themeIndex = (themeIndex + 1) % themes.length;
  const current = themes[themeIndex];
  localStorage.setItem('theme', current);
  applyTheme(current);
});

async function fetchQuota() {
  const errorEl = document.getElementById('error');
  const loadingEl = document.getElementById('loading');
  const cardsEl = document.getElementById('cards');
  const emptyEl = document.getElementById('empty');
  const footerEl = document.getElementById('footer');
  const statusDot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');
  statusDot.classList.add('loading');
  statusText.textContent = 'Updating...';

  try {
    const res = await fetch(`${API_BASE}/api/quota`);
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    const data = await res.json();
    cachedData = data;
    processAndRender(data);
  } catch (err) {
    errorEl.textContent = `Failed to fetch quota: ${err.message}`;
    errorEl.style.display = 'block';
    loadingEl.style.display = 'none';
    statusText.textContent = 'Error';
  } finally {
    statusDot.classList.remove('loading');
    statusDot.classList.add('ready');
    statusText.textContent = 'Ready';
  }
}

function processAndRender(data) {
  const loadingEl = document.getElementById('loading');
  const cardsEl = document.getElementById('cards');
  const emptyEl = document.getElementById('empty');
  const footerEl = document.getElementById('footer');

  // Show/clear partial failure warnings
  const errorEl = document.getElementById('error');
  if (data._errors && data._errors.length > 0) {
    errorEl.textContent = `Partial failure: ${data._errors.map(e => `${e.provider}: ${e.error}`).join('; ')}`;
    errorEl.style.display = 'block';
  } else {
    errorEl.style.display = 'none';
  }

  const models = data.model_remains || [];
  if (models.length === 0) {
    loadingEl.style.display = 'none';
    emptyEl.style.display = 'block';
  } else {
    const available = models.filter(m => m.current_interval_total_count > 0);
    const unavailable = models.filter(m => m.current_interval_total_count === 0);

    if (available.length === 0 && unavailable.length > 0) {
      emptyEl.querySelector('h3').textContent = 'No Usable Quota';
      emptyEl.querySelector('p').textContent = 'All models have zero quota limit.';
      emptyEl.style.display = 'block';
      cardsEl.style.display = 'none';
    } else if (available.length > 0) {
      renderCards(available);
      cardsEl.style.display = 'grid';
      emptyEl.style.display = 'none';
    }

    if (unavailable.length > 0) {
      renderUnavailableModels(unavailable);
      document.getElementById('unavailableSection').style.display = 'block';
      document.getElementById('unavailableCount').textContent = unavailable.length;
    } else {
      document.getElementById('unavailableSection').style.display = 'none';
    }
  }
  footerEl.textContent = `Last updated: ${new Date().toLocaleString()}`;

  // Also update the chart when quota data refreshes
  if (typeof renderChart === 'function') {
    renderChart();
  }
}

function renderFromCache(data) {
  const available = (data.model_remains || []).filter(m => m.current_interval_total_count > 0);
  renderCards(available);
}

function renderCards(models) {
  const cardsEl = document.getElementById('cards');

  cardsEl.innerHTML = models.map(m => {
    const remaining = m.current_interval_usage_count;
    const limit = m.current_interval_total_count;
    const used = Math.max(0, limit - remaining);
    const percent = limit > 0 ? (used / limit) * 100 : 0;

    let progressClass = 'good';
    let badgeClass = 'high';
    if (percent > 90) {
      progressClass = 'danger';
      badgeClass = 'low';
    } else if (percent > 70) {
      progressClass = 'warning';
      badgeClass = 'medium';
    }

    const badgeText = percent > 90 ? 'Low' : percent > 70 ? 'Medium' : 'Good';

    const weekRemaining = m.current_weekly_usage_count;
    const weekLimit = m.current_weekly_total_count;
    const weekUsed = Math.max(0, weekLimit - weekRemaining);
    const weekPercent = weekLimit > 0 ? (weekUsed / weekLimit) * 100 : 0;

    // Weekly time calculations (secondary expiry)
    const weekResetIn = m.weekly_remains_time ? formatDuration(m.weekly_remains_time) : null;
    const weekDaysLeft = m.weekly_remains_time ? (m.weekly_remains_time / 86400000).toFixed(1) : null;

    // Weekly rate calculations
    let weekElapsedMs = 0;
    let weekTotalMs = 0;
    if (m.weekly_end_time && m.weekly_start_time) {
      weekTotalMs = m.weekly_end_time - m.weekly_start_time;
      weekElapsedMs = weekTotalMs - (m.weekly_remains_time || 0);
    }
    const weekRateOfUse = weekElapsedMs > 0 ? (weekPercent / (weekElapsedMs / 3600000)) : 0;
    const weekMaxRateOfUse = m.weekly_remains_time > 0 ? ((100 - weekPercent) / (m.weekly_remains_time / 3600000)) : 0;

    // Absolute weekly rate (requests per hour)
    const weekRateOfUseAbs = weekElapsedMs > 0 ? (weekUsed / (weekElapsedMs / 3600000)) : 0;
    const weekMaxRateOfUseAbs = m.weekly_remains_time > 0 ? (weekRemaining / (m.weekly_remains_time / 3600000)) : 0;

    const resetIn = formatDuration(m.remains_time);

    // Calculate interval duration from API times
    const totalIntervalMs = m.end_time - m.start_time;
    const intervalLabel = formatDurationShort(totalIntervalMs);
    const elapsedMs = totalIntervalMs - m.remains_time;

    // Rate calculations
    const rateOfUse = elapsedMs > 0 ? (percent / (elapsedMs / 3600000)) : 0;
    const maxRateOfUse = m.remains_time > 0 ? ((100 - percent) / (m.remains_time / 3600000)) : 0;

    // Absolute rate (requests per hour)
    const rateOfUseAbs = elapsedMs > 0 ? (used / (elapsedMs / 3600000)) : 0;
    const maxRateOfUseAbs = m.remains_time > 0 ? (remaining / (m.remains_time / 3600000)) : 0;

    function formatRate(pctVal, absVal) {
      if (rateMode === 'percent') {
        return pctVal.toFixed(2);
      } else {
        return absVal < 1000 ? absVal.toFixed(1) : (absVal / 1000).toFixed(1) + 'k';
      }
    }

    function rateLabel() {
      return rateMode === 'percent' ? '% / hr' : 'req / hr';
    }

    const isHidden = hiddenModels.has(m.model_name);

    const hasWeeklyData = weekLimit > 0;
    const weeklySectionHtml = hasWeeklyData ? `
        <div class="weekly-section">
          <div class="weekly-header">
            <span>Weekly${weekDaysLeft !== null ? ' · ' + weekDaysLeft + 'd left' : ''}</span>
            <span>${weekUsed.toLocaleString()} / ${weekLimit.toLocaleString()} · ${weekPercent.toFixed(1)}%</span>
          </div>
          <div class="weekly-bar">
            <div class="weekly-fill" style="width: ${Math.min(weekPercent, 100)}%"></div>
          </div>
          <div class="weekly-stats">
            <span>${formatRate(weekRateOfUse, weekRateOfUseAbs)} ${rateLabel()}</span>
            <span>max ${formatRate(weekMaxRateOfUse, weekMaxRateOfUseAbs)} ${rateLabel()}</span>
          </div>
        </div>
      ` : '';

    return `
      <div class="card ${isHidden ? 'hidden-card' : ''}" data-model-id="${escapeHtml(m.model_name)}">
        <div class="card-header">
          <div class="model-name">
            ${escapeHtml(m.model_name)}
            <span>Resets in ${resetIn}</span>
          </div>
          <div class="card-actions">
            <button class="visibility-toggle" data-model-id="${escapeHtml(m.model_name)}" title="${isHidden ? 'Show' : 'Hide'}">
              ${isHidden ? '&#128764;' : '&#128065;'}
            </button>
            <div class="quota-badge ${badgeClass}">${badgeText}</div>
          </div>
        </div>

        <div class="usage-section">
          <div class="usage-label">
            <span>${intervalLabel} Usage</span>
            <span>${used.toLocaleString()} / ${limit.toLocaleString()}</span>
          </div>
          <div class="progress-bar">
            <div class="progress-fill ${progressClass}" style="width: ${Math.min(percent, 100)}%"></div>
          </div>
        </div>

        <div class="stats-row">
          <div class="stat">
            <div class="stat-value">${formatRate(rateOfUse, rateOfUseAbs)}</div>
            <div class="stat-label">${rateLabel()}</div>
          </div>
          <div class="stat">
            <div class="stat-value">${percent.toFixed(1)}%</div>
            <div class="stat-label">Used</div>
          </div>
          <div class="stat">
            <div class="stat-value">${formatRate(maxRateOfUse, maxRateOfUseAbs)}</div>
            <div class="stat-label">max ${rateLabel()}</div>
          </div>
        </div>

        ${weeklySectionHtml}
      </div>
    `;
  }).join('');

}

// Event delegation for visibility toggles - handles dynamically created elements
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.visibility-toggle');
  if (!btn) return;

  const modelName = btn.dataset.modelId;
  if (hiddenModels.has(modelName)) {
    hiddenModels.delete(modelName);
  } else {
    hiddenModels.add(modelName);
  }
  fetch(`${API_BASE}/api/preferences/hidden-models`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hiddenModels: Array.from(hiddenModels) })
  }).catch(e => console.warn('Failed to save hidden models:', e));
  // Re-render cards and chart
  if (cachedData) {
    const available = (cachedData.model_remains || []).filter(m => m.current_interval_total_count > 0);
    renderCards(available);
    if (typeof renderChart === 'function') {
      renderChart();
    }
  }
});

function renderUnavailableModels(models) {
  const container = document.getElementById('unavailableModels');
  container.innerHTML = models.map(m => `
    <div class="card unavailable">
      <div class="card-header">
        <div class="model-name">
          ${escapeHtml(m.model_name)}
          <span>Total limit: 0</span>
        </div>
        <div class="unavailable-badge">Unavailable</div>
      </div>
    </div>
  `).join('');
}

document.getElementById('unavailableToggle').addEventListener('click', () => {
  const toggle = document.getElementById('unavailableToggle');
  const models = document.getElementById('unavailableModels');
  toggle.classList.toggle('open');
  models.classList.toggle('show');
});

function formatDuration(ms) {
  if (!ms || ms <= 0) return 'N/A';
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  if (hours > 24) return `${Math.floor(hours / 24)}d ${hours % 24}h`;
  return `${hours}h ${minutes}m`;
}

function formatDurationShort(ms) {
  if (!ms || ms <= 0) return 'N/A';
  const hours = Math.floor(ms / 3600000);
  if (hours >= 24) return `${Math.floor(hours / 24)}d`;
  return `${hours}hr`;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function startAutoRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  const interval = parseInt(document.getElementById('refreshInterval').value) || 5;
  refreshTimer = setInterval(fetchQuota, interval * 60 * 1000);
}

document.getElementById('refreshBtn').addEventListener('click', fetchQuota);
document.getElementById('refreshInterval').addEventListener('change', startAutoRefresh);

async function loadHiddenModels() {
  try {
    const res = await fetch(`${API_BASE}/api/preferences/hidden-models`);
    if (res.ok) {
      const data = await res.json();
      hiddenModels = new Set(data);
    }
  } catch (e) {
    console.warn('Failed to load hidden models preference:', e);
  }
}

loadHiddenModels().then(() => {
  fetchQuota().then(loadVersion);
  startAutoRefresh();
});

async function loadVersion() {
  try {
    const res = await fetch(`${API_BASE}/api/version`, { cache: 'no-store' });
    if (res.ok) {
      const { version } = await res.json();
      const footer = document.getElementById('footer');
      footer.textContent = footer.textContent ? `${footer.textContent} · v${version}` : `v${version}`;
    }
  } catch (e) {
    console.warn('Failed to load version:', e);
  }
}

// Chart.js related code
let usageChart = null;
let currentTimeRange = 8;
let chartModels = [];

// Color palette - at least 10 distinct colors
const colorPalette = [
  '#6366f1', // indigo
  '#10b981', // emerald
  '#f59e0b', // amber
  '#ef4444', // red
  '#8b5cf6', // violet
  '#06b6d4', // cyan
  '#f97316', // orange
  '#ec4899', // pink
  '#14b8a6', // teal
  '#84cc16', // lime
  '#a855f7', // purple
  '#3b82f6', // blue
];

function getModelColor(index) {
  return colorPalette[index % colorPalette.length];
}

async function fetchChartData(hours) {
  try {
    const [historyRes, modelsRes] = await Promise.all([
      fetch(`${API_BASE}/api/history?hours=${hours}`),
      fetch(`${API_BASE}/api/models-with-limits`)
    ]);

    if (!historyRes.ok) throw new Error(`History API ${historyRes.status}`);
    if (!modelsRes.ok) throw new Error(`Models API ${modelsRes.status}`);

    const history = await historyRes.json();
    const models = await modelsRes.json();

    return { history, models };
  } catch (err) {
    console.error('Failed to fetch chart data:', err);
    return { history: [], models: [] };
  }
}

function formatTimeLabel(timestamp, range) {
  const date = new Date(timestamp);
  if (range <= 24) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } else if (range <= 168) {
    return date.toLocaleDateString([], { weekday: 'short', hour: '2-digit' });
  } else {
    return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }
}

function buildChartDatasets(historyData, modelsWithLimits) {
  if (!modelsWithLimits || modelsWithLimits.length === 0) return [];

  // Group history by model_name (consistent with hiddenModels which uses model_name)
  const modelHistory = {};
  modelsWithLimits.forEach(m => {
    modelHistory[m.model_name] = {
      model_name: m.model_name,
      limit: m.current_interval_total_count,
      data: []
    };
  });

  // Process history entries - use model_name from history entry
  historyData.forEach(entry => {
    if (modelHistory[entry.model_name]) {
      const limit = modelHistory[entry.model_name].limit;
      const used = entry.used_count || 0;
      const percent = limit > 0 ? (used / limit) * 100 : 0;
      modelHistory[entry.model_name].data.push({
        x: entry.timestamp,
        y: Math.min(percent, 100)
      });
    }
  });

  // Build datasets - filter out hidden models using model_name
  let colorIndex = 0;
  return modelsWithLimits
    .filter(m => !hiddenModels.has(m.model_name))
    .filter(m => modelHistory[m.model_name] && modelHistory[m.model_name].data.length > 0)
    .map(m => {
      const color = getModelColor(colorIndex++);
      return {
        label: m.model_name,
        data: modelHistory[m.model_name].data,
        borderColor: color,
        backgroundColor: color + '20',
        borderWidth: 2,
        pointRadius: 0,
        pointHoverRadius: 6,
        pointHoverBackgroundColor: color,
        pointHoverBorderColor: '#fff',
        pointHoverBorderWidth: 2,
        tension: 0.3,
        fill: false,
        _color: color,
        _modelId: m.model_id
      };
    });
}

function getXAxisOptions(range) {
  const tickFormat = (value) => {
    const date = new Date(value);
    if (range <= 24) {
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } else if (range <= 168) {
      return date.toLocaleDateString([], { weekday: 'short', hour: '2-digit' });
    } else {
      return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
    }
  };
  if (range <= 24) {
    return {
      type: 'linear',
      ticks: {
        maxTicksLimit: 8,
        callback: function(value) { return tickFormat(value); }
      }
    };
  } else if (range <= 168) {
    return {
      type: 'linear',
      ticks: {
        maxTicksLimit: 7,
        callback: function(value) { return tickFormat(value); }
      }
    };
  } else {
    return {
      type: 'linear',
      ticks: {
        maxTicksLimit: 6,
        callback: function(value) { return tickFormat(value); }
      }
    };
  }
}

async function renderChart() {
  const chartSection = document.getElementById('chartSection');
  const chartNoData = document.getElementById('chartNoData');
  const canvas = document.getElementById('usageChart');

  const { history, models } = await fetchChartData(currentTimeRange);

  if (!history || history.length === 0 || !models || models.length === 0) {
    chartSection.style.display = 'block';
    chartNoData.style.display = 'flex';
    canvas.style.display = 'none';
    return;
  }

  chartNoData.style.display = 'none';
  canvas.style.display = 'block';
  chartSection.style.display = 'block';

  const datasets = buildChartDatasets(history, models);

  if (datasets.length === 0) {
    chartNoData.style.display = 'flex';
    canvas.style.display = 'none';
    return;
  }

  chartModels = datasets.map(d => ({ label: d.label, id: d._modelId }));

  const existingChart = Chart.getChart(canvas);
  if (existingChart) {
    existingChart.destroy();
  }

  const ctx = canvas.getContext('2d');

  usageChart = new Chart(ctx, {
    type: 'line',
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: 'index',
        intersect: false
      },
      plugins: {
        legend: {
          display: true,
          position: 'bottom',
          labels: {
            usePointStyle: true,
            padding: 20,
            font: { size: 12 }
          }
        },
        tooltip: {
          enabled: true,
          callbacks: {
            title: function(context) {
              if (context.length > 0) {
                const timestamp = context[0].parsed.x;
                const date = new Date(timestamp);
                if (currentTimeRange <= 8) {
                  return date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
                } else if (currentTimeRange <= 24) {
                  return date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
                } else if (currentTimeRange <= 168) {
                  return date.toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric' });
                } else {
                  return date.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
                }
              }
              return '';
            },
            label: function(context) {
              const pct = context.parsed.y;
              const pctStr = pct % 1 === 0 ? pct.toFixed(0) : pct.toFixed(1);
              return `${context.dataset.label}: ${pctStr}%`;
            }
          }
        }
      },
      scales: {
        x: getXAxisOptions(currentTimeRange),
        y: {
          min: 0,
          max: 100,
          title: {
            display: true,
            text: '% Used',
            font: { size: 12 }
          },
          ticks: {
            stepSize: 20,
            callback: function(value) {
              return value + '%';
            }
          }
        }
      },
      plugins: [{
        id: 'hoverStyler',
        afterEvent: (chart, args) => {
          const { event } = args;
          if (event.type === 'mousemove') {
            const elements = chart.getElementsAtEventForMode(event, 'point', { intersect: true }, false);
            if (elements.length === 0) {
              // Mouse is over chart area but not directly on a point - reset all lines and hide points
              chart.data.datasets.forEach(ds => {
                ds.borderColor = ds._color;
                ds.backgroundColor = ds._color + '20';
                ds.borderWidth = 2;
                ds.pointRadius = 0;
                ds.pointHoverRadius = 0;
              });
              chart.update('none');
            }
          }
        }
      }]
    }
  });

  // Mouse leave handler to reset all lines to full opacity
  canvas.addEventListener('mouseleave', () => {
    const chart = Chart.getChart(canvas);
    if (chart) {
      chart.data.datasets.forEach(ds => {
        ds.borderColor = ds._color;
        ds.backgroundColor = ds._color + '20';
        ds.borderWidth = 2;
        ds.pointRadius = 0;
        ds.pointHoverRadius = 0;
      });
      chart.update('none');
    }
  });

  // Additional mousemove handler to detect when mouse is in chart area but not over a point
  canvas.addEventListener('mousemove', (event) => {
    const chart = Chart.getChart(canvas);
    if (!chart) return;
    const elements = chart.getElementsAtEventForMode(event, 'point', { intersect: true }, false);
    if (elements.length === 0) {
      // Mouse is in chart area but not directly over any point - reset all lines and hide points
      chart.data.datasets.forEach(ds => {
        ds.borderColor = ds._color;
        ds.backgroundColor = ds._color + '20';
        ds.borderWidth = 2;
        ds.pointRadius = 0;
        ds.pointHoverRadius = 0;
      });
      chart.update('none');
    }
  });
}

// Time range button handlers
document.querySelectorAll('.time-range-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.time-range-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentTimeRange = parseInt(btn.dataset.hours);
    renderChart();
  });
});

// Initial chart render after a short delay to allow quota data to load first
setTimeout(renderChart, 500);
