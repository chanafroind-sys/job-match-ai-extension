'use strict';

const BACKEND   = 'https://job-match-ai-extension.onrender.com';
const TRACKER_KEY = 'jobTracker';

const PALETTE = [
  '#7c3aed','#2563eb','#0891b2','#16a34a',
  '#d97706','#ea580c','#db2777','#6366f1',
];

// ── Bootstrap ─────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  document.getElementById('dateNow').textContent =
    new Date().toLocaleDateString('he-IL', { year:'numeric', month:'long', day:'numeric' });

  const stored = await chrome.storage.local.get([TRACKER_KEY, 'licenseKey']);
  const jobs   = stored[TRACKER_KEY] || [];

  renderKPIs(jobs);
  renderFunnelChart(jobs);
  renderPlatformChart(jobs);
  loadMarketData(stored.licenseKey);

  document.getElementById('btnRefreshMarket').addEventListener('click', () => {
    loadMarketData(stored.licenseKey);
  });
});

// ── KPI cards ─────────────────────────────────────────────────────────────────
function renderKPIs(jobs) {
  const total      = jobs.length;
  const submitted  = jobs.filter(j => j.status === 'הגשתי').length;
  const cvGen      = jobs.filter(j => j.cvGenerated).length;
  const avgScore   = total
    ? Math.round(jobs.reduce((s, j) => s + (j.score || 0), 0) / total)
    : 0;

  document.getElementById('kpiTotal').textContent      = total;
  document.getElementById('kpiSubmitted').textContent  = submitted;
  document.getElementById('kpiCvGenerated').textContent = cvGen;
  document.getElementById('kpiAvgScore').textContent   = avgScore + '%';
}

// ── Shared canvas helpers ──────────────────────────────────────────────────────
function setupCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth  || canvas.width;
  const cssH = canvas.clientHeight || canvas.height;
  canvas.width  = cssW * dpr;
  canvas.height = cssH * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  return { ctx, W: cssW, H: cssH };
}

function roundRect(ctx, x, y, w, h, r) {
  if (w < 2 * r) r = w / 2;
  if (h < 2 * r) r = h / 2;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

// ── Funnel bar chart ───────────────────────────────────────────────────────────
function renderFunnelChart(jobs) {
  const canvas = document.getElementById('funnelCanvas');
  if (!canvas) return;

  const total     = jobs.length;
  const analyzed  = jobs.filter(j => (j.score || 0) > 0).length;
  const cvGen     = jobs.filter(j => j.cvGenerated).length;
  const submitted = jobs.filter(j => j.status === 'הגשתי').length;

  if (total === 0) {
    document.getElementById('funnelEmpty').style.display = 'block';
    canvas.style.display = 'none';
    return;
  }

  const stages = [
    { label: 'משרות שנצפו',  value: total,     color: PALETTE[0] },
    { label: 'ניתוח AI',      value: analyzed,  color: PALETTE[1] },
    { label: 'CV הוכן',       value: cvGen,     color: PALETTE[2] },
    { label: 'הוגש בפועל',   value: submitted, color: PALETTE[3] },
  ];

  const { ctx, W, H } = setupCanvas(canvas);
  const LABEL_W = 110;
  const VALUE_W = 55;
  const BAR_AREA = W - LABEL_W - VALUE_W - 16;
  const barH     = Math.floor((H - 20) / stages.length) - 10;
  const maxVal   = Math.max(total, 1);

  ctx.clearRect(0, 0, W, H);

  stages.forEach((s, i) => {
    const y       = 10 + i * (barH + 10);
    const filledW = Math.max((s.value / maxVal) * BAR_AREA, s.value > 0 ? 4 : 0);

    // Track
    ctx.fillStyle = 'rgba(255,255,255,0.05)';
    roundRect(ctx, LABEL_W, y, BAR_AREA, barH, 4);
    ctx.fill();

    // Bar with gradient
    if (filledW > 0) {
      const grad = ctx.createLinearGradient(LABEL_W, 0, LABEL_W + filledW, 0);
      grad.addColorStop(0, s.color);
      grad.addColorStop(1, s.color + 'bb');
      ctx.fillStyle = grad;
      roundRect(ctx, LABEL_W, y, filledW, barH, 4);
      ctx.fill();
    }

    // Label (right-aligned, RTL)
    ctx.fillStyle = '#c9d1d9';
    ctx.font = '12px -apple-system, Arial, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(s.label, LABEL_W - 8, y + barH / 2);

    // Value
    ctx.fillStyle = '#f0f6fc';
    ctx.font = 'bold 13px -apple-system, Arial, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(s.value, LABEL_W + filledW + 8, y + barH / 2);

    // Percentage vs total
    if (i > 0 && total > 0) {
      const pct = Math.round((s.value / total) * 100);
      ctx.fillStyle = '#484f58';
      ctx.font = '11px Arial';
      ctx.fillText(`${pct}%`, LABEL_W + filledW + 34, y + barH / 2);
    }
  });
}

// ── Platform donut chart ───────────────────────────────────────────────────────
function renderPlatformChart(jobs) {
  const canvas = document.getElementById('platformCanvas');
  if (!canvas) return;

  if (jobs.length === 0) {
    document.getElementById('platformEmpty').style.display = 'block';
    canvas.style.display = 'none';
    return;
  }

  // Count by platform
  const counts = {};
  jobs.forEach(j => {
    const p = (j.platform || 'לא ידוע').trim();
    counts[p] = (counts[p] || 0) + 1;
  });
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const total   = jobs.length;

  const { ctx, W, H } = setupCanvas(canvas);
  ctx.clearRect(0, 0, W, H);

  const LEGEND_W = 170;
  const chartW   = W - LEGEND_W;
  const cx       = chartW / 2;
  const cy       = H / 2;
  const R        = Math.min(cx, cy) - 12;
  const innerR   = R * 0.58;

  // Draw slices
  let angle = -Math.PI / 2;
  entries.forEach(([, count], i) => {
    const sweep = (count / total) * 2 * Math.PI;
    const color = PALETTE[i % PALETTE.length];
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, R, angle, angle + sweep);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = '#0d1117';
    ctx.lineWidth = 2;
    ctx.stroke();
    angle += sweep;
  });

  // Donut hole
  ctx.beginPath();
  ctx.arc(cx, cy, innerR, 0, 2 * Math.PI);
  ctx.fillStyle = '#161b22';
  ctx.fill();

  // Centre text
  ctx.fillStyle = '#f0f6fc';
  ctx.font = 'bold 22px -apple-system, Arial';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(total, cx, cy - 9);
  ctx.fillStyle = '#8b949e';
  ctx.font = '11px Arial';
  ctx.fillText('משרות', cx, cy + 11);

  // Legend
  const legendX  = chartW + 10;
  const rowH     = 22;
  const startY   = cy - ((entries.length * rowH) / 2);
  entries.forEach(([platform, count], i) => {
    const y     = startY + i * rowH;
    const color = PALETTE[i % PALETTE.length];
    const pct   = Math.round((count / total) * 100);

    ctx.fillStyle = color;
    roundRect(ctx, legendX, y + 3, 12, 12, 3);
    ctx.fill();

    ctx.fillStyle = '#e6edf3';
    ctx.font = '12px -apple-system, Arial';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(`${platform}`, legendX + 17, y + 2);

    ctx.fillStyle = '#8b949e';
    ctx.font = '11px Arial';
    ctx.fillText(`${count} (${pct}%)`, legendX + 17, y + 14);
  });
}

