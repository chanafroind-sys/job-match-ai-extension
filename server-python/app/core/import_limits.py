"""Shared caps and header-cell helper for the .xlsx admin bulk importers
(recruiters and employees) — kept in one place so a future third importer
doesn't have to guess these numbers again.
"""

MAX_IMPORT_FILE_BYTES = 2 * 1024 * 1024
MAX_IMPORT_ROWS = 2000


def import_row_cell(row: tuple, header_map: dict[str, int], key: str) -> str | None:
    idx = header_map.get(key)
    if idx is None or idx >= len(row):
        return None
    value = row[idx]
    return str(value).strip() if value is not None else None
