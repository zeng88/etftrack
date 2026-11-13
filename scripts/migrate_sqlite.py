#!/usr/bin/env python3
"""Apply the project's versioned SQL migrations to the local SQLite database."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from storage import DB_PATH, initialize_db
from storage import connect

initialize_db()
conn=connect()
try:
    rows=conn.execute("SELECT name,applied_at FROM schema_migrations ORDER BY name").fetchall()
    for row in rows:
        print(f"{row['name']} · {row['applied_at']}")
    print(f"SQLite migration 已完成：{DB_PATH}")
finally:
    conn.close()
