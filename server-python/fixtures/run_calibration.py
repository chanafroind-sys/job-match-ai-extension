"""Manual calibration for STREAM_FIT_STRATEGY_PROMPT (see PART 4, item 11).

Runs the real Anthropic API (haiku — the cheapest model, same one the
/api/stream-deep-analysis endpoint hardcodes) against four synthetic CV/job
pairs and prints the streamed prose + parsed strategy for human review.

Not a pytest test — run directly:
    .venv/Scripts/python.exe fixtures/run_calibration.py
"""
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from main import anthropic_client, _cv_system_blocks, _split_strategy_stream, STREAM_FIT_STRATEGY_PROMPT

FIXTURES_DIR = Path(__file__).resolve().parent
CV_TEXT = (FIXTURES_DIR / "backend_cv.txt").read_text(encoding="utf-8")

SCENARIOS = [
    ("(a) matching backend job", "job_matching_backend.txt", "high_fit"),
    ("(b) job targeting one narrow CV section (D3.js dashboard)", "job_narrow_data_viz.txt", "niche_fit"),
    ("(c) high keyword overlap but narrow focus (Python ETL)", "job_keyword_overlap_narrow.txt", "niche_fit"),
    ("(d) same discipline, different vocabulary (Platform Engineer)", "job_different_vocab.txt", "high_fit"),
]


async def run_one(label: str, job_file: str, expected: str):
    job_text = (FIXTURES_DIR / job_file).read_text(encoding="utf-8")
    sys_blocks = _cv_system_blocks(CV_TEXT)
    prompt = STREAM_FIT_STRATEGY_PROMPT.format(job_text=job_text, answers_text="לא נענו שאלות",
                                               answer_bank="אין מאגר תשובות קודמות")

    full_text = ""
    async with anthropic_client.messages.stream(
        model="claude-haiku-4-5-20251001",
        max_tokens=900,
        system=sys_blocks,
        messages=[{"role": "user", "content": prompt}],
    ) as stream:
        async for token in stream.text_stream:
            full_text += token

    prose, strategy = _split_strategy_stream(full_text)
    got = strategy.get("fit_type")
    verdict = "PASS" if got == expected else "FAIL"

    print("=" * 88)
    print(f"{label}  [expected={expected} got={got} -> {verdict}]")
    print("-" * 88)
    print("PROSE:\n" + prose.strip())
    print("-" * 88)
    print("STRATEGY:", strategy)
    print()
    return verdict == "PASS"


async def main():
    results = []
    for label, job_file, expected in SCENARIOS:
        results.append(await run_one(label, job_file, expected))
    print("=" * 88)
    print(f"{sum(results)}/{len(results)} scenarios classified as expected")


if __name__ == "__main__":
    asyncio.run(main())
