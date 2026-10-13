"""Daily Matches Stage 2: strict schema, validation, fan-out and failure policy."""
import json

import httpx
import pytest
from anthropic import APIStatusError
from fastapi import HTTPException

import main as main_module
from daily_matches import config, reasoning
from daily_matches.text_prep import estimate_tokens
from tests.dm_helpers import FakeClaude

CVS = [
    reasoning.CvForPrompt("cv1", "main", "Backend", "Python Kafka AWS microservices " * 20),
    reasoning.CvForPrompt("cv2", "v-data", "Data", "Spark Airflow SQL " * 20),
]


def _jobs(n: int) -> list[reasoning.JobForPrompt]:
    return [reasoning.JobForPrompt(f"j{i}", f"JOB POSTING\nTitle: Backend {i}\nPython Kafka") for i in range(n)]


def _status_error_msg(status: int, message: str) -> APIStatusError:
    request = httpx.Request("POST", "https://api.anthropic.com/v1/messages")
    response = httpx.Response(status, request=request, json={"error": {"message": message}})
    return APIStatusError(message, response=response, body=None)


def _status_error(status: int) -> APIStatusError:
    request = httpx.Request("POST", "https://api.anthropic.com/v1/messages")
    response = httpx.Response(status, request=request, json={"error": {"message": "x"}})
    return APIStatusError("x", response=response, body=None)


class TestSchema:
    def test_strict_and_closed_everywhere(self):
        tool = reasoning.tool_schema(["cv1", "cv2"])
        assert tool["strict"] is True and tool["name"] == reasoning.TOOL_NAME

        def walk(node):
            if isinstance(node, dict):
                if node.get("type") == "object":
                    assert node["additionalProperties"] is False
                    assert set(node["required"]) == set(node["properties"])
                for key in ("minimum", "maximum", "minLength", "maxLength", "maxItems"):
                    assert key not in node, f"strict mode rejects {key}"
                for value in node.values():
                    walk(value)
            elif isinstance(node, list):
                for value in node:
                    walk(value)
        walk(tool["input_schema"])

    def test_aliases_not_user_ids_in_enum(self):
        schema = reasoning.tool_schema(["cv1", "cv2"])["input_schema"]
        assert schema["properties"]["best_cv_id"]["enum"] == ["cv1", "cv2"]

    def test_system_text_names_versions_by_alias(self):
        text = reasoning.build_system_text(CVS)
        assert '=== cv1 · label: "Backend" ===' in text and '=== cv2 · label: "Data" ===' in text
        assert "v-data" not in text  # the extension's own IDs never reach the model

    def test_analysis_comes_before_any_verdict(self):
        # A score field written first is a number picked before the analysis;
        # with no score field, the model can only classify.
        props = reasoning.tool_schema(["cv1"])["input_schema"]["properties"]
        assert list(props)[0] == "requirements" and "match_score" not in props
        assert set(props["caps"]["items"]["enum"]) == set(reasoning.CAPS)


def _req(text, importance="must", weight="core", status="met", kind="skill"):
    return {"text": text, "importance": importance, "weight": weight, "kind": kind, "status": status}


def _clearance(status):
    return _req("Security clearance", weight="supporting", status=status, kind="credential")


# Met items cost nothing: they let a test about the arithmetic stay clear of
# the few-requirements cap.
MET = [_req("Git", weight="supporting"), _req("REST APIs", weight="supporting")]


def _raw(reqs, **extra):
    return {"requirements": reqs, "years_required": 0, "years_relevant": 0, "caps": [], "offsets": [],
            "best_cv_id": "cv1", "cv_scores": [{"cv_id": "cv1", "score": 80}, {"cv_id": "cv2", "score": 60}],
            "top_gap_he": "  טוב  ", **extra}


