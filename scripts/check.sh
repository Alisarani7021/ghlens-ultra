#!/usr/bin/env bash
# Typecheck + tests with dependencies guaranteed to exist.
#
# Why this exists: `npx tsc` without node_modules installs the *decoy* npm
# package named "tsc", which prints a warning and exits 0 — a silent green that
# hid two real type errors (and a broken admin button) until CI caught them.
set -euo pipefail
cd "$(dirname "$0")/.."
# The D1 schema is compiled into the worker for the one-click deploy;
# regenerate it first so it can never drift from schema/d1.sql.
node scripts/gen-schema.mjs || exit 1

[ -x node_modules/.bin/tsc ] || { echo "▸ installing dependencies"; npm ci --no-audit --no-fund >/dev/null; }
echo "▸ typecheck ($(node_modules/.bin/tsc --version))"
node_modules/.bin/tsc --noEmit
echo "▸ tests"
node scripts/sqlcheck.mjs | tail -1
node scripts/check-dup-keys.mjs | tail -1
node scripts/audit-callbacks.mjs | tail -1
node scripts/selftest.mjs | tail -1
node scripts/test-rich.mjs | tail -1
