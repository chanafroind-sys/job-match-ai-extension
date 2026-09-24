"""Registry of company career boards the daily job-pool aggregator pulls from.

Every entry was probed live (2026-09-24) against its ATS's public JSON API and
had open positions located in Israel at the time. Entries are cheap to keep
even when a company's Israeli openings dry up — the location filter in
job_aggregator.py simply yields nothing for them that day.

To add a company, find its board slug on the careers page URL:
  greenhouse       boards.greenhouse.io/<board>       → {"board": ...}
  lever            jobs.lever.co/<site> (jobs.eu.lever.co → region "eu")
  ashby            jobs.ashbyhq.com/<board>           → {"board": ...}
  smartrecruiters  careers.smartrecruiters.com/<company>
  workday          <tenant>.wdN.myworkdayjobs.com/<site>  → {"host", "site"}
"""

COMPANIES: list[dict] = [
    # --- Greenhouse ---
    {"name": "Payoneer", "ats": "greenhouse", "params": {"board": "payoneer"}},
    {"name": "Similarweb", "ats": "greenhouse", "params": {"board": "similarweb"}},
    {"name": "Wiz", "ats": "greenhouse", "params": {"board": "wizinc"}},
    {"name": "Riskified", "ats": "greenhouse", "params": {"board": "riskified"}},
    {"name": "Forter", "ats": "greenhouse", "params": {"board": "forter"}},
    {"name": "Yotpo", "ats": "greenhouse", "params": {"board": "yotpo"}},
    {"name": "AppsFlyer", "ats": "greenhouse", "params": {"board": "appsflyer"}},
    {"name": "Taboola", "ats": "greenhouse", "params": {"board": "taboola"}},
    {"name": "Axonius", "ats": "greenhouse", "params": {"board": "axonius"}},
    {"name": "Melio", "ats": "greenhouse", "params": {"board": "melio"}},
    {"name": "Cato Networks", "ats": "greenhouse", "params": {"board": "catonetworks"}},
    {"name": "Gong", "ats": "greenhouse", "params": {"board": "gongio"}},
    {"name": "Orca Security", "ats": "greenhouse", "params": {"board": "orcasecurity"}},
    {"name": "JFrog", "ats": "greenhouse", "params": {"board": "jfrog"}},
    {"name": "SentinelOne", "ats": "greenhouse", "params": {"board": "sentinellabs"}},
    {"name": "Via", "ats": "greenhouse", "params": {"board": "via"}},
    {"name": "Lightricks", "ats": "greenhouse", "params": {"board": "lightricks"}},
    {"name": "Transmit Security", "ats": "greenhouse", "params": {"board": "transmitsecurity"}},
    {"name": "Torq", "ats": "greenhouse", "params": {"board": "torq"}},
    {"name": "Island", "ats": "greenhouse", "params": {"board": "island"}},
    {"name": "NICE", "ats": "greenhouse", "params": {"board": "nice"}},
    {"name": "Bringg", "ats": "greenhouse", "params": {"board": "bringg"}},
    {"name": "Innovid", "ats": "greenhouse", "params": {"board": "innovid"}},
    {"name": "Optimove", "ats": "greenhouse", "params": {"board": "optimove"}},
    {"name": "Lightrun", "ats": "greenhouse", "params": {"board": "lightrun"}},
    {"name": "Okta", "ats": "greenhouse", "params": {"board": "okta"}},
    {"name": "Datadog", "ats": "greenhouse", "params": {"board": "datadog"}},
    {"name": "Salt Security", "ats": "greenhouse", "params": {"board": "saltsecurity"}},
    {"name": "Apiiro", "ats": "greenhouse", "params": {"board": "apiiro"}},
    {"name": "Guardz", "ats": "greenhouse", "params": {"board": "guardz"}},
    {"name": "BigID", "ats": "greenhouse", "params": {"board": "bigid"}},
    {"name": "Obligo", "ats": "greenhouse", "params": {"board": "obligo"}},
    {"name": "Datarails", "ats": "greenhouse", "params": {"board": "datarails"}},
    {"name": "Fireblocks", "ats": "greenhouse", "params": {"board": "fireblocks"}},
    # --- Lever ---
    {"name": "Mobileye", "ats": "lever", "params": {"site": "mobileye", "region": "eu"}},
    {"name": "WalkMe", "ats": "lever", "params": {"site": "walkme"}},
    {"name": "Cloudinary", "ats": "lever", "params": {"site": "cloudinary"}},
    {"name": "Lendbuzz", "ats": "lever", "params": {"site": "lendbuzz"}},
    # --- Ashby ---
    {"name": "Lemonade", "ats": "ashby", "params": {"board": "lemonade"}},
    {"name": "HoneyBook", "ats": "ashby", "params": {"board": "honeybook"}},
    {"name": "Finout", "ats": "ashby", "params": {"board": "finout"}},
    # --- SmartRecruiters ---
    {"name": "ServiceNow", "ats": "smartrecruiters", "params": {"company": "ServiceNow"}},
    {"name": "Sandisk", "ats": "smartrecruiters", "params": {"company": "Sandisk"}},
    # --- Workday ---
    {"name": "NVIDIA", "ats": "workday", "params": {"host": "nvidia.wd5.myworkdayjobs.com", "site": "NVIDIAExternalCareerSite"}},
    {"name": "KLA", "ats": "workday", "params": {"host": "kla.wd1.myworkdayjobs.com", "site": "Search"}},
    {"name": "Applied Materials", "ats": "workday", "params": {"host": "amat.wd1.myworkdayjobs.com", "site": "External"}},
    {"name": "Cisco", "ats": "workday", "params": {"host": "cisco.wd5.myworkdayjobs.com", "site": "Cisco_Careers"}},
    {"name": "Intel", "ats": "workday", "params": {"host": "intel.wd1.myworkdayjobs.com", "site": "External"}},
    {"name": "Salesforce", "ats": "workday", "params": {"host": "salesforce.wd12.myworkdayjobs.com", "site": "External_Career_Site"}},
    {"name": "Thales", "ats": "workday", "params": {"host": "thales.wd3.myworkdayjobs.com", "site": "Careers"}},
    {"name": "Motorola Solutions", "ats": "workday", "params": {"host": "motorolasolutions.wd5.myworkdayjobs.com", "site": "Careers"}},
    {"name": "HP", "ats": "workday", "params": {"host": "hp.wd5.myworkdayjobs.com", "site": "ExternalCareerSite"}},
    {"name": "Mastercard", "ats": "workday", "params": {"host": "mastercard.wd1.myworkdayjobs.com", "site": "CorporateCareers"}},
    {"name": "Cadence", "ats": "workday", "params": {"host": "cadence.wd1.myworkdayjobs.com", "site": "External_Careers"}},
    {"name": "Workday", "ats": "workday", "params": {"host": "workday.wd5.myworkdayjobs.com", "site": "Workday"}},
    {"name": "Marvell", "ats": "workday", "params": {"host": "marvell.wd1.myworkdayjobs.com", "site": "MarvellCareers"}},
    {"name": "PTC", "ats": "workday", "params": {"host": "ptc.wd1.myworkdayjobs.com", "site": "PTC"}},
]