class TestScore:
    def test_the_score_is_computed_from_the_classifications(self):
        out = reasoning.normalize_analysis(_raw([
            _req("Python", weight="primary"), _req("Kubernetes", status="partial"),
            _req("Go", importance="nice", weight="supporting", status="missing"),
        ], years_required=5, years_relevant=4), CVS)
        # 100 - 8 (Kubernetes, core partial) - 3 (Go, nice missing) - 6 (one year of five) = 83
        assert out["match_score"] == 83 and out["cap"] is None
        assert [b["points"] for b in out["breakdown"]] == [-8, -3, -6]
        assert out["breakdown"][2] == {"kind": "years", "required": 5, "relevant": 4, "points": -6}
        assert out["top_gap_he"] == "טוב" and "fit_summary_he" not in out

    def test_same_gaps_same_score(self):
        a = reasoning.normalize_analysis(_raw([_req("Java", weight="primary", status="missing"), _req("SQL")]), CVS)
        b = reasoning.normalize_analysis(_raw([_req("Go", weight="primary", status="missing"), _req("Redis")]), CVS)
        assert a["match_score"] == b["match_score"] == 65

    def test_nice_to_haves_cost_15_at_most(self):
        nice = [_req(f"tool {i}", importance="nice", weight="core", status="missing") for i in range(5)]
        out = reasoning.normalize_analysis(_raw([_req("Python", weight="primary")] + nice), CVS)
        assert out["match_score"] == 85

    def test_offsets_only_make_up_for_nice_gaps(self):
        both = ["strong_academics", "relevant_projects"]
        with_gap = reasoning.normalize_analysis(_raw([
            _req("Python", weight="primary", status="partial"),
            _req("Go", importance="nice", weight="supporting", status="missing")] + MET, offsets=both), CVS)
        assert with_gap["match_score"] == 100 - 12 - 3 + 3  # only the 3 the nice item cost comes back
        no_gap = reasoning.normalize_analysis(_raw([_req("Python", weight="primary", status="partial")] + MET,
                                                   offsets=both), CVS)
        assert no_gap["match_score"] == 88

    def test_the_lowest_cap_wins_and_is_reported(self):
        out = reasoning.normalize_analysis(_raw([_req("Python", weight="primary"), _clearance("missing")],
                                                caps=["level_unproven", "hard_blocker", "made_up"]), CVS)
        assert out["match_score"] == 40 and out["cap"] == {"name": "hard_blocker", "value": 40}

    def test_a_cap_above_the_score_does_nothing(self):
        out = reasoning.normalize_analysis(_raw([_req("Java", weight="primary", status="missing"),
                                                 _req("Spring", status="missing")], caps=["level_unproven"]), CVS)
        assert out["match_score"] == 45 and out["cap"] is None

    def test_a_posting_without_must_requirements_is_not_a_strong_match(self):
        out = reasoning.normalize_analysis(_raw([_req("Go", importance="nice", weight="supporting")]), CVS)
        assert out["match_score"] == reasoning.NO_REQUIREMENTS_CAP and out["cap"]["name"] == "no_requirements"

    def test_years_are_bounded_and_never_a_bonus(self):
        assert reasoning.normalize_analysis(_raw([_req("Python")] + MET, years_required=3, years_relevant=12),
                                            CVS)["match_score"] == 100
        out = reasoning.normalize_analysis(_raw([_req("Python")] + MET, years_required=5, years_relevant=-2), CVS)
        assert out["match_score"] == 70  # a negative count is read as none: the whole 30

    def test_a_posting_judged_on_one_or_two_items_is_not_a_strong_match(self):
        # What happened on a real posting with only responsibilities and an
        # Advantages list: one responsibility as its "must", met, and 100.
        thin = reasoning.normalize_analysis(_raw([_req("Develop end-to-end features")]), CVS)
        assert thin["match_score"] == 65 and thin["cap"] == {"name": "few_requirements", "value": 65}
        enough = reasoning.normalize_analysis(_raw([_req("Java", weight="primary")] + MET), CVS)
        assert enough["match_score"] == 100 and enough["cap"] is None

    def test_the_rubric_never_lets_a_responsibility_become_a_must(self):
        assert "Never turn a responsibility into" in reasoning.RUBRIC
        assert "never leave out the advantages" in reasoning.RUBRIC
        assert "fewer than three requirements" in reasoning.RUBRIC

    def test_other_versions_keep_their_gap_to_the_best(self):
        out = reasoning.normalize_analysis(_raw([_req("Python", status="partial")] + MET), CVS)
        assert out["match_score"] == 92
        assert {s["cv_id"]: s["score"] for s in out["cv_scores"]} == {"main": 92, "v-data": 72}
        assert out["cv_scores"][0]["label"] == "Backend" and out["best_cv_ref"] == "main"

    def test_unknown_alias_falls_back_to_the_best_rated(self):
        out = reasoning.normalize_analysis(_raw([_req("SQL")], best_cv_id="cv9",
                                                cv_scores=[{"cv_id": "cv1", "score": 40},
                                                           {"cv_id": "cv2", "score": 60}]), CVS)
        assert out["best_cv_ref"] == "v-data"

    def test_requirements_filtered_ordered_and_capped(self):
        reqs = [_req(f"nice {i}", importance="nice", weight="supporting") for i in range(5)]
        reqs += [_req(f"must {i}", status="missing") for i in range(8)]
        reqs += [_req(""), _req("bad", status="maybe"), _req("odd", weight="huge")]
        out = reasoning.normalize_analysis(_raw(reqs), CVS)
        assert len(out["requirements"]) == reasoning.MAX_REQUIREMENTS
        assert [r["importance"] for r in out["requirements"][:5]] == ["must"] * 5
        assert all(r["text"] not in ("", "bad", "odd") for r in out["requirements"])

    def test_wrong_shape_is_none(self):
        assert reasoning.normalize_analysis({"requirements": []}, CVS) is None


