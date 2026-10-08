"""A fake OpenRouter for the comparison path: answers like OpenRouter's
OpenAI-style chat completions, deriving the classification from the job and
CV text the same way FakeClaude does."""
import json

import httpx

from tests.dm_helpers import fake_requirements


class FakeOpenRouter:
    def __init__(self, fail_status: int | None = None, fail_times: int = 0, no_tool_for: str | None = None,
                 cost: float = 0.0004, score_shift: int = 0):
        self.requests: list[dict] = []
        self.headers: list[dict] = []
        self.fail_status = fail_status
        self.fail_times = fail_times  # fail this many calls first (None status = always succeed)
        self.no_tool_for = no_tool_for
        self.cost = cost
        self.score_shift = score_shift

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self._handle)

    def _handle(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        self.requests.append(body)
        self.headers.append(dict(request.headers))
        if self.fail_status and (self.fail_times is None or len(self.requests) <= self.fail_times):
            return httpx.Response(self.fail_status, json={"error": {"message": "nope"}})
        system_text = body["messages"][0]["content"]
        job_text = body["messages"][1]["content"]
        usage = {"prompt_tokens": 5200, "completion_tokens": 420, "prompt_tokens_details": {"cached_tokens": 4100},
                 "cost": self.cost}
        if self.no_tool_for and self.no_tool_for in job_text:
            return httpx.Response(200, json={"provider": "DeepInfra", "usage": usage,
                                             "choices": [{"message": {"role": "assistant", "content": "I think..."}}]})
        cv_part = system_text.split("CANDIDATE CV VERSIONS", 1)[-1]
        enum = body["tools"][0]["function"]["parameters"]["properties"]["best_cv_id"]["enum"]
        args = {
            "requirements": fake_requirements(job_text, cv_part),
            "years_required": 0, "years_relevant": 0, "caps": [], "offsets": [],
            "best_cv_id": enum[0],
            "cv_scores": [{"cv_id": alias, "score": max(0, 85 - 10 * i)} for i, alias in enumerate(enum)],
            "fit_summary_he": "מתאים ברובו.", "cv_choice_reason_he": "הגרסה הקרובה ביותר.", "top_gap_he": "חסר Go.",
        }
        return httpx.Response(200, json={
            "provider": "DeepInfra", "usage": usage,
            "choices": [{"message": {"role": "assistant", "tool_calls": [
                {"id": "c1", "type": "function", "function": {"name": "submit_match", "arguments": json.dumps(args)}}]}}],
        })
