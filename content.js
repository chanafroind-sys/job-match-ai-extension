(() => {
  const PLATFORM_SELECTORS = {
    'linkedin.com': ['.job-view-layout', '.jobs-description', '.scaffold-layout__detail', '.jobs-box__html-content'],
    'jobmaster.co.il': ['.job-description', '.job-content', '#job-description', '.jobDescription'],
    'alljobs.co.il': ['.job-inner-description', '.job-description-text', '.jobContent'],
    'indeed.com': ['#jobDescriptionText', '.jobsearch-jobDescriptionText', '.job-snippet'],
    'glassdoor.com': ['.jobDescriptionContent', '[class*="JobDescription"]', '[class*="jobDescription"]'],
    'drushim.co.il': ['.job-description', '#job-content', '.position-description'],
    'gotfriends.co.il': ['.job-desc', '.position-description', '.job-content'],
    'comeet.co': ['.position-details', '.job-description', '.position-description'],
    'hunter.io': ['.job-body', '.description-body'],
    'heyanter.com': ['.job-body', '.description-body'],
    'jobify360.co.il': ['.job-description', '.job-content', '.position-description', '[class*="job"]', 'article', 'main'],
  };

  const GENERIC_SELECTORS = [
    'article[class*="job"]',
    'main[class*="job"]',
    '[class*="job-description"]',
    '[class*="jobDescription"]',
    '[id*="job-description"]',
    '[id*="jobDescription"]',
    '[class*="position-description"]',
    '[class*="vacancy-description"]',
    '[class*="job-details"]',
    '[class*="jobDetails"]',
    'article',
    'main',
    '[class*="description"]',
    '[class*="content"]',
    '#content',
    '.content',
  ];

  function detectPlatform() {
    const hostname = window.location.hostname.replace('www.', '');
    const platformMap = {
      'linkedin.com': 'LinkedIn',
      'jobmaster.co.il': 'JobMaster',
      'alljobs.co.il': 'AllJobs',
      'indeed.com': 'Indeed',
      'glassdoor.com': 'Glassdoor',
      'drushim.co.il': 'דרושים',
      'gotfriends.co.il': 'גוטפרנדס',
      'comeet.co': 'Comeet',
      'hunter.io': 'Hunter',
      'heyanter.com': 'הייאנטר',
      'jobify360.co.il': 'Jobify360',
      'jobnet.co.il': 'JobNet',
      'jobs.gov.il': 'שירות התעסוקה',
      'smartrecruiters.com': 'SmartRecruiters',
      'greenhouse.io': 'Greenhouse',
      'lever.co': 'Lever',
      'workable.com': 'Workable',
    };
    for (const [domain, name] of Object.entries(platformMap)) {
      if (hostname.includes(domain)) return name;
    }
    return hostname;
  }

  function detectLanguage(text) {
    const hebrewChars = (text.match(/[֐-׿]/g) || []).length;
    const totalChars = text.replace(/\s/g, '').length;
    return totalChars > 0 && (hebrewChars / totalChars) > 0.2 ? 'hebrew' : 'english';
  }

  function cleanText(text) {
    return text
      .replace(/\s+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function extractJobText() {
    const hostname = window.location.hostname.replace('www.', '');

    // Try platform-specific selectors first
    for (const [domain, selectors] of Object.entries(PLATFORM_SELECTORS)) {
      if (hostname.includes(domain)) {
        for (const selector of selectors) {
          const el = document.querySelector(selector);
          if (el && el.innerText && el.innerText.trim().length > 100) {
            return cleanText(el.innerText).substring(0, 7000);
          }
        }
      }
    }

    // Try generic selectors
    for (const selector of GENERIC_SELECTORS) {
      try {
        const elements = document.querySelectorAll(selector);
        for (const el of elements) {
          const text = el.innerText || el.textContent || '';
          if (text.trim().length > 200) {
            return cleanText(text).substring(0, 7000);
          }
        }
      } catch (e) {
        // ignore invalid selectors
      }
    }

    // Fallback: full body
    return cleanText(document.body.innerText || document.body.textContent || '').substring(0, 7000);
  }

  chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
    if (req.action === 'getJobText') {
      const text = extractJobText();
      sendResponse({
        text,
        language: detectLanguage(text),
        platform: detectPlatform(),
        url: window.location.href,
        title: document.title
      });
    }
    return true;
  });
})();