class TestThePlainQuestion:
    """The admins' comparison: the question the owner would ask any chat
    model, with no rubric, no checklist and no score."""

    def test_the_prompt_is_the_question_and_the_cvs_only(self):
        text = reasoning.build_honest_text(CVS, "Driver's license: yes")
        assert '=== cv1 · label: "Backend" ===' in text and "Driver's license: yes" in text
        assert "Start at 100" not in text and "THE ARITHMETIC" not in text and "importance" not in text
        # How hiring really works, as the owner put it after marking a deck.
        for idea in ("Nobody's CV mirrors a posting", "usually a tool", "Node.js mentioned once is Node.js they know",
                     "never call one unsuitable for being junior to them", "Be honest, not encouraging"):
            assert idea in text, idea
        job = _jobs(1)[0]
        assert reasoning.user_text(job, reasoning.HONEST).endswith(reasoning.HONEST_QUESTION)
        assert reasoning.user_text(job) == job.text  # the scored method's user turn is unchanged

    def test_the_tool_asks_the_answer_before_the_word(self):
        tool = reasoning.honest_schema(["cv1", "cv2"])
        props = tool["input_schema"]["properties"]
        assert tool["strict"] is True and list(props) == ["answer_he", "verdict", "best_cv_id", "cv_tip_he"]
        assert set(tool["input_schema"]["required"]) == set(props) and tool["input_schema"]["additionalProperties"] is False
        assert props["verdict"]["enum"] == ["strong", "fit", "borderline", "no"]

    def test_a_verdict_maps_to_the_decks_tiers(self):
        out = reasoning.normalize_honest({"answer_he": "  מתאימה, שווה לשלוח.  ", "verdict": "fit",
                                          "best_cv_id": "cv2", "cv_tip_he": " להבליט את Spark. "}, CVS)
        assert out == {"method": "honest", "verdict": "fit", "tier": "strong", "answer_he": "מתאימה, שווה לשלוח.",
                       "best_cv_ref": "v-data", "cv_tip_he": "להבליט את Spark."}
        no_fit = reasoning.normalize_honest({"answer_he": "לא.", "verdict": "no", "best_cv_id": "cv1",
                                             "cv_tip_he": "להוסיף Go"}, CVS)
        assert no_fit["cv_tip_he"] == ""  # no tip for a job not worth an application

    def test_tool_markup_that_leaks_into_the_text_is_cut(self):
        # Seen on a real deck: the rest of the tool call inside the string.
        leaked = 'שם הפער קטן בהרבה.</answer_he> <parameter name="verdict">borderline'
        out = reasoning.normalize_honest({"answer_he": "מתאימה בחלקה. " + leaked, "verdict": "borderline",
                                          "best_cv_id": "cv1", "cv_tip_he": leaked}, CVS)
        assert out["answer_he"] == "מתאימה בחלקה. שם הפער קטן בהרבה." and out["cv_tip_he"] == ""
        assert reasoning.until_markup("C# <b>ו-.NET</b>") == "C# <b>ו-.NET</b>"  # other text is left alone
        assert reasoning.normalize_honest({"answer_he": "</answer_he>", "verdict": "fit", "best_cv_id": "cv1"},
                                          CVS) is None
        scored = reasoning.normalize_analysis(_raw([_req("Python")] + MET, top_gap_he="חסר Go.</top_gap_he>"), CVS)
        assert scored["top_gap_he"] == "חסר Go."

    def test_the_level_reminder_sits_next_to_the_question(self):
        assert "ברמה נמוכה מהניסיון שלי לא פוסלת" in reasoning.HONEST_QUESTION
        assert "בלי להתעכב על הרמה" in reasoning.HONEST_QUESTION  # so the answers don't dwell on it
        assert "formally takes only people without experience" in reasoning.HONEST_SYSTEM
        assert reasoning.normalize_honest({"answer_he": "x", "verdict": "borderline", "best_cv_id": "cv9"},
                                          CVS)["best_cv_ref"] == "main"
        assert reasoning.normalize_honest({"answer_he": "", "verdict": "fit", "best_cv_id": "cv1"}, CVS) is None
        assert reasoning.normalize_honest({"answer_he": "x", "verdict": "maybe", "best_cv_id": "cv1"}, CVS) is None
        assert reasoning.normalize_honest({"verdict": "fit"}, CVS) is None

    async def test_every_job_gets_the_plain_question(self, monkeypatch):
        fake = FakeClaude()
        monkeypatch.setattr(main_module, "_ac", lambda: fake)
        results, usage = await reasoning.analyze_jobs(CVS, _jobs(3), method="honest")
        assert all(r["method"] == "honest" and r["verdict"] in reasoning.HONEST_TIERS for r in results.values())
        assert all(c["tool_choice"] == {"type": "tool", "name": "submit_verdict"} for c in fake.calls)
        assert all(c["messages"][0]["content"].endswith(reasoning.HONEST_QUESTION) for c in fake.calls)
        assert "THE ARITHMETIC" not in fake.calls[0]["system"][0]["text"] and usage["output_tokens"] == 600


