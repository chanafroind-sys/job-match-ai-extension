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
