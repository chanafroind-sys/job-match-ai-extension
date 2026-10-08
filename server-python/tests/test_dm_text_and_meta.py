"""Daily Matches: text preparation, ATS/apply-URL resolution, Israel-day math."""
from datetime import date, datetime, timedelta, timezone

from daily_matches import config, text_prep
from daily_matches.jobs_meta import apply_url_for, ats_for
from daily_matches.retrieval import merge_candidates


class TestCvText:
    def test_hash_ignores_whitespace_noise(self):
        a = "Senior engineer\r\nPython   and  Kafka\n\n\n\nAWS  "
        b = "Senior engineer\nPython and Kafka\n\nAWS"
        assert text_prep.cv_hash(a) == text_prep.cv_hash(b)

    def test_hash_changes_with_content(self):
        assert text_prep.cv_hash("Python Kafka") != text_prep.cv_hash("Python Kafka Go")

    def test_fingerprint_survives_punctuation_edits(self):
        a = "Noa Levi — Backend Engineer. Python, Kafka; AWS!"
        b = "noa levi backend engineer python kafka aws"
        assert text_prep.cv_fingerprint(a) == text_prep.cv_fingerprint(b)

    def test_fingerprint_keeps_hebrew(self):
        assert text_prep.cv_fingerprint("מהנדסת תוכנה") != text_prep.cv_fingerprint("מהנדס חומרה")

    def test_pdf_blob_detection_and_unwrap(self):
        blob = "[PDF_BASE64:JVBERi0xLjQK]"
        assert text_prep.is_pdf_blob(blob)
        assert text_prep.pdf_b64_from_blob(blob) == "JVBERi0xLjQK"
        assert not text_prep.is_pdf_blob("Python developer")

    def test_redaction_drops_contacts(self):
        out = text_prep.redact_contacts(
            "Noa · noa.levi@example.com · +972 50-123-4567 · 054-1234567 · "
            "https://github.com/noa · linkedin.com/in/noa-levi")
        assert "@" not in out and "123-4567" not in out and "1234567" not in out
        assert "github" not in out and "linkedin" not in out
        assert out.count("[phone]") == 2

    def test_redaction_keeps_dates_and_years_of_experience(self):
        text = "Lumen (2020 - 2026) · 2018-2020 · 6+ years of Python · B.Sc. 2015"
        assert text_prep.redact_contacts(text) == text


class TestJobText:
    DESC = (
        "About us\nWe are a fast-growing company with great culture.\n"
        "What you'll do:\n• Build Kafka consumers\n"
        "Requirements:\n• 5+ years of Python\n• AWS\n"
        "Nice to have:\n• Go\n"
        "Benefits\n• Free lunch\n• Gym\n"
    )

    def test_focus_keeps_requirements_and_drops_marketing(self):
        out = text_prep.focus_excerpt(self.DESC, 4000)
        assert "5+ years of Python" in out and "Build Kafka consumers" in out and "Go" in out
        assert "Free lunch" not in out and "great culture" not in out

    def test_focus_without_headings_keeps_text(self):
        out = text_prep.focus_excerpt("Python and Kafka backend role.\nWork with AWS.", 4000)
        assert "Python and Kafka" in out and "AWS" in out

    def test_focus_respects_limit(self):
        assert len(text_prep.focus_excerpt("Requirements:\n" + "• Python\n" * 2000, 300)) <= 300

    def test_hebrew_counts_denser_than_english(self):
        assert text_prep.estimate_tokens("א" * 1000) > text_prep.estimate_tokens("a" * 1000)


class TestJobsMeta:
    def test_lever_apply_url(self):
        url = "https://jobs.lever.co/acme/1234-abcd"
        assert ats_for("Acme", url) == "lever"
        assert apply_url_for("lever", url, "Acme", None) == url + "/apply"
        assert apply_url_for("lever", url + "/apply", "Acme", None) == url + "/apply"

    def test_greenhouse_company_page_becomes_greenhouse_form(self):
        url = "https://www.wiz.io/careers/job/123?gh_jid=4567"
        assert ats_for("Wiz", url) == "greenhouse"
        assert apply_url_for("greenhouse", url, "Wiz", "4567") == \
            "https://job-boards.greenhouse.io/embed/job_app?for=wizinc&token=4567"

    def test_greenhouse_board_comes_from_the_hosted_url(self):
        # Any company, including registry boards: the hosted URL names the board.
        for url in ("https://boards.greenhouse.io/someco/jobs/1", "https://job-boards.greenhouse.io/someco/jobs/1"):
            assert apply_url_for("greenhouse", url, "Some Co", "1") == \
                "https://job-boards.greenhouse.io/embed/job_app?for=someco&token=1"

    def test_greenhouse_without_a_board_keeps_url(self):
        url = "https://careers.someco.com/jobs/1?gh_jid=1"
        assert apply_url_for("greenhouse", url, "Some Co", "1") == url

    def test_a_linkedin_listing_is_never_the_companys_board(self):
        # Gong has a Greenhouse board; its LinkedIn listing must not get a
        # Greenhouse link built from LinkedIn's job id.
        url = "https://www.linkedin.com/jobs/view/4466539338"
        assert ats_for("Gong", url) == "linkedin"
        assert apply_url_for("linkedin", url, "Gong", "4466539338") == url
        assert ats_for("NVIDIA", "https://il.indeed.com/viewjob?jk=1") == "indeed"

    def test_more_ats_hosts(self):
        assert ats_for("X", "https://www.comeet.co/jobs/73.00B/46.076") == "comeet"
        assert ats_for("X", "https://www.comeet.com/jobs/acme/73.00B/dev/46.076") == "comeet"
        assert ats_for("X", "https://jobs.smartrecruiters.com/ServiceNow/744000154095662") == "smartrecruiters"
        assert ats_for("X", "https://career.teamtailor.com/jobs/1-dev") == "teamtailor"
        workable = "https://apply.workable.com/acme/j/DB4D7C0EC8/"
        assert ats_for("X", workable) == "workable"
        assert apply_url_for("workable", workable, "X", None) == "https://apply.workable.com/acme/j/DB4D7C0EC8/apply/"
        assert apply_url_for("workable", workable + "apply/", "X", None) == workable + "apply/"

    def test_workday_and_ashby(self):
        assert ats_for("X", "https://nvidia.wd5.myworkdayjobs.com/External/job/1") == "workday"
        ashby = "https://jobs.ashbyhq.com/acme/abc"
        assert ats_for("X", ashby) == "ashby"
        assert apply_url_for("ashby", ashby, "X", None) == ashby + "/application"

    def test_unknown(self):
        assert ats_for("Nobody", "https://careers.example.com/1") == "other"