class TestCredentials:
    """What a CV leaves out (a driver's license, a degree, a clearance) is
    asked about, not held against the candidate."""

    def test_an_unknown_credential_costs_nothing_and_is_to_confirm(self):
        out = reasoning.normalize_analysis(_raw([
            _req("Linux", weight="primary"), _req("Python"),
            _req("Driver's license", weight="supporting", status="unknown", kind="credential")]), CVS)
        assert out["match_score"] == 100 and out["breakdown"] == []
        assert out["to_confirm"] == ["Driver's license"]
        assert out["requirements"][2]["status"] == "unknown" and out["requirements"][2]["kind"] == "credential"

    def test_a_skill_is_never_unknown(self):
        out = reasoning.normalize_analysis(_raw([_req("Kafka", status="unknown")] + MET), CVS)
        assert out["requirements"][0]["status"] == "missing" and out["match_score"] == 80
        assert out["to_confirm"] == []

    def test_a_missing_kind_reads_as_a_skill(self):
        raw = _raw([{"text": "Kafka", "importance": "must", "weight": "core", "status": "unknown"}] + MET)
        assert reasoning.normalize_analysis(raw, CVS)["requirements"][0] == {
            "text": "Kafka", "importance": "must", "weight": "core", "kind": "skill", "status": "missing"}

    def test_hard_blocker_needs_a_credential_the_evidence_shows_missing(self):
        reqs = [_req("Python", weight="primary")] + MET
        assert reasoning.normalize_analysis(_raw(reqs + [_clearance("unknown")], caps=["hard_blocker"]),
                                            CVS)["cap"] is None
        assert reasoning.normalize_analysis(_raw(reqs, caps=["hard_blocker"]), CVS)["cap"] is None
        out = reasoning.normalize_analysis(_raw(reqs + [_clearance("missing")], caps=["hard_blocker"]), CVS)
        assert out["cap"] == {"name": "hard_blocker", "value": 40}

    def test_domain_mismatch_is_not_another_stack_of_the_same_discipline(self):
        # A full-stack developer facing a C# full-stack role: C# costs its points, no more.
        reqs = [_req("C#", weight="primary", status="missing"), _req("JavaScript"), _req("HTML"), _req("SQL")]
        out = reasoning.normalize_analysis(_raw(reqs, caps=["domain_mismatch"]), CVS)
        assert out["match_score"] == 65 and out["cap"] is None
        partial = [_req("C#", weight="primary", status="partial"), _req("ASP.NET", status="missing")] + MET
        assert reasoning.normalize_analysis(_raw(partial, caps=["domain_mismatch"]), CVS)["cap"] is None

    def test_domain_mismatch_stays_for_a_whole_other_domain(self):
        reqs = [_req("SystemVerilog", weight="primary", status="missing"), _req("UVM", status="missing"),
                _req("Git", weight="supporting")]
        assert reasoning._consistent_caps(reqs, ["domain_mismatch", "made_up"]) == {"domain_mismatch"}
        nice_only = [_req("Verilog", importance="nice", weight="supporting", status="missing")]
        assert reasoning._consistent_caps(nice_only, ["domain_mismatch"]) == {"domain_mismatch"}

    def test_the_candidates_answers_reach_the_prompt(self):
        facts = reasoning.render_facts({"degree": "bachelor", "degreeField": "Computer Science", "license": "yes",
                                        "english": "fluent", "psychometric": "712", "clearance": "past",
                                        "notes": "C# and .NET in a work project, 2023"})
        assert facts.splitlines()[:5] == [
            "Academic degree: a bachelor's degree, in Computer Science", "Driver's license: yes",
            "English: fluent", "Psychometric score: 712", "Security clearance: held one in the past"]
        assert facts.endswith("C# and .NET in a work project, 2023")
        text = reasoning.build_system_text(CVS, facts)
        assert text.index("=== end of cv2 ===") < text.index("THE CANDIDATE'S OWN ANSWERS") < text.index("Driver's license: yes")
        assert reasoning.build_system_text(CVS).endswith("None given.")

    def test_unknown_answers_are_left_out(self):
        assert reasoning.render_facts({"degree": "wizard", "license": "maybe", "psychometric": "1200",
                                       "english": "", "clearance": None}) == ""
        assert reasoning.render_facts(None) == ""
        assert reasoning.render_facts({"degree": "none", "degreeField": "x"}) == "Academic degree: none"

    def test_the_schema_and_rubric_know_credentials(self):
        item = reasoning.tool_schema(["cv1"])["input_schema"]["properties"]["requirements"]["items"]
        assert item["properties"]["kind"]["enum"] == ["skill", "credential"]
        assert "unknown" in item["properties"]["status"]["enum"]
        assert "A skill is never unknown" in reasoning.RUBRIC
        assert "An unknown item costs" in reasoning.RUBRIC


