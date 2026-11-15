.PHONY: test test-watch test-install

# Install test deps (also pulls the app deps the tests import).
test-install:
	pip install -r tests/requirements.txt -r orcha-cli/orcha_cli/templates/portal/requirements.txt

# Run the API state-machine suite (Orcha#22).
# Runs on a temp SQLite file; no Postgres or Docker needed (GH #377).
test:
	pytest -q

# Re-run on file changes (pip install pytest-watch).
test-watch:
	ptw -- -q
