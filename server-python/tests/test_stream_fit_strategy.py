"""Tests for the single-flow streaming fit-analysis feature.

Covers:
- _split_strategy_stream(): the ###STRATEGY### marker parser (valid, malformed
  JSON, missing marker — all must fail open to {"fit_type": "high_fit",
  "questions": []} so CV generation is never blocked on the analysis stream).
- GenerateCVRequest.strategyChoices field.
- generate_cv(): the decisions block is appended to pass1 (and only pass1),
  and the checklist line is appended to pass2 (and only pass2), exclusively
  when strategyChoices is non-empty. When empty, prompts are unaffected.
"""
import sys
from pathlib import Path
from unittest.mock import AsyncMock

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import main as main_module
from main import GenerateCVRequest, _split_strategy_stream

_DUMMY_CV = (
    "[NAME]\nJohn Doe\n[HEADLINE]\nBackend Developer\n[CONTACT]\nemail@x.com\n"
    "[PROFILE]\nProfile text\n[EXPERIENCE]\nExperience text\n[EDUCATION]\nEducation text\n"
    "[SKILLS]\nPython\n[LANGUAGES]\nEnglish"
)


class TestSplitStrategyStream:
    def test_valid_strategy_marker(self):
        text = (
            "הקורות חיים שלך מתאימים היטב לתפקיד בזכות ניסיון בפייתון ו-FastAPI.\n"
            "מומלץ להדגיש את הפרויקטים הרלוונטיים.\n"
            '###STRATEGY###{"fit_type":"niche_fit","questions":['
            '{"id":"q1","question":"לצמצם ניסיון בתחום X?","context":"התפקיד ממוקד בתחום X",'
            '"options":[{"id":"opt1","label":"לצמצם למינימום"},{"id":"opt2","label":"לשמור על הפירוט"}],'
            '"recommended":"opt1"}]}'
        )
        prose, strategy = _split_strategy_stream(text)
        assert "הקורות חיים שלך מתאימים" in prose
        assert "###STRATEGY###" not in prose
        assert strategy["fit_type"] == "niche_fit"
        assert len(strategy["questions"]) == 1
        assert strategy["questions"][0]["recommended"] == "opt1"

    def test_high_fit_forces_empty_questions_field_passthrough(self):
        text = '###STRATEGY###{"fit_type":"high_fit","questions":[]}'
        _, strategy = _split_strategy_stream(text)
        assert strategy == {"fit_type": "high_fit", "questions": []}

    def test_malformed_json_fails_open(self):
        text = "טקסט חופשי כלשהו על ההתאמה.\n###STRATEGY###{this is not valid json"
        prose, strategy = _split_strategy_stream(text)
        assert strategy == {"fit_type": "high_fit", "questions": []}
        assert "טקסט חופשי" in prose

    def test_missing_marker_fails_open(self):
        text = "טקסט חופשי בלי סמן בכלל."
        prose, strategy = _split_strategy_stream(text)
        assert prose == text
        assert strategy == {"fit_type": "high_fit", "questions": []}

    def test_invalid_fit_type_defaults_to_high_fit(self):
        text = '###STRATEGY###{"fit_type":"something_weird","questions":[]}'
        _, strategy = _split_strategy_stream(text)
        assert strategy["fit_type"] == "high_fit"

    def test_non_list_questions_defaults_to_empty(self):
        text = '###STRATEGY###{"fit_type":"niche_fit","questions":"oops"}'
        _, strategy = _split_strategy_stream(text)
        assert strategy["questions"] == []


class TestGenerateCVRequestSchema:
    def test_strategy_choices_defaults_empty(self):
        req = GenerateCVRequest(cvText="x", jobText="y")
        assert req.strategyChoices == []

    def test_strategy_choices_accepted(self):
        req = GenerateCVRequest(
            cvText="x", jobText="y",
            strategyChoices=[{"question": "q", "chosen": "a"}],
        )
        assert req.strategyChoices == [{"question": "q", "chosen": "a"}]


