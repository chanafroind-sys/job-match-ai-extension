"""The Daily Matches migration chains onto head and round-trips, run the way
Render runs it (alembic CLI, DATABASE_URL from the environment)."""
import os
import sqlite3
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DM_TABLES = {"dm_job_embeddings", "dm_cv_embeddings", "dm_runs", "dm_run_results", "dm_trials"}


def _alembic(db_file: Path, *args: str) -> None:
    env = {**os.environ, "DATABASE_URL": f"sqlite+aiosqlite:///{db_file.as_posix()}"}
    subprocess.run([sys.executable, "-m", "alembic", *args], cwd=ROOT, env=env, check=True,
                   capture_output=True, text=True, timeout=120)


def _tables(db_file: Path) -> set[str]:
    with sqlite3.connect(db_file) as con:
        return {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}


def test_upgrade_downgrade_upgrade(tmp_path):
    db_file = tmp_path / "migrate.db"
    _alembic(db_file, "upgrade", "head")
    tables = _tables(db_file)
    assert DM_TABLES <= tables and "daily_job_pool" in tables
    with sqlite3.connect(db_file) as con:
        cols = {r[1]: r[2] for r in con.execute("PRAGMA table_info(dm_job_embeddings)")}
        assert cols["embedding"] == "JSON"  # SQLite gets the JSON fallback, never vector(...)
        assert con.execute("SELECT version_num FROM alembic_version").fetchone()[0] == "9c4e7a1d2b36"

    _alembic(db_file, "downgrade", "-1")
    tables = _tables(db_file)
    assert not (DM_TABLES & tables) and "daily_job_pool" in tables

    _alembic(db_file, "upgrade", "head")
    assert DM_TABLES <= _tables(db_file)
