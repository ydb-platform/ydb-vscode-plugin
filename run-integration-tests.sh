#!/usr/bin/env bash
# Convenience wrapper — delegates to the canonical test runner.
exec bash "$(dirname "$0")/integration-tests/run-tests.sh" "$@"