class TestFanOut:
    async def test_every_job_analyzed_with_forced_strict_tool(self, monkeypatch):
        fake = FakeClaude()
        monkeypatch.setattr(main_module, "_ac", lambda: fake)
        progress = []
        results, usage = await reasoning.analyze_jobs(CVS, _jobs(15), on_progress=lambda d, t: progress.append((d, t)))
        assert set(results) == {f"j{i}" for i in range(15)} and all(results.values())
        assert len(fake.calls) == 15
        call = fake.calls[0]
        assert call["model"] == config.LLM_MODEL
        assert call["tool_choice"] == {"type": "tool", "name": reasoning.TOOL_NAME}
        assert call["tools"][0]["strict"] is True
        assert progress[-1] == (15, 15)
        assert usage["input_tokens"] == 15 * 1000 and usage["output_tokens"] == 15 * 300

    async def test_short_prefix_is_not_cached_and_fans_out_at_once(self, monkeypatch):
        fake = FakeClaude(delay=0.05)
        monkeypatch.setattr(main_module, "_ac", lambda: fake)
        monkeypatch.setattr(config, "CACHE_MIN_TOKENS", 10 ** 6)
        await reasoning.analyze_jobs(CVS, _jobs(5))
        assert "cache_control" not in fake.calls[0]["system"][0]
        assert max(fake.started_at) - min(fake.started_at) < 0.04

    def test_rubric_and_tool_alone_reach_the_cache_minimum(self):
        # The point of the long rubric: even a one-paragraph CV gets the 90%
        # cache discount on every call after the first.
        tool = json.dumps(reasoning.tool_schema(["cv1"]))
        assert estimate_tokens(reasoning.RUBRIC) + estimate_tokens(tool) >= config.CACHE_MIN_TOKENS

    async def test_short_cv_prefix_is_cached(self, monkeypatch):
        fake = FakeClaude()
        monkeypatch.setattr(main_module, "_ac", lambda: fake)
        monkeypatch.setattr(config, "WARMUP_DELAY_S", 0.01)
        await reasoning.analyze_jobs([reasoning.CvForPrompt("cv1", "main", "Backend", "Python developer " * 20)],
                                     _jobs(2))
        assert fake.calls[0]["system"][0]["cache_control"] == {"type": "ephemeral"}

    async def test_long_prefix_is_cached_and_warmed_first(self, monkeypatch):
        long_cvs = [reasoning.CvForPrompt("cv1", "main", "Backend", "Python Kafka AWS microservices " * 600)]
        fake = FakeClaude(delay=0.05)
        monkeypatch.setattr(main_module, "_ac", lambda: fake)
        monkeypatch.setattr(config, "WARMUP_DELAY_S", 0.2)
        await reasoning.analyze_jobs(long_cvs, _jobs(4))
        assert fake.calls[0]["system"][0]["cache_control"] == {"type": "ephemeral"}
        first, rest = fake.started_at[0], fake.started_at[1:]
        # The first call finished (0.05 s) before the 0.2 s timeout, so the rest
        # start as soon as it does, never alongside it.
        assert all(t - first >= 0.04 for t in rest)

    async def test_the_rest_wait_for_the_first_answer_not_a_fixed_second(self, monkeypatch):
        # Haiku 5.5 took longer than 1.2 s to start answering a 15K-token
        # prefix; calls sent before that wrote the cache instead of reading it.
        long_cvs = [reasoning.CvForPrompt("cv1", "main", "Backend", "Python Kafka AWS microservices " * 600)]
        fake = FakeClaude(delay=0.3)
        monkeypatch.setattr(main_module, "_ac", lambda: fake)
        await reasoning.analyze_jobs(long_cvs, _jobs(4))
        first, rest = fake.started_at[0], fake.started_at[1:]
        assert config.WARMUP_DELAY_S >= 10 and all(t - first >= 0.29 for t in rest)

    async def test_isolated_failure_becomes_empty_card(self, monkeypatch):
        fake = FakeClaude(fail_when=lambda text: "Backend 3" in text, error_factory=lambda: _status_error(400))
        monkeypatch.setattr(main_module, "_ac", lambda: fake)
        results, _ = await reasoning.analyze_jobs(CVS, _jobs(6))
        assert results["j3"] is None and sum(v is not None for v in results.values()) == 5

    async def test_systemic_failure_raises_user_facing_error(self, monkeypatch):
        fake = FakeClaude(fail_when=lambda text: True, error_factory=lambda: _status_error(429))
        monkeypatch.setattr(main_module, "_ac", lambda: fake)
        with pytest.raises(HTTPException) as info:
            await reasoning.analyze_jobs(CVS, _jobs(4))
        assert "[jma:AI_RATE_LIMIT]" in str(info.value.detail)

    async def test_retryable_error_is_retried_once(self, monkeypatch):
        attempts = {"n": 0}

        def flaky(text):
            attempts["n"] += 1
            return attempts["n"] == 1

        fake = FakeClaude(fail_when=flaky, error_factory=lambda: _status_error(529))
        monkeypatch.setattr(main_module, "_ac", lambda: fake)
        monkeypatch.setattr(reasoning, "_retry_pause", _no_sleep)
        results, _ = await reasoning.analyze_jobs(CVS, _jobs(1))
        assert results["j0"] is not None and len(fake.calls) == 2

    async def test_truncated_output_is_not_trusted(self, monkeypatch):
        fake = FakeClaude()
        real = fake.messages.create

        async def create(**kwargs):
            message = await real(**kwargs)
            if "Backend 1" in kwargs["messages"][0]["content"]:
                message.stop_reason = "max_tokens"
            return message
        monkeypatch.setattr(fake.messages, "create", create)
        monkeypatch.setattr(main_module, "_ac", lambda: fake)
        results, _ = await reasoning.analyze_jobs(CVS, _jobs(4))
        assert results["j1"] is None and all(results[j] for j in ("j0", "j2", "j3"))

    async def test_a_cut_off_answer_is_asked_again_with_room_to_finish(self, monkeypatch):
        fake = FakeClaude()
        real = fake.messages.create
        tries = {}

        async def create(**kwargs):
            message = await real(**kwargs)
            job = kwargs["messages"][0]["content"]
            tries[job] = tries.get(job, 0) + 1
            if "Backend 1" in job and tries[job] == 1:
                message.stop_reason = "max_tokens"
            return message
        monkeypatch.setattr(fake.messages, "create", create)
        monkeypatch.setattr(main_module, "_ac", lambda: fake)
        results, usage = await reasoning.analyze_jobs(CVS, _jobs(3))
        assert all(results.values())
        again = [c for c in fake.calls if "Backend 1" in c["messages"][0]["content"]]
        assert [c["max_tokens"] for c in again] == [config.LLM_MAX_TOKENS, config.LLM_MAX_TOKENS_AUTO]
        assert usage["output_tokens"] == 4 * 300  # both answers are paid for

    async def test_a_rate_limited_call_waits_and_tries_again(self, monkeypatch):
        # A 250-job first deck can hit the account's per-minute limit.
        fake = FakeClaude()
        real = fake.messages.create
        refused = []

        async def create(**kwargs):
            if len(refused) < 3:
                refused.append(1)
                raise _status_error(429)
            return await real(**kwargs)
        monkeypatch.setattr(fake.messages, "create", create)
        monkeypatch.setattr(main_module, "_ac", lambda: fake)
        results, _ = await reasoning.analyze_jobs(CVS, _jobs(1))
        assert results["j0"] and len(refused) == 3

    async def test_an_answer_without_the_tool_call_is_asked_again(self, monkeypatch):
        fake = FakeClaude()
        real = fake.messages.create
        first = []

        async def create(**kwargs):
            message = await real(**kwargs)
            if not first:
                first.append(1)
                message.content = []
            return message
        monkeypatch.setattr(fake.messages, "create", create)
        monkeypatch.setattr(main_module, "_ac", lambda: fake)
        results, _ = await reasoning.analyze_jobs(CVS, _jobs(1))
        assert results["j0"] and len(fake.calls) == 2

    async def test_unusable_answers_count_as_failures_too(self, monkeypatch):
        # A deck must never be built quietly from the few answers that got through.
        fake = FakeClaude(stop_reason="max_tokens")
        monkeypatch.setattr(main_module, "_ac", lambda: fake)
        with pytest.raises(HTTPException):
            await reasoning.analyze_jobs(CVS, _jobs(4))

    async def test_answers_without_the_tool_call_count_too(self, monkeypatch):
        fake = FakeClaude()
        real = fake.messages.create

        async def create(**kwargs):
            message = await real(**kwargs)
            message.content = []
            return message
        monkeypatch.setattr(fake.messages, "create", create)
        monkeypatch.setattr(main_module, "_ac", lambda: fake)
        with pytest.raises(HTTPException):
            await reasoning.analyze_jobs(CVS, _jobs(3))


