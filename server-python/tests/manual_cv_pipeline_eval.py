"""
Standalone self-audit for the CV pipeline optimization (Step 1-3). NOT a pytest test —
imports functions straight from `main` and calls the real Anthropic API directly, bypassing
FastAPI/Gumroad/license entirely. Makes real, billed API calls.

Run from server-python/:  .venv/Scripts/python.exe tests/manual_cv_pipeline_eval.py
"""
import asyncio
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import main  # noqa: E402

FIXTURES = Path(__file__).resolve().parent / "fixtures"
SAMPLE_CV = (FIXTURES / "sample_cv.txt").read_text(encoding="utf-8")
SAMPLE_JOB = (FIXTURES / "sample_job.txt").read_text(encoding="utf-8")

MODEL_PASS1 = "claude-haiku-4-5-20251001"
MODEL_PASS2 = main._resolve_model("sonnet")


async def _timed(coro):
    t0 = time.perf_counter()
    result = await coro
    return result, time.perf_counter() - t0


async def run():
    print("=" * 90)
    print("SELF-AUDIT: CV pipeline optimization — real Anthropic API calls, production code path")
    print("=" * 90)

    language_rule = main._CV_LANG_RULE_EN
    language_check = main._CV_LANG_CHECK_EN
    pass1_prompt = main.CV_PASS1_PROMPT.format(
        language="English", language_rule=language_rule,
        cv_text=SAMPLE_CV, answers_text="No additional information provided.", job_text=SAMPLE_JOB,
    )

    print("\n--- 1. LATENCY & CACHE (real API, via the actual _call_with_cached_prefix) ---")
    cv_draft, t_pass1 = await _timed(
        main._call_with_cached_prefix(pass1_prompt, max_tokens=4000, model=MODEL_PASS1, check_truncation=True))
    print(f"Pass1: {t_pass1:.2f}s")

    pass2_prompt = main.CV_PASS2_PROMPT.format(
        language_check=language_check, cv_draft=cv_draft, job_text=SAMPLE_JOB, original_cv=SAMPLE_CV,
    )
    cv_final, t_pass2 = await _timed(
        main._call_with_cached_prefix(pass2_prompt, max_tokens=3800, model=MODEL_PASS2, check_truncation=True))
    print(f"Pass2: {t_pass2:.2f}s")

    # Simulate the validation-retry / page-fit-retry path exactly as generate_cv does: same
    # base pass2_prompt (unchanged, cacheable), only a short extra_note appended as the user
    # turn. This is the actual slow path today — prove it now hits cache.
    retry_note = "IMPORTANT: minor tightening pass — keep everything else exactly as instructed above."
    cv_final_retry, t_pass2_retry = await _timed(
        main._call_with_cached_prefix(pass2_prompt, max_tokens=3800, model=MODEL_PASS2,
                                        check_truncation=True, extra_note=retry_note))
    print(f"Pass2 retry (same cached base prompt + short note): {t_pass2_retry:.2f}s")
    print(f"(cache_read/cache_write numbers are logged by call_claude_cached above via [JMA:claude] lines)")

    # ── 2. LAYOUT INTEGRITY ────────────────────────────────────────────────────────────────
    print("\n--- 2. LAYOUT INTEGRITY (estimate_page_fit) ---")
    fit = main.estimate_page_fit(cv_final, is_hebrew=False)
    print(f"page-fit: {fit}")
    print(f"_validate_cv_output issues: {main._validate_cv_output(cv_final, SAMPLE_CV) or 'none'}")

    # ── 3. DIFF GRANULARITY ─────────────────────────────────────────────────────────────────
    print("\n--- 3. DIFF GRANULARITY (split_experience_units, local, no LLM) ---")
    t0 = time.perf_counter()
    units = main.split_experience_units(cv_final, SAMPLE_CV)
    dt_diff = time.perf_counter() - t0
    exp_units = [u for u in units if u["section_name"] == "[EXPERIENCE]"]
    print(f"split_experience_units took {dt_diff*1000:.1f}ms (local, no network call)")
    print(f"Total diff units: {len(units)}  |  [EXPERIENCE] units: {len(exp_units)}")
    print(f"PASS/FAIL — more than 1 Experience unit (old LLM diff always returned exactly 1): "
          f"{'PASS' if len(exp_units) > 1 else 'FAIL'}")
    byte_faithful = all((u["original_text"] in SAMPLE_CV) for u in exp_units if u["original_text"])
    print(f"PASS/FAIL — every non-empty original_text is byte-exact substring of the real "
          f"original CV: {'PASS' if byte_faithful else 'FAIL'}")

    print("\nExperience units:")
    for u in exp_units:
        orig_preview = (u["original_text"][:55] + "…") if len(u["original_text"]) > 55 else u["original_text"]
        upd_preview = (u["updated_text"][:55] + "…") if len(u["updated_text"]) > 55 else u["updated_text"]
        print(f"  #{u['id']:<3} {u['unit_type']:<11} order={u['order']:<2} changed={str(u['changed']):<5} "
              f"orig={orig_preview!r}")
        print(f"        upd={upd_preview!r}" + (f"  ({u['explanation_hebrew']})" if u["explanation_hebrew"] else ""))

    print("\n" + "=" * 90)
    print("Full cv_final:\n")
    print(cv_final)
    print("=" * 90)


if __name__ == "__main__":
    asyncio.run(run())