class TestGenerateCVStrategyInjection:
    @pytest.mark.asyncio
    async def test_no_strategy_choices_prompt_unchanged(self, monkeypatch):
        prompts = []

        async def fake_cached_call(rendered_prompt, max_tokens, model,
                                   check_truncation=False, extra_note=""):
            prompts.append(rendered_prompt)
            return _DUMMY_CV

        monkeypatch.setattr(main_module, "_call_with_cached_prefix", fake_cached_call)
        monkeypatch.setattr(main_module, "require_license", AsyncMock(return_value="lic"))
        monkeypatch.setattr(main_module, "increment_usage", lambda k: 1)

        body = GenerateCVRequest(cvText="CV text", jobText="Job text", strategyChoices=[])
        await main_module.generate_cv(body, x_license_key="lic")

        assert len(prompts) >= 2
        pass1_prompt, pass2_prompt = prompts[0], prompts[1]
        assert "USER STRATEGY DECISIONS" not in pass1_prompt
        assert "Verify the USER STRATEGY DECISIONS" not in pass2_prompt

    @pytest.mark.asyncio
    async def test_strategy_choices_injected_into_pass1_only(self, monkeypatch):
        prompts = []

        async def fake_cached_call(rendered_prompt, max_tokens, model,
                                   check_truncation=False, extra_note=""):
            prompts.append(rendered_prompt)
            return _DUMMY_CV

        monkeypatch.setattr(main_module, "_call_with_cached_prefix", fake_cached_call)
        monkeypatch.setattr(main_module, "require_license", AsyncMock(return_value="lic"))
        monkeypatch.setattr(main_module, "increment_usage", lambda k: 1)

        choices = [{"question": "לצמצם את תפקיד X?", "chosen": "לצמצם למינימום"}]
        body = GenerateCVRequest(cvText="CV text", jobText="Job text", strategyChoices=choices)
        await main_module.generate_cv(body, x_license_key="lic")

        pass1_prompt, pass2_prompt = prompts[0], prompts[1]

        assert "USER STRATEGY DECISIONS — these override default tailoring behavior, follow exactly:" in pass1_prompt
        assert "- לצמצם את תפקיד X? → user chose: לצמצם למינימום" in pass1_prompt

        # pass2 gets only the one-line checklist reminder, not the decisions block itself
        assert "user chose:" not in pass2_prompt
        assert "Verify the USER STRATEGY DECISIONS were followed exactly." in pass2_prompt


HAIKU = "claude-haiku-4-5-20251001"


def _patch_common(monkeypatch, models_seen=None, notes_seen=None):
    """Stub the LLM call, license, usage, and quality guards for generate_cv tests."""
    async def fake_cached_call(rendered_prompt, max_tokens, model,
                               check_truncation=False, extra_note=""):
        if models_seen is not None:
            models_seen.append(model)
        if notes_seen is not None:
            notes_seen.append(extra_note)
        return _DUMMY_CV

    monkeypatch.setattr(main_module, "_call_with_cached_prefix", fake_cached_call)
    monkeypatch.setattr(main_module, "require_license", AsyncMock(return_value="lic"))
    monkeypatch.setattr(main_module, "increment_usage", lambda k: 1)
    monkeypatch.setattr(main_module, "_validate_cv_output", lambda cv, orig: [])
    monkeypatch.setattr(main_module, "estimate_page_fit", lambda cv, heb: {"overflow": False})