class TestModels:
    async def test_sonnet_gets_auto_tool_choice_and_no_thinking(self, monkeypatch):
        # Sonnet 5.5 rejects a forced tool_choice with a 400, and thinks by default.
        fake = FakeClaude()
        monkeypatch.setattr(main_module, "_ac", lambda: fake)
        results, _ = await reasoning.analyze_jobs(CVS, _jobs(2), model="claude-sonnet-5-5")
        assert all(results.values())
        call = fake.calls[0]
        assert call["model"] == "claude-sonnet-5-5"
        assert call["tool_choice"] == {"type": "auto"}
        assert call["extra_body"] == {"thinking": {"type": "between_tools"}}
        assert call["tools"][0]["strict"] is True

    def test_haiku_keeps_the_forced_tool(self):
        assert reasoning._model_kwargs(config.LLM_MODEL) == {
            "tool_choice": {"type": "tool", "name": reasoning.TOOL_NAME}}

    def test_cost_uses_each_models_prices(self):
        usage = {"input_tokens": 1_000_000, "output_tokens": 0, "cache_read_tokens": 0, "cache_write_tokens": 0}
        assert config.LLM_MODEL == "claude-haiku-5-5" and config.usage_cost(usage) == pytest.approx(0.10)
        assert config.usage_cost(usage, "claude-haiku-4-5-20251001") == 1.0
        assert config.usage_cost(usage, "claude-sonnet-5-5") == 2.0

    async def test_a_refused_forced_tool_call_falls_back_to_auto(self, monkeypatch):
        fake = FakeClaude()
        real_create = fake.messages.create

        async def create(**kwargs):
            if kwargs["tool_choice"]["type"] == "tool":
                fake.calls.append(kwargs)
                raise _status_error_msg(400, "tool_choice: forced tool use is not supported with this model")
            return await real_create(**kwargs)
        monkeypatch.setattr(fake.messages, "create", create)
        monkeypatch.setattr(main_module, "_ac", lambda: fake)
        monkeypatch.setattr(reasoning, "_forced_tool_refused", set())
        results, _ = await reasoning.analyze_jobs(CVS, _jobs(3))
        assert all(results.values())
        forced = [c for c in fake.calls if c["tool_choice"]["type"] == "tool"]
        auto = [c for c in fake.calls if c["tool_choice"]["type"] == "auto"]
        assert 1 <= len(forced) < 3 and len(auto) == 3  # once refused, the rest go straight to auto
        assert all(c["max_tokens"] == config.LLM_MAX_TOKENS_AUTO for c in auto)

    async def test_other_bad_requests_still_fail(self, monkeypatch):
        fake = FakeClaude(fail_when=lambda _: True, error_factory=lambda: _status_error_msg(400, "prompt is too long"))
        monkeypatch.setattr(main_module, "_ac", lambda: fake)
        monkeypatch.setattr(reasoning, "_forced_tool_refused", set())
        with pytest.raises(HTTPException):
            await reasoning.analyze_jobs(CVS, _jobs(2))
        assert all(c["tool_choice"]["type"] == "tool" for c in fake.calls)


