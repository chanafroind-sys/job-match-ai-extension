const TRACKER_KEY = 'jobTracker';
const MAX_RECORDS = 500;

async function saveJob(record) {
  const jobs = await getAllJobs();
  jobs.unshift(record);
  const trimmed = jobs.slice(0, MAX_RECORDS);
  await chrome.storage.local.set({ [TRACKER_KEY]: trimmed });
}

async function getAllJobs() {
  const data = await chrome.storage.local.get(TRACKER_KEY);
  return data[TRACKER_KEY] || [];
}

async function updateJobStatus(id, status) {
  const jobs = await getAllJobs();
  const idx = jobs.findIndex(j => j.id === id);
  if (idx !== -1) {
    jobs[idx].status = status;
    await chrome.storage.local.set({ [TRACKER_KEY]: jobs });
  }
}

async function deleteJob(id) {
  const jobs = await getAllJobs();
  const filtered = jobs.filter(j => j.id !== id);
  await chrome.storage.local.set({ [TRACKER_KEY]: filtered });
}

function exportToExcel(jobs, clicksMap = {}) {
  const BOM = '﻿';
  const headers = ['תאריך', 'תפקיד', 'חברה', 'פלטפורמה', 'ציון התאמה', 'קורות חיים הוכנו', 'לינק נפתח', 'מספר לחיצות', 'זמן פתיחה אחרון', 'סטטוס', 'קישור למשרה'];
  const rows = jobs.map(j => {
    const clicks = (j.appId && clicksMap[j.appId]) || [];
    let linkOpened = 'לא';
    let clickCount = '';
    let lastOpened = '';
    if (clicks.length > 0) {
      const targets = [...new Set(clicks.map(c => c.target))];
      linkOpened = targets.map(t => t === 'github' ? 'GitHub' : t === 'linkedin' ? 'LinkedIn' : 'Portfolio').join(', ');
      clickCount = String(clicks.length);
      const latest = clicks.reduce((a, b) => (a.ts > b.ts ? a : b));
      lastOpened = new Date(latest.ts).toLocaleString('he-IL');
    }
    return [
      new Date(j.date).toLocaleDateString('he-IL'),
      j.jobTitle || '',
      j.company || '',
      j.platform || '',
      (j.score || 0) + '%',
      j.cvGenerated ? 'כן' : 'לא',
      linkOpened,
      clickCount,
      lastOpened,
      j.status || 'טרם טופל',
      j.url || '',
    ];
  });
  const csv = BOM + [headers, ...rows]
    .map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
    .join('\n');

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `job_tracker_${new Date().toLocaleDateString('he-IL').replace(/\//g, '-')}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