// ── Market benchmarking ────────────────────────────────────────────────────────
async function loadMarketData(licenseKey) {
  const cardsEl = document.getElementById('marketCards');
  cardsEl.innerHTML = `
    <div class="market-card"><div class="market-loading">⏳ טוען נתוני שוק...</div></div>
    <div class="market-card"><div class="market-loading">⏳ טוען...</div></div>
    <div class="market-card"><div class="market-loading">⏳ טוען...</div></div>`;

  const years = document.getElementById('yearsExpSelect').value;
  const title = document.getElementById('titleSelect').value;

  try {
    const resp = await fetch(
      `${BACKEND}/api/analytics/market-compare?years_exp=${years}&title=${encodeURIComponent(title)}`,
      { headers: licenseKey ? { 'x-license-key': licenseKey } : {} }
    );
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    renderMarketCards(data);
  } catch {
    cardsEl.innerHTML = `
      <div class="market-card" style="grid-column:1/-1">
        <div class="market-error">⚠️ לא ניתן לטעון נתוני שוק כרגע — ודא שיש חיבור לאינטרנט ונסה שוב.</div>
      </div>`;
  }
}

function renderMarketCards(data) {
  const cardsEl = document.getElementById('marketCards');

  const pct      = data.percentile ?? '—';
  const days     = data.avg_response_days ?? '—';
  const companies = data.top_trending_companies || [];

  cardsEl.innerHTML = `
    <div class="market-card">
      <div class="market-metric">${pct}<span class="unit">%</span></div>
      <div class="market-label">אחוזון פעילות שבועית</div>
      <div class="market-sub">אתה פעיל יותר מ-${pct}% ממפתחים בפרופיל דומה השבוע</div>
    </div>

    <div class="market-card">
      <div class="market-metric">${days}<span class="unit"> ימים</span></div>
      <div class="market-label">זמן תגובה ממוצע בשוק</div>
      <div class="market-sub">כמה ימים לוקח לחברות לחזור לפרופיל כמוך בממוצע</div>
    </div>

    <div class="market-card">
      <div class="market-label" style="margin-bottom:10px;font-size:14px">🔥 חברות חמות כרגע</div>
      ${companies.map((c, i) => `
        <div class="trending-company">
          <div class="trending-rank">${i + 1}</div>
          <div class="trending-name">${esc(c.name)}</div>
          <div class="trending-openings">${c.openings} משרות</div>
        </div>`).join('')}
      ${companies.length === 0 ? '<div class="market-sub">אין נתונים</div>' : ''}
    </div>`;
}

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
