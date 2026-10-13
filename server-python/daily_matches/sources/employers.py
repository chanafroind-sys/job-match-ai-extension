"""Large employers in Israeli tech, on ATSs the registry already reads.

V1's hand-made list (app/services/israel_job_sources.py, 57 companies) and the
Comeet seeds (comeet.py) leave out many big employers. These were mapped on
2026-10-13: each company's careers page or public listings were checked for
the ATS behind it, and every board below was read live through the same
fetcher the registry uses. registry.seed_boards adds them once; from then on
they are read daily like any discovered board, and one that stops answering
is skipped after registry.MAX_FAILURES days.

Not here, because no reader exists for their systems yet: Microsoft, Google,
Amazon, Apple and Meta (their own sites), Amdocs and Qualcomm (Eightfold),
Check Point, Wix, monday.com and Elbit (own or unidentified), Booking
(iCIMS), Synopsys (Avature). Dell's Workday board refused the query (422).
"""

# (ats, fetch params, company). Israeli tech positions on 2026-10-13 in comments;
# boards at 0 that day are Israeli R&D sites that hire, read daily all the same.
SEED_BOARDS: tuple[tuple[str, dict, str], ...] = (
    ("workday", {"host": "paloaltonetworks.wd5.myworkdayjobs.com", "site": "panwexternalcareers"},
     "Palo Alto Networks"),  # 87, CyberArk's roles included
    ("greenhouse", {"board": "aidocmedical"}, "Aidoc"),  # 13
    ("greenhouse", {"board": "gitlab"}, "GitLab"),  # 8
    ("ashby", {"board": "moonactive"}, "Moon Active"),  # 8
    ("greenhouse", {"board": "pagayais"}, "Pagaya"),  # 6
    ("greenhouse", {"board": "elastic"}, "Elastic"),  # 4
    ("greenhouse", {"board": "zscaler"}, "Zscaler"),  # 4
    ("workday", {"host": "hpe.wd5.myworkdayjobs.com", "site": "ACJobSite"}, "HPE"),  # 3
    ("smartrecruiters", {"company": "armis"}, "Armis"),  # 2
    ("greenhouse", {"board": "augury"}, "Augury"),  # 1
    ("greenhouse", {"board": "cymulate"}, "Cymulate"),  # 1
    ("greenhouse", {"board": "wolt"}, "Wolt"),  # 1
    ("ashby", {"board": "unit"}, "Unit"),  # 1
    ("workday", {"host": "generalmotors.wd5.myworkdayjobs.com", "site": "Careers_GM"}, "General Motors"),  # 1
    ("workday", {"host": "redhat.wd5.myworkdayjobs.com", "site": "Jobs"}, "Red Hat"),  # 1
    ("ashby", {"board": "sisense"}, "Sisense"),
    ("smartrecruiters", {"company": "westerndigital"}, "Western Digital"),
    ("workday", {"host": "genesys.wd1.myworkdayjobs.com", "site": "Genesys"}, "Genesys"),
    ("workday", {"host": "tricentis.wd1.myworkdayjobs.com", "site": "Tricentis_Careers"}, "Tricentis"),
)