class TestFitBasedRouting:
    @pytest.mark.asyncio
    async def test_high_fit_routes_pass2_to_haiku(self, monkeypatch):
        models = []
        _patch_common(monkeypatch, models_seen=models)
        body = GenerateCVRequest(cvText="CV", jobText="Job", fitType="high_fit", model="sonnet")
        await main_module.generate_cv(body, x_license_key="lic")
        assert models == [HAIKU, HAIKU]  # pass1 always haiku; pass2 light-polished on haiku

    @pytest.mark.asyncio
    async def test_niche_fit_keeps_sonnet_pass2(self, monkeypatch):
        models = []
        _patch_common(monkeypatch, models_seen=models)
        body = GenerateCVRequest(cvText="CV", jobText="Job", fitType="niche_fit", model="sonnet")
        await main_module.generate_cv(body, x_license_key="lic")
        assert models[0] == HAIKU
        assert models[1] == "claude-sonnet-4-6"

    @pytest.mark.asyncio
    async def test_unknown_fit_keeps_full_pipeline(self, monkeypatch):
        models = []
        _patch_common(monkeypatch, models_seen=models)
        body = GenerateCVRequest(cvText="CV", jobText="Job", fitType="", model="sonnet")
        await main_module.generate_cv(body, x_license_key="lic")
        assert models[1] == "claude-sonnet-4-6"

    @pytest.mark.asyncio
    async def test_high_fit_with_strategy_choices_keeps_sonnet(self, monkeypatch):
        # Structural decisions imply structural work — never light-polish those away.
        models = []
        _patch_common(monkeypatch, models_seen=models)
        body = GenerateCVRequest(
            cvText="CV", jobText="Job", fitType="high_fit", model="sonnet",
            strategyChoices=[{"question": "q", "chosen": "a"}],
        )
        await main_module.generate_cv(body, x_license_key="lic")
        assert models[1] == "claude-sonnet-4-6"

    @pytest.mark.asyncio
    async def test_niche_fit_all_light_choices_falls_back_to_haiku(self, monkeypatch):
        # User answered every structural question with a light-impact option — they opted
        # out of deep changes, so the run downgrades to the cheap model.
        models = []
        _patch_common(monkeypatch, models_seen=models)
        body = GenerateCVRequest(
            cvText="CV", jobText="Job", fitType="niche_fit", model="sonnet",
            strategyChoices=[
                {"question": "q1", "chosen": "polish wording only", "impact": "light"},
                {"question": "q2", "chosen": "reorder bullets only", "impact": "light"},
            ],
        )
        await main_module.generate_cv(body, x_license_key="lic")
        assert models == [HAIKU, HAIKU]

    @pytest.mark.asyncio
    async def test_niche_fit_legacy_keep_tag_tolerated_as_light(self, monkeypatch):
        # The classifier no longer emits "keep", but question sets generated by the older
        # prompt may still be in flight — a stray "keep" means even less change than light.
        models = []
        _patch_common(monkeypatch, models_seen=models)
        body = GenerateCVRequest(
            cvText="CV", jobText="Job", fitType="niche_fit", model="sonnet",
            strategyChoices=[{"question": "q1", "chosen": "keep full detail", "impact": "keep"}],
        )
        await main_module.generate_cv(body, x_license_key="lic")
        assert models == [HAIKU, HAIKU]

    @pytest.mark.asyncio
    async def test_niche_fit_one_structural_choice_keeps_sonnet(self, monkeypatch):
        models = []
        _patch_common(monkeypatch, models_seen=models)
        body = GenerateCVRequest(
            cvText="CV", jobText="Job", fitType="niche_fit", model="sonnet",
            strategyChoices=[
                {"question": "q1", "chosen": "polish wording only", "impact": "light"},
                {"question": "q2", "chosen": "condense secondary domain", "impact": "structural"},
            ],
        )
        await main_module.generate_cv(body, x_license_key="lic")
        assert models[1] == "claude-sonnet-4-6"

    @pytest.mark.asyncio
    async def test_niche_fit_missing_impact_tag_keeps_sonnet(self, monkeypatch):
        # Old clients / malformed options carry no impact tag — treat as structural.
        models = []
        _patch_common(monkeypatch, models_seen=models)
        body = GenerateCVRequest(
            cvText="CV", jobText="Job", fitType="niche_fit", model="sonnet",
            strategyChoices=[{"question": "q1", "chosen": "keep full detail"}],
        )
        await main_module.generate_cv(body, x_license_key="lic")
        assert models[1] == "claude-sonnet-4-6"


class TestLightPolishPromptNote:
    @pytest.mark.asyncio
    async def test_light_note_present_in_high_fit_prompts(self, monkeypatch):
        prompts = []

        async def fake_cached_call(rendered_prompt, max_tokens, model,
                                   check_truncation=False, extra_note=""):
            prompts.append(rendered_prompt)
            return _DUMMY_CV

        monkeypatch.setattr(main_module, "_call_with_cached_prefix", fake_cached_call)
        monkeypatch.setattr(main_module, "require_license", AsyncMock(return_value="lic"))
        monkeypatch.setattr(main_module, "increment_usage", lambda k: 1)
        monkeypatch.setattr(main_module, "_validate_cv_output", lambda cv, orig: [])
        monkeypatch.setattr(main_module, "estimate_page_fit", lambda cv, heb: {"overflow": False})

        body = GenerateCVRequest(cvText="CV", jobText="Job", fitType="high_fit")
        await main_module.generate_cv(body, x_license_key="lic")
        assert "LIGHT-POLISH MODE" in prompts[0]
        assert "LIGHT-POLISH run" in prompts[1]

    @pytest.mark.asyncio
    async def test_light_note_absent_in_niche_fit_prompts(self, monkeypatch):
        prompts = []

        async def fake_cached_call(rendered_prompt, max_tokens, model,
                                   check_truncation=False, extra_note=""):
            prompts.append(rendered_prompt)
            return _DUMMY_CV

        monkeypatch.setattr(main_module, "_call_with_cached_prefix", fake_cached_call)
        monkeypatch.setattr(main_module, "require_license", AsyncMock(return_value="lic"))
        monkeypatch.setattr(main_module, "increment_usage", lambda k: 1)
        monkeypatch.setattr(main_module, "_validate_cv_output", lambda cv, orig: [])
        monkeypatch.setattr(main_module, "estimate_page_fit", lambda cv, heb: {"overflow": False})

        body = GenerateCVRequest(
            cvText="CV", jobText="Job", fitType="niche_fit",
            strategyChoices=[{"question": "q", "chosen": "condense", "impact": "structural"}],
        )
        await main_module.generate_cv(body, x_license_key="lic")
        assert "LIGHT-POLISH" not in prompts[0]
        assert "LIGHT-POLISH" not in prompts[1]


