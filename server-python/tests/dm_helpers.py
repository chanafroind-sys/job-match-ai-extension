"""Shared fakes for the Daily Matches tests: a deterministic embedder, a fake
Anthropic client, and daily_job_pool seeding. No network anywhere."""
import asyncio
import hashlib
import math
import re
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

from app.models.job_pool import DailyJobPool
from daily_matches import config

_WORD = re.compile(r"[a-z0-9+#]+")


def fake_vector(text: str) -> list[float]:
    """Bag-of-words hashed into EMBED_DIM buckets, unit length: texts sharing
    words point the same way, which is all a ranking test needs."""
    vec = [0.0] * config.EMBED_DIM
    for word in _WORD.findall(text.lower()):
        if len(word) < 3:
            continue
        bucket = int(hashlib.md5(word.encode()).hexdigest(), 16) % config.EMBED_DIM
        vec[bucket] += 1.0
    norm = math.sqrt(sum(v * v for v in vec)) or 1.0
    return [v / norm for v in vec]


class FakeEmbedder:
    def __init__(self):
        self.calls: list[tuple[int, str]] = []

    async def __call__(self, texts: list[str], input_type: str) -> list[list[float]]:
        self.calls.append((len(texts), input_type))
        return [fake_vector(t) for t in texts]


def _keywords(text: str) -> set[str]:
    return {w for w in _WORD.findall(text.lower()) if len(w) >= 3}


class FakeMessages:
    """Scores a job by keyword overlap with the system block, answering through
    the forced tool exactly like the API would."""

    def __init__(self, owner: "FakeClaude"):
        self.owner = owner

    async def create(self, **kwargs):
        o = self.owner
        o.calls.append(kwargs)
        o.started_at.append(asyncio.get_running_loop().time())
        if o.delay:
            await asyncio.sleep(o.delay)
        job_text = kwargs["messages"][0]["content"]
        if o.fail_when and o.fail_when(job_text):
            raise o.error_factory()
        system_text = kwargs["system"][0]["text"]
        enum = kwargs["tools"][0]["input_schema"]["properties"]["best_cv_id"]["enum"]
        overlap = len(_keywords(job_text) & _keywords(system_text))
        score = max(5, min(97, 30 + overlap * 6))
        tool_input = {
            "match_score": score,
            "best_cv_id": enum[0],
            "cv_scores": [{"cv_id": alias, "score": max(0, score - 10 * i)} for i, alias in enumerate(enum)],
            "requirements": [
                {"text": "Python", "status": "met", "importance": "must"},
                {"text": "Go", "status": "missing", "importance": "nice"},
                {"text": "Kubernetes at scale", "status": "partial", "importance": "must"},
            ],
            "fit_summary_he": "התאמה טובה לליבת התפקיד.",
            "cv_choice_reason_he": "הגרסה מדגישה את הניסיון הרלוונטי.",
            "top_gap_he": "חסר ניסיון ב-Go.",
        }
        return SimpleNamespace(
            content=[SimpleNamespace(type="tool_use", name=kwargs["tool_choice"]["name"], input=tool_input)],
            stop_reason=o.stop_reason,
            usage=SimpleNamespace(input_tokens=1000, output_tokens=300,
                                  cache_read_input_tokens=0, cache_creation_input_tokens=0),
        )


class FakeClaude:
    def __init__(self, delay: float = 0.0, fail_when=None, error_factory=None, stop_reason="tool_use"):
        self.calls: list[dict] = []
        self.started_at: list[float] = []
        self.delay = delay
        self.fail_when = fail_when
        self.error_factory = error_factory or (lambda: RuntimeError("boom"))
        self.stop_reason = stop_reason
        self.messages = FakeMessages(self)


def seed_jobs(session, jobs: list[dict]) -> None:
    now = datetime.now(timezone.utc)
    for i, j in enumerate(jobs):
        session.add(DailyJobPool(
            id=j.get("id", f"job{i:03d}"),
            external_job_id=j.get("external_job_id"),
            title=j["title"],
            company=j.get("company", "Acme"),
            category=j.get("category", "Backend"),
            seniority=j.get("seniority", "Senior"),
            url=j.get("url", f"https://jobs.lever.co/acme/{i:04d}"),
            description=j.get("description", ""),
            published_at=j.get("published_at", now - timedelta(days=1)),
            scraped_at=j.get("scraped_at", now),
        ))


BACKEND_CV = (
    "Noa Levi · noa.levi@example.com · +972 50-123-4567\n"
    "Senior backend engineer with 6 years of Python and Java microservices on AWS.\n"
    "Built Kafka event pipelines, PostgreSQL data models and REST APIs.\n"
    "Experience\n"
    "• Lumen Security (2020 - 2026): Python, Kafka, AWS, Kubernetes deployments\n"
    "• Datavine (2018 - 2020): Java, Spring, microservices, PostgreSQL\n"
    "Education: B.Sc. Computer Science\n"
) * 2

DATA_CV = (
    "Data engineer building Spark and Airflow pipelines with advanced SQL.\n"
    "Databricks, dbt basics, Python ETL, data warehouse modeling, Snowflake exposure.\n"
    "• Streamline Analytics (2019 - 2026): Spark, Airflow, SQL, Python\n"
) * 3


def standard_pool() -> list[dict]:
    return [
        {"id": "be1", "title": "Senior Backend Engineer", "description":
            "Requirements:\n• Python and Kafka microservices\n• AWS in production\n• Kubernetes\nBenefits:\n• Free lunch"},
        {"id": "be2", "title": "Backend Developer", "description":
            "Requirements:\n• Java Spring microservices\n• PostgreSQL\n• REST APIs"},
        {"id": "de1", "title": "Data Engineer", "category": "Data", "seniority": "Mid", "description":
            "Requirements:\n• Spark and Airflow\n• Advanced SQL\n• Databricks, dbt"},
        {"id": "fe1", "title": "Frontend Engineer", "category": "Frontend", "description":
            "Requirements:\n• React, CSS, HTML\n• Figma collaboration"},
        {"id": "hw1", "title": "ASIC Verification Engineer", "category": "Hardware", "description":
            "Requirements:\n• SystemVerilog UVM\n• RTL simulation"},
        {"id": "old1", "title": "Python Backend Engineer", "description": "Python Kafka AWS",
         "scraped_at": datetime.now(timezone.utc) - timedelta(days=5)},  # stale: not active
    ]
