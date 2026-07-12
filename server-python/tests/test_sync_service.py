from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock

import pytest
from sqlalchemy import select

from app.core.models import Employee, SyncMeta
from app.services import sync_service

CSV_TEXT = (
    "Name,Company,Email,Fields of Expertise,Minimum Score Threshold,Opt-in Checkbox\n"
    "Dana Cohen,Acme Corp,dana@acme.com,Backend,75,Yes\n"
)

CSV_TEXT_UPDATED = (
    "Name,Company,Email,Fields of Expertise,Minimum Score Threshold,Opt-in Checkbox\n"
    "Dana Cohen,Acme Corp,dana@acme.com,Backend,80,Yes\n"
)


def _mock_response(text):
    resp = MagicMock()
    resp.text = text
    resp.raise_for_status = MagicMock()
    return resp


class _FakeClient:
    calls = 0

    def __init__(self, text=CSV_TEXT, raise_error=False):
        self._text = text
        self._raise_error = raise_error

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    async def get(self, url):
        _FakeClient.calls += 1
        if self._raise_error:
            raise RuntimeError("network down")
        return _mock_response(self._text)


def _install_fake_client(monkeypatch, text=CSV_TEXT, raise_error=False):
    _FakeClient.calls = 0
    monkeypatch.setattr(
        sync_service.httpx, "AsyncClient",
        lambda *a, **kw: _FakeClient(text=text, raise_error=raise_error),
    )


@pytest.fixture(autouse=True)
def _sheet_url(monkeypatch):
    monkeypatch.setattr(sync_service, "EMPLOYEES_SHEET_CSV_URL", "https://example.com/sheet.csv")


async def test_sync_is_noop_without_url(db, monkeypatch):
    monkeypatch.setattr(sync_service, "EMPLOYEES_SHEET_CSV_URL", "")
    await sync_service.maybe_sync(db)
    result = await db.execute(select(Employee))
    assert result.scalars().all() == []


async def test_sync_upserts_new_employee_from_csv(db, monkeypatch):
    _install_fake_client(monkeypatch)
    await sync_service.maybe_sync(db)

    result = await db.execute(select(Employee))
    employees = result.scalars().all()
    assert len(employees) == 1
    emp = employees[0]
    assert emp.full_name == "Dana Cohen"
    assert emp.company == "Acme Corp"
    assert emp.company_normalized == "acme corp"
    assert emp.email == "dana@acme.com"
    assert emp.min_match_threshold == 75
    assert emp.is_opted_in is True
    assert emp.domains == ["Backend"]
    assert emp.source_row_id == "dana@acme.com"


async def test_sync_is_idempotent_by_source_row_id(db, monkeypatch):
    _install_fake_client(monkeypatch, text=CSV_TEXT)
    await sync_service.maybe_sync(db)

    # Force the next call past the 1h freshness window and re-sync with an
    # updated row for the same employee (same email = same source_row_id).
    meta_result = await db.execute(select(SyncMeta).where(SyncMeta.key == sync_service.SYNC_KEY))
    meta = meta_result.scalar_one()
    meta.last_synced_at = datetime.now(timezone.utc) - timedelta(hours=2)
    await db.commit()

    _install_fake_client(monkeypatch, text=CSV_TEXT_UPDATED)
    await sync_service.maybe_sync(db)

    result = await db.execute(select(Employee))
    employees = result.scalars().all()
    assert len(employees) == 1
    assert employees[0].min_match_threshold == 80


async def test_sync_skips_when_recently_synced(db, monkeypatch):
    _install_fake_client(monkeypatch)
    await sync_service.maybe_sync(db)
    assert _FakeClient.calls == 1

    await sync_service.maybe_sync(db)
    assert _FakeClient.calls == 1  # no second fetch — still within the hour


async def test_sync_failure_does_not_advance_timestamp(db, monkeypatch):
    _install_fake_client(monkeypatch, raise_error=True)
    await sync_service.maybe_sync(db)

    result = await db.execute(select(SyncMeta).where(SyncMeta.key == sync_service.SYNC_KEY))
    meta = result.scalar_one()
    assert meta.last_synced_at is None

    emp_result = await db.execute(select(Employee))
    assert emp_result.scalars().all() == []
