"""send_log status opened only

Revision ID: c9741b45e070
Revises: 7012942d44f5
Create Date: 2026-07-12 15:14:17.688095

send_log.status is a plain VARCHAR (native_enum=False, no DB-level CHECK
constraint) so only the partial unique index predicate needs to move from
the old 'sent'/'failed' lifecycle to the new single 'opened' status —
python-side enum values are enforced by the app, not the DB.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'c9741b45e070'
down_revision: Union[str, None] = '7012942d44f5'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.drop_index(
        'uq_send_log_user_recruiter_job_sent', table_name='send_log',
        sqlite_where=sa.text("status = 'sent'"), postgresql_where=sa.text("status = 'sent'"),
    )
    op.create_index(
        'uq_send_log_user_recruiter_job_sent', 'send_log',
        ['user_id', 'recruiter_id', 'job_url_hash'], unique=True,
        sqlite_where=sa.text("status = 'opened'"), postgresql_where=sa.text("status = 'opened'"),
    )


def downgrade() -> None:
    op.drop_index(
        'uq_send_log_user_recruiter_job_sent', table_name='send_log',
        sqlite_where=sa.text("status = 'opened'"), postgresql_where=sa.text("status = 'opened'"),
    )
    op.create_index(
        'uq_send_log_user_recruiter_job_sent', 'send_log',
        ['user_id', 'recruiter_id', 'job_url_hash'], unique=True,
        sqlite_where=sa.text("status = 'sent'"), postgresql_where=sa.text("status = 'sent'"),
    )
