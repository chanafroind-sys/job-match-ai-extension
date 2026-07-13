"""Cross-task regression: recruiters.py and employees.py award points from the
same daily directory cap (points_config.DAILY_RECRUITER_CAP), via the shared
points_service.award_directory_points/daily_directory_credits_today. A bug
that only counted one action-type family would silently double the
effective daily cap — this interleaves both kinds of adds to catch that.
"""

from app.core import points_config
from app.routes import employees, recruiters


async def test_alternating_recruiter_and_employee_adds_share_one_daily_cap(db, user):
    awarded = []

    def _body(i):
        return recruiters.RecruiterIn(full_name=f"R{i}", email=f"r{i}@acme.com", company="Acme Corp")

    def _emp_body(i):
        return employees.EmployeeIn(full_name=f"E{i}", company="Acme Corp", email=f"e{i}@acme.com")

    for i in range(3):
        r = await recruiters.add_recruiter(_body(i), user, db)
        awarded.append(r["points_awarded"] > 0)
        e = await employees.add_employee(_emp_body(i), user, db)
        awarded.append(e["points_awarded"] > 0)

    assert len(awarded) == 6
    assert sum(awarded) == points_config.DAILY_RECRUITER_CAP
    # The cap is hit mid-sequence — everything after position DAILY_RECRUITER_CAP earns 0.
    assert awarded[: points_config.DAILY_RECRUITER_CAP] == [True] * points_config.DAILY_RECRUITER_CAP
    assert all(a is False for a in awarded[points_config.DAILY_RECRUITER_CAP:])
