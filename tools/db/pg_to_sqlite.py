#!/usr/bin/env python3
"""Copy a Postgres Orcha database into a new SQLite file (GH #258 plan Part 6 M1).

The work lives in ``orcha_cli.db_convert`` so ``orcha migrate-runtime`` can call it without a
subprocess; this is the standalone entry point:

    python tools/db/pg_to_sqlite.py --pg postgresql://orcha:orcha@localhost:5437/orcha \\
        --out /path/to/project/.orcha/orcha.db [--verify-sample 50] [--force] [--json]

It refuses to overwrite ``--out`` (``--force`` moves the old file aside first), and on any
mismatch it deletes the half-written output and exits 1.
"""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2] / "orcha-cli"))

from orcha_cli import db_convert  # noqa: E402

if __name__ == "__main__":
    sys.exit(db_convert.main())
