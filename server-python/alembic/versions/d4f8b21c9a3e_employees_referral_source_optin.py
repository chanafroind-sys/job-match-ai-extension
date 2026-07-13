"""employees: source/opt-in tracking, cut over from is_opted_in

Revision ID: d4f8b21c9a3e
Revises: a1b2c3d4e5f6
Create Date: 2026-07-13 10:00:00.000000

Adds added_by_user_id/source/opt_in_status/opt_in_token to `employees`, makes
source_row_id nullable (community/self-registered rows have no sheet row to
key off of), and replaces the single is_opted_in boolean with a three-state
opt_in_status enum (pending/accepted/declined). All pre-existing rows are
sheet rows and are backfilled as already-accepted, matching their prior
is_opted_in=true meaning.

Precondition: run
    SELECT LOWER(TRIM(email)), COUNT(*) FROM employees GROUP BY 1 HAVING COUNT(*) > 1
against the target database before deploying — the new unique index on
normalized email will fail to create if any duplicates already exist, and
those must be resolved manually first.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'd4f8b21c9a3e'
down_revision: Union[str, None] = 'a1b2c3d4e5f6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Normalize before uniquifying — case/whitespace variants of the same
    # address must collapse to one row before the unique index can be built.
    op.execute("UPDATE employees SET email = LOWER(TRIM(email))")

    with op.batch_alter_table('employees', schema=None) as batch_op:
        batch_op.add_column(sa.Column('added_by_user_id', sa.Integer(), nullable=True))
        batch_op.add_column(sa.Column(
            'source', sa.String(length=16), server_default='sheet', nullable=False,
        ))
        batch_op.add_column(sa.Column(
            'opt_in_status', sa.String(length=16), server_default='pending', nullable=False,
        ))
        batch_op.add_column(sa.Column('opt_in_token', sa.String(length=64), nullable=True))
        batch_op.alter_column('source_row_id', existing_type=sa.String(length=64), nullable=True)
        batch_op.drop_column('is_opted_in')
        batch_op.create_foreign_key(
            'fk_employees_added_by_user_id_users', 'users', ['added_by_user_id'], ['id'],
        )

    # Pre-existing rows are all sheet rows — their prior is_opted_in=true
    # meaning maps directly onto opt_in_status='accepted'.
    op.execute("UPDATE employees SET opt_in_status = 'accepted'")

    op.create_index('ix_employees_opt_in_token', 'employees', ['opt_in_token'], unique=True)
    op.create_index('ix_employees_email_unique', 'employees', ['email'], unique=True)


def downgrade() -> None:
    op.drop_index('ix_employees_email_unique', table_name='employees')
    op.drop_index('ix_employees_opt_in_token', table_name='employees')

    with op.batch_alter_table('employees', schema=None) as batch_op:
        batch_op.drop_constraint('fk_employees_added_by_user_id_users', type_='foreignkey')
        batch_op.alter_column('source_row_id', existing_type=sa.String(length=64), nullable=False)
        batch_op.add_column(sa.Column(
            'is_opted_in', sa.Boolean(), server_default=sa.text('false'), nullable=False,
        ))
        batch_op.drop_column('opt_in_token')
        batch_op.drop_column('opt_in_status')
        batch_op.drop_column('source')
        batch_op.drop_column('added_by_user_id')
