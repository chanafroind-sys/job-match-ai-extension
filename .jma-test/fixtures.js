// Realistic page skeletons for the boards the extension actually runs on.

const JD_BODY = `
About the job
We are looking for a Senior Backend Engineer to join our platform team.
The role
You will design and ship services that power our core product.
Responsibilities:
Build and maintain backend services in Python and Node.js
Own our PostgreSQL schema and query performance
Work with Docker and Kubernetes on AWS
Requirements:
5+ years of professional experience in backend development
3 years experience with Python
Strong knowledge of SQL and PostgreSQL
Experience with Docker, Kubernetes and AWS
Nice to have:
Experience with Kafka
Familiarity with Terraform
Apply now to join a hiring team building a full-time position with competitive salary.
`.trim();

const JD_TAIL = `
More about the role
You will mentor junior engineers and drive architecture decisions across the team.
We offer a hybrid schedule, an annual learning budget and equity in a growing company.
Our stack also includes Redis, RabbitMQ and Elasticsearch, and we invest heavily in
observability with Prometheus and Grafana. This is a full-time position based in Tel Aviv
with the option to work remotely two days a week.
`.trim();

const similarRail = (n = 4) => `
  <section class="jobs-similar-jobs artdeco-card" aria-label="Similar jobs">
    <h2>Similar jobs</h2>
    <ul>
      ${Array.from({ length: n }, (_, i) => `
        <li class="job-card-container--clickable" data-job-id="sim-${i}">
          <a href="/jobs/view/9${i}00001" class="job-card-container__link">
            <strong>Backend Engineer ${i}</strong>
          </a>
          <div class="job-card-container__primary-description">Some Company ${i}</div>
          <div class="job-card-list__footer-wrapper">Tel Aviv, Israel · Full-time position, apply now</div>
        </li>`).join('')}
    </ul>
  </section>`;

const resultsList = (n = 6) => `
  <ul class="scaffold-layout__list-container">
    ${Array.from({ length: n }, (_, i) => `
      <li class="jobs-search-results__list-item job-card-container--clickable" data-job-id="res-${i}">
        <a href="/jobs/view/4${i}000123" class="job-card-container__link">
          <strong>Senior Python Engineer ${i}</strong>
        </a>
        <div class="job-card-container__primary-description">Acme Corp ${i}</div>
        <div class="job-card-list__footer-wrapper">
          Requirements: 4 years experience with Python, Docker, AWS and PostgreSQL.
          Full-time position, apply now. Salary competitive.
        </div>
      </li>`).join('')}
  </ul>`;

// A. LinkedIn single job page — the reported bug. Has a similar-jobs rail whose
//    cards match the LinkedIn CARD_CONFIG selector exactly.
const linkedinSingle = `<!doctype html><html><body>
  <div class="job-view-layout jobs-details">
    <h1>Senior Backend Engineer</h1>
    <div class="jobs-description">
      <div class="jobs-box__html-content">${JD_BODY.replace(/\n/g, '<br>')}</div>
    </div>
  </div>
  ${similarRail()}
</body></html>`;

// B. LinkedIn search page, nothing selected.
const linkedinSearch = `<!doctype html><html><body>
  <div class="scaffold-layout">
    <h1>Jobs</h1>
    ${resultsList()}
  </div>
</body></html>`;

// C. LinkedIn search page with a job open in the right-hand pane.
const linkedinHybrid = `<!doctype html><html><body>
  <div class="scaffold-layout">
    ${resultsList()}
    <div class="jobs-search__job-details--wrapper jobs-details">
      <h1>Senior Backend Engineer</h1>
      <div class="jobs-description"><div class="jobs-box__html-content">${JD_BODY.replace(/\n/g, '<br>')}</div></div>
    </div>
  </div>
</body></html>`;

// D. Indeed single job page, also with a "more jobs" rail.
const indeedSingle = `<!doctype html><html><body>
  <div class="jobsearch-JobComponent">
    <h1>Senior Backend Engineer</h1>
    <div id="jobDescriptionText">${JD_BODY.replace(/\n/g, '<br>')}</div>
  </div>
  <div class="jobsearch-MoreJobs" aria-label="More jobs at this company">
    ${Array.from({ length: 3 }, (_, i) => `
      <div class="job_seen_beacon"><a href="/viewjob?jk=x${i}"><span class="jobTitle">Other role ${i}</span></a>
      <span class="companyName">Acme</span><div class="job-snippet">Requirements: Python experience, apply now for this full-time position with salary.</div></div>`).join('')}
  </div>
</body></html>`;

// E. Greenhouse-style careers board.
const greenhouseBoard = `<!doctype html><html><body>
  <h1>Careers at Acme</h1>
  <div id="content">
    ${Array.from({ length: 5 }, (_, i) => `
      <div class="opening">
        <a href="/o/senior-engineer-${i}">Senior Engineer ${i}</a>
        <span class="location">Tel Aviv</span>
        <p>Requirements: 3 years experience with Python and Docker. Full-time position, apply now, salary competitive, hiring immediately.</p>
      </div>`).join('')}
  </div>
</body></html>`;

// F. LinkedIn single job with the description truncated behind "See more".
//    The tail only enters the DOM when the button is clicked.
const linkedinTruncated = `<!doctype html><html><body>
  <div class="job-view-layout jobs-details">
    <h1>Senior Backend Engineer</h1>
    <div class="jobs-description">
      <div class="jobs-box__html-content" id="jd">${JD_BODY.replace(/\n/g, '<br>')}</div>
      <button class="jobs-description__footer-button" aria-expanded="false">See more</button>
    </div>
  </div>
  ${similarRail()}
  <script></script>
</body></html>`;

const TRUNCATED_TAIL_MARKER = 'Prometheus and Grafana';

module.exports = {
  JD_BODY, JD_TAIL, TRUNCATED_TAIL_MARKER,
  linkedinSingle, linkedinSearch, linkedinHybrid,
  indeedSingle, greenhouseBoard, linkedinTruncated,
};
