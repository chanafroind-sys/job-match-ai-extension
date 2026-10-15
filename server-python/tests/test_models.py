"""Which model each feature runs on, and that none thinks before it answers
(every prompt and max_tokens here assume a straight answer). Live-checked on
2026-10-15 with the pinned SDK: both models answered a 12-token reply in text,
with no thinking block."""
import main


def test_the_current_haiku_and_sonnet_and_no_fable():
    assert main.MODEL_FAST == "claude-haiku-5-5" and main.MODEL_SMART == "claude-sonnet-5-5"
    assert main._resolve_model("haiku") == main.MODEL_FAST
    assert main._resolve_model("sonnet") == main.MODEL_SMART
    assert main._resolve_model("fable") == main.MODEL_SMART  # retired: its quota lived only in the extension


def test_thinking_is_off_for_both():
    assert main._no_thinking(main.MODEL_FAST) == {"extra_body": {"thinking": {"type": "disabled"}}}
    # Sonnet 5.5 refuses "disabled"; "between_tools" with no tools means no thinking.
    assert main._no_thinking(main.MODEL_SMART) == {"extra_body": {"thinking": {"type": "between_tools"}}}
    assert main._no_thinking("claude-haiku-4-5-20251001") == {}  # older models don't think unasked
