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


def _req(text, importance="must", weight="core", status="met"):
    return {"text": text, "importance": importance, "weight": weight, "status": status}


def _raw(reqs, **extra):
    return {"requirements": reqs, "years_required": 0, "years_relevant": 0, "caps": [], "offsets": [],
            "best_cv_id": "cv1", "cv_scores": [{"cv_id": "cv1", "score": 80}, {"cv_id": "cv2", "score": 60}],
            "fit_summary_he": "  טוב  ", "cv_choice_reason_he": "", "top_gap_he": "", **extra}


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
        assert out["fit_summary_he"] == "טוב"

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
            _req("Go", importance="nice", weight="supporting", status="missing")], offsets=both), CVS)
        assert with_gap["match_score"] == 100 - 12 - 3 + 3  # only the 3 the nice item cost comes back
        no_gap = reasoning.normalize_analysis(_raw([_req("Python", weight="primary", status="partial")],
                                                   offsets=both), CVS)
        assert no_gap["match_score"] == 88

    def test_the_lowest_cap_wins_and_is_reported(self):
        out = reasoning.normalize_analysis(_raw([_req("Python", weight="primary")],
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
        assert reasoning.normalize_analysis(_raw([_req("Python")], years_required=3, years_relevant=12),
                                            CVS)["match_score"] == 100
        out = reasoning.normalize_analysis(_raw([_req("Python")], years_required=5, years_relevant=-2), CVS)
        assert out["match_score"] == 70  # a negative count is read as none: the whole 30

    def test_other_versions_keep_their_gap_to_the_best(self):
        out = reasoning.normalize_analysis(_raw([_req("Python", status="partial")]), CVS)
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
        fake = FakeClaude(stop_reason="max_tokens")
        monkeypatch.setattr(main_module, "_ac", lambda: fake)
        results, _ = await reasoning.analyze_jobs(CVS, _jobs(1))
        assert results["j0"] is None


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
        assert config.usage_cost(usage) == 1.0
        assert config.usage_cost(usage, "claude-sonnet-5-5") == 2.0


async def _no_sleep():
    return None
