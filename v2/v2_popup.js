// JMA V2 popup page — runs only inside #jma-v2-panel's iframe (or if opened
// directly). Talks exclusively to /api/v2/* and reads only jma_v2_* storage
// keys. No V1 code, storage, endpoints, or message actions are ever used.
'use strict';

const V2_BACKEND = 'https://job-match-ai-extension.onrender.com';
const V2_JOBS_KEY = 'jma_v2_recent_jobs';

document.addEventListener('DOMContentLoaded', async () => {
  const card = document.getElementById('v2JobCard');
  try {
    const data = await chrome.storage.local.get(V2_JOBS_KEY);
    const job = (data[V2_JOBS_KEY] || [])[0];
    if (job) {
      card.textContent = `📄 ${job.jobTitle || 'משרה ללא כותרת'}`;
      const url = document.createElement('span');
      url.className = 'v2-job-url';
      url.textContent = job.url || '';
      card.appendChild(url);
    } else {
      card.textContent = 'לא נלכדה משרה עדיין — לחצי על ה-FAB ובחרי מצב אינטראקטיבי';
    }
  } catch {
    card.textContent = 'שגיאה בקריאת נתוני V2';
  }

  document.getElementById('v2HealthBtn').addEventListener('click', async () => {
    const out = document.getElementById('v2HealthResult');
    out.className = '';
    out.textContent = 'בודק…';
    try {
      const resp = await fetch(`${V2_BACKEND}/api/v2/health`);
      const body = await resp.json();
      if (resp.ok && body.ok) {
        out.className = 'ok';
        out.textContent = `✅ ‎/api/v2 מחובר (גרסה ${body.version})`;
      } else {
        out.className = 'err';
        out.textContent = `❌ HTTP ${resp.status}`;
      }
    } catch {
      out.className = 'err';
      out.textContent = '❌ אין חיבור לשרת (ייתכן שהשרת מתעורר — נסי שוב)';
    }
  });
});