class TestSharedRetryBudget:
    @pytest.mark.asyncio
    async def test_validation_retry_consumes_budget_page_fit_skipped(self, monkeypatch):
        models = []
        _patch_common(monkeypatch, models_seen=models)
        # Validation always fails AND page always overflows — only ONE extra call allowed.
        monkeypatch.setattr(main_module, "_validate_cv_output", lambda cv, orig: ["missing [SKILLS]"])
        monkeypatch.setattr(main_module, "estimate_page_fit",
                            lambda cv, heb: {"overflow": True, "over_ratio": 0.3,
                                             "effective_words": 700, "budget_max": 520})
        body = GenerateCVRequest(cvText="CV", jobText="Job")
        await main_module.generate_cv(body, x_license_key="lic")
        assert len(models) == 3  # pass1 + pass2 + validation retry; page-fit retry skipped

    @pytest.mark.asyncio
    async def test_page_fit_retry_runs_when_validation_clean(self, monkeypatch):
        models, notes = [], []
        _patch_common(monkeypatch, models_seen=models, notes_seen=notes)
        monkeypatch.setattr(main_module, "estimate_page_fit",
                            lambda cv, heb: {"overflow": True, "over_ratio": 0.2,
                                             "effective_words": 640, "budget_max": 520})
        body = GenerateCVRequest(cvText="CV", jobText="Job")
        await main_module.generate_cv(body, x_license_key="lic")
        assert len(models) == 3  # pass1 + pass2 + page-fit retry
        assert "over the" in notes[2]  # the retry carried the overflow note

    @pytest.mark.asyncio
    async def test_clean_output_makes_exactly_two_calls(self, monkeypatch):
        models = []
        _patch_common(monkeypatch, models_seen=models)
        body = GenerateCVRequest(cvText="CV", jobText="Job", fitType="high_fit")
        await main_module.generate_cv(body, x_license_key="lic")
        assert len(models) == 2


class TestCoverLetterParallelism:
    @pytest.mark.asyncio
    async def test_cover_letter_starts_before_pass2_completes(self, monkeypatch):
        import asyncio
        events = []

        async def fake_cached_call(rendered_prompt, max_tokens, model,
                                   check_truncation=False, extra_note=""):
            events.append("cached-start")
            await asyncio.sleep(0)  # yield so the cover-letter task gets scheduled
            events.append("cached-end")
            return _DUMMY_CV

        async def fake_call_claude(prompt, max_tokens=600):
            events.append("cover")
            return "Cover letter text"

        monkeypatch.setattr(main_module, "_call_with_cached_prefix", fake_cached_call)
        monkeypatch.setattr(main_module, "call_claude", fake_call_claude)
        monkeypatch.setattr(main_module, "require_license", AsyncMock(return_value="lic"))
        monkeypatch.setattr(main_module, "increment_usage", lambda k: 1)
        monkeypatch.setattr(main_module, "_validate_cv_output", lambda cv, orig: [])
        monkeypatch.setattr(main_module, "estimate_page_fit", lambda cv, heb: {"overflow": False})

        body = GenerateCVRequest(cvText="CV", jobText="Job", generateCoverLetter=True)
        result = await main_module.generate_cv(body, x_license_key="lic")

        # The cover letter fired during pass1's first suspension — long before pass2 ended.
        assert events.index("cover") < events.index("cached-end")
        assert result["coverLetterText"] == "Cover letter text"