class TestIsraelDay:
    def test_rule_offsets(self):
        summer = datetime(2026, 7, 1, 12, tzinfo=timezone.utc)
        winter = datetime(2026, 12, 1, 12, tzinfo=timezone.utc)
        assert config._il_offset(summer) == timedelta(hours=3)
        assert config._il_offset(winter) == timedelta(hours=2)

    def test_rule_switch_dates_2026(self):
        # 2026: DST starts Friday March 27, ends Sunday October 25.
        assert config._il_offset(datetime(2026, 3, 26, 23, tzinfo=timezone.utc)) == timedelta(hours=2)
        assert config._il_offset(datetime(2026, 3, 27, 1, tzinfo=timezone.utc)) == timedelta(hours=3)
        assert config._il_offset(datetime(2026, 10, 24, 22, tzinfo=timezone.utc)) == timedelta(hours=3)
        assert config._il_offset(datetime(2026, 10, 25, 0, tzinfo=timezone.utc)) == timedelta(hours=2)

    def test_match_day_rolls_at_israel_midnight(self):
        # 22:30 UTC in summer is 01:30 the next day in Israel.
        assert config.match_day(datetime(2026, 7, 1, 22, 30, tzinfo=timezone.utc)) == date(2026, 7, 2)
        assert config.match_day(datetime(2026, 7, 1, 20, 30, tzinfo=timezone.utc)) == date(2026, 7, 1)

    def test_next_reset_is_next_local_midnight(self):
        now = datetime(2026, 7, 1, 10, tzinfo=timezone.utc)
        reset = config.next_reset(now)
        assert reset.date() == date(2026, 7, 2) and (reset.hour, reset.minute) == (0, 0)
        assert reset.astimezone(timezone.utc) == datetime(2026, 7, 1, 21, tzinfo=timezone.utc)

    def test_mode_parsing(self, monkeypatch):
        for raw, expected in [("", "off"), ("false", "off"), ("admins", "admins"), ("true", "on"), ("ON", "on")]:
            monkeypatch.setenv("DAILY_MATCHES_ENABLED", raw)
            assert config.mode() == expected


class TestMergeCandidates:
    def test_best_similarity_wins(self):
        per_cv = {"cv1": [("a", 0.9), ("b", 0.5)], "cv2": [("b", 0.8), ("c", 0.4)]}
        out = merge_candidates(per_cv, top_k=3, min_per_cv=0)
        assert [c.job_id for c in out] == ["a", "b", "c"]
        assert out[1].best_cv == "cv2" and out[1].sims == {"cv1": 0.5, "cv2": 0.8}

    def test_each_cv_gets_its_floor(self):
        strong = [(f"s{i}", 0.9 - i * 0.01) for i in range(15)]
        weak = [(f"w{i}", 0.3 - i * 0.01) for i in range(15)]
        out = merge_candidates({"cv1": strong, "cv2": weak}, top_k=15, min_per_cv=3)
        ids = {c.job_id for c in out}
        assert len(out) == 15
        assert {"w0", "w1", "w2"} <= ids and "w3" not in ids

    def test_single_cv_has_no_floor_and_keeps_order(self):
        out = merge_candidates({"cv1": [("a", 0.2), ("b", 0.9)]}, top_k=15, min_per_cv=3)
        assert [c.job_id for c in out] == ["b", "a"]

    def test_union_contains_global_top_k(self):
        per_cv = {"cv1": [("a", 0.95), ("b", 0.94), ("c", 0.10)],
                  "cv2": [("d", 0.93), ("c", 0.92), ("e", 0.05)]}
        out = merge_candidates(per_cv, top_k=4, min_per_cv=0)
        assert {c.job_id for c in out} == {"a", "b", "c", "d"}

    def test_empty(self):
        assert merge_candidates({"cv1": []}, top_k=15, min_per_cv=3) == []


class TestFilterVocabulary:
    def test_focus_categories_are_the_pools_own(self):
        # A focus the pool never assigns would silently match nothing.
        from app.services.job_aggregator import CATEGORIES
        assert set(config.CATEGORIES) == set(CATEGORIES)

    def test_levels_only_drop_seniorities_the_pool_assigns(self):
        assigned = {"Junior", "Mid", "Senior"}
        assert all(set(dropped) <= assigned for dropped in config.LEVEL_EXCLUDES.values())