async def _no_sleep():
    return None


class TestOpenRouter:
    """The comparison path: same rubric, CVs and schema, through OpenRouter."""

    @pytest.fixture
    def fake(self, monkeypatch):
        from tests.dm_openrouter import FakeOpenRouter
        fake = FakeOpenRouter()
        monkeypatch.setattr(config, "OPENROUTER_KEY", "or-test-key")
        monkeypatch.setattr(reasoning, "_openrouter_transport", fake.transport())
        monkeypatch.setattr(reasoning, "_retry_pause", _no_pause)
        return fake

    def test_the_request_keeps_cvs_away_from_retaining_hosts(self):
        body = reasoning.openrouter_body("deepseek/deepseek-v4.1-flash", "SYSTEM", reasoning.tool_schema(["cv1"]),
                                         reasoning.JobForPrompt("j1", "JOB"))
        assert body["provider"]["zdr"] is True and body["provider"]["data_collection"] == "deny"
        assert "deepseek" in body["provider"]["ignore"]  # never DeepSeek's own servers
        assert body["provider"]["require_parameters"] is True
        fn = body["tools"][0]["function"]
        assert fn["name"] == reasoning.TOOL_NAME and fn["strict"] is True
        assert fn["parameters"] == reasoning.tool_schema(["cv1"])["input_schema"]  # the very same schema
        assert body["tool_choice"] == {"type": "function", "function": {"name": reasoning.TOOL_NAME}}
        assert body["messages"][0] == {"role": "system", "content": "SYSTEM"} and body["usage"] == {"include": True}
        assert "reasoning" not in body

    def test_reasoning_effort_is_a_setting(self, monkeypatch):
        monkeypatch.setattr(config, "OPENROUTER_REASONING", "low")
        body = reasoning.openrouter_body("m", "S", reasoning.tool_schema(["cv1"]), reasoning.JobForPrompt("j", "J"))
        assert body["reasoning"] == {"effort": "low"}

    async def test_analyzes_with_the_same_rubric_and_reports_cost(self, fake):
        results, usage = await reasoning.analyze_jobs(CVS, _jobs(3), model="openrouter:deepseek/deepseek-v4.1-flash")
        assert set(results) == {"j0", "j1", "j2"} and all(r and isinstance(r["match_score"], int) for r in results.values())
        assert fake.requests[0]["model"] == "deepseek/deepseek-v4.1-flash"
        assert reasoning.build_system_text(CVS) == fake.requests[0]["messages"][0]["content"]
        assert fake.headers[0]["authorization"] == "Bearer or-test-key"
        assert results["j0"]["_cost_usd"] == pytest.approx(0.0004) and results["j0"]["_provider"] == "DeepInfra"
        assert usage["cost_usd"] == pytest.approx(0.0012) and config.usage_cost(usage, "x") == pytest.approx(0.0012)
        assert usage["cache_read_tokens"] == 3 * 4100 and usage["input_tokens"] == 3 * 1100

    async def test_a_busy_host_is_retried_once(self, fake):
        fake.fail_status, fake.fail_times = 429, 1
        results, _ = await reasoning.analyze_jobs(CVS, _jobs(1), model="openrouter:m")
        assert results["j0"] is not None and len(fake.requests) == 2

    async def test_no_tool_call_is_a_failed_job_not_a_failed_run(self, fake):
        fake.no_tool_for = "Backend 1"
        results, _ = await reasoning.analyze_jobs(CVS, _jobs(3), model="openrouter:m")
        assert results["j1"] is None and results["j0"] and results["j2"]

    async def test_half_failing_is_systemic(self, fake):
        fake.fail_status, fake.fail_times = 401, None
        with pytest.raises(RuntimeError):
            await reasoning.analyze_jobs(CVS, _jobs(2), model="openrouter:m")

    async def test_without_a_key_it_never_calls(self, fake, monkeypatch):
        monkeypatch.setattr(config, "OPENROUTER_KEY", "")
        with pytest.raises(RuntimeError, match="DM_OPENROUTER_KEY"):
            await reasoning.analyze_jobs(CVS, _jobs(1), model="openrouter:m")
        assert fake.requests == []


async def _no_pause():
    return None
