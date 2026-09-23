import hashlib
import asyncio
import os
from datetime import datetime, timezone
import httpx
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.job_pool import DailyJobPool

RAPIDAPI_KEY = os.getenv("RAPIDAPI_KEY", "")
RAPIDAPI_HOST = "jsearch.p.rapidapi.com"

# שאילתות חיפוש לכיסוי רחב
TARGET_QUERIES = [
    "Backend Developer",
    "Full Stack Engineer",
    "DevOps Engineer",
    "Frontend Developer",
    "AI Machine Learning Engineer",
    "Data Engineer"
]

def hash_url(url: str) -> str:
    return hashlib.md5(url.strip().encode("utf-8")).hexdigest()

def classify_job_title(title: str, query_hint: str) -> tuple[str, str]:
    """
    סיווג דטרמיניסטי מהיר של קטגוריה ורמת בכירות לפי כותרת המשרה
    """
    title_lower = title.lower()

    # חילוץ קטגוריה
    if "backend" in title_lower or "back end" in title_lower or "node" in title_lower or "python" in title_lower:
        cat = "Backend"
    elif "fullstack" in title_lower or "full stack" in title_lower:
        cat = "Full Stack"
    elif "frontend" in title_lower or "front end" in title_lower or "react" in title_lower or "angular" in title_lower:
        cat = "Frontend"
    elif "devops" in title_lower or "sre" in title_lower or "infrastructure" in title_lower or "cloud" in title_lower:
        cat = "DevOps"
    elif any(term in title_lower for term in ["ai", "machine learning", "ml", "llm", "data scientist"]):
        cat = "AI / ML"
    else:
        # ברירת מחדל לפי שאילתת המקור ששלפה את המשרה
        cat = query_hint.split()[0]

    # חילוץ רמת בכירות
    if any(level in title_lower for level in ["senior", "lead", "principal", "staff", "architect"]):
        sen = "Senior"
    elif any(level in title_lower for level in ["junior", "student", "intern", "entry"]):
        sen = "Junior"
    elif "mid" in title_lower:
        sen = "Mid"
    else:
        sen = "Unknown"

    return cat, sen

async def fetch_jobs_from_query(client: httpx.AsyncClient, query: str) -> list[dict]:
    url = "https://jsearch.p.rapidapi.com/search"
    params = {
        "query": query,
        "date_posted": "today",  # סינון מובנה ב-API למשרות מה-24 שעות האחרונות
        "num_pages": "1"
    }
    headers = {
        "X-RapidAPI-Key": RAPIDAPI_KEY,
        "X-RapidAPI-Host": RAPIDAPI_HOST
    }
    
    try:
        response = await client.get(url, headers=headers, params=params, timeout=20.0)
        response.raise_for_status()
        data = response.json()
        raw_items = data.get("data", [])
        
        parsed_records = []
        for item in raw_items:
            apply_url = item.get("job_apply_link") or item.get("job_google_link")
            if not apply_url:
                continue

            title = item.get("job_title", "Untitled")
            category, seniority = classify_job_title(title, query)
            
            # פרסור תאריך המשרה
            posted_at_raw = item.get("job_posted_at_datetime_utc")
            if posted_at_raw:
                try:
                    posted_at = datetime.fromisoformat(posted_at_raw.replace("Z", "+00:00"))
                except ValueError:
                    posted_at = datetime.now(timezone.utc)
            else:
                posted_at = datetime.now(timezone.utc)

            parsed_records.append({
                "id": hash_url(apply_url),
                "external_job_id": item.get("job_id"),
                "title": title,
                "company": item.get("employer_name", "Unknown"),
                "category": category,
                "seniority": seniority,
                "url": apply_url,
                "description": item.get("job_description", ""),
                "published_at": posted_at,
                "scraped_at": datetime.now(timezone.utc)
            })
        return parsed_records
    except Exception as e:
        print(f"[Scraper] Failed to fetch query '{query}': {e}")
        return []

async def run_daily_aggregation(session: AsyncSession) -> int:
    """
    מריץ את כל השאילתות במקביל ומבצע Upsert ישירות ל-PostgreSQL
    """
    async with httpx.AsyncClient() as client:
        tasks = [fetch_jobs_from_query(client, q) for q in TARGET_QUERIES]
        batch_results = await asyncio.gather(*tasks)

    # איחוד כל המשרות שנשלפו
    all_jobs = [job for sublist in batch_results for job in sublist]
    if not all_jobs:
        return 0

    # ביצוע INSERT עם ON CONFLICT DO NOTHING על בסיס ה-Primary Key (id)
    stmt = insert(DailyJobPool).values(all_jobs)
    stmt = stmt.on_conflict_do_nothing(index_elements=['id'])
    
    result = await session.execute(stmt)
    await session.commit()
    return result.rowcount