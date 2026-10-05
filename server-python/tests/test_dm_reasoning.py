"""Daily Matches Stage 2: strict schema, validation, fan-out and failure policy."""
import httpx
import pytest
from anthropic import APIStatusError
from fastapi import HTTPException

import main as main_module
from daily_matches import config, reasoning
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


class TestNormalize:
    def test_clamps_and_maps_to_refs(self):
        out = reasoning.normalize_analysis({
            "match_score": 140, "best_cv_id": "cv2",
            "cv_scores": [{"cv_id": "cv1", "score": -5}, {"cv_id": "cv2", "score": 70}],
            "requirements": [], "fit_summary_he": "  טוב  ", "cv_choice_reason_he": "", "top_gap_he": "",
        }, CVS)
        assert out["match_score"] == 100
        assert out["best_cv_ref"] == "v-data"
        assert {s["cv_id"]: s["score"] for s in out["cv_scores"]} == {"main": 0, "v-data": 100}
        assert out["cv_scores"][0]["label"] == "Backend"
        assert out["fit_summary_he"] == "טוב"

    def test_unknown_alias_falls_back_to_best_scored(self):
        out = reasoning.normalize_analysis({
            "match_score": 60, "best_cv_id": "cv9",
            "cv_scores": [{"cv_id": "cv1", "score": 40}, {"cv_id": "cv2", "score": 60}],
            "requirements": [],
        }, CVS)
        assert out["best_cv_ref"] == "v-data"

    def test_requirements_filtered_ordered_and_capped(self):
        reqs = [{"text": f"nice {i}", "status": "met", "importance": "nice"} for i in range(5)]
        reqs += [{"text": f"must {i}", "status": "missing", "importance": "must"} for i in range(5)]
        reqs += [{"text": "", "status": "met", "importance": "must"},
                 {"text": "bad", "status": "maybe", "importance": "must"}]
        out = reasoning.normalize_analysis({"match_score": 50, "best_cv_id": "cv1", "requirements": reqs}, CVS)
        assert len(out["requirements"]) == reasoning.MAX_REQUIREMENTS
        assert [r["importance"] for r in out["requirements"][:5]] == ["must"] * 5
        assert all(r["text"] not in ("", "bad") for r in out["requirements"])

    def test_wrong_shape_is_none(self):
        assert reasoning.normalize_analysis({"best_cv_id": "cv1"}, CVS) is None


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
        await reasoning.analyze_jobs(CVS, _jobs(5))
        assert "cache_control" not in fake.calls[0]["system"][0]
        assert max(fake.started_at) - min(fake.started_at) < 0.04

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


async def _no_sleep():
    return None
