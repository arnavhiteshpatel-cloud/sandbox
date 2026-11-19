#!/usr/bin/env bash
# Runs every check that needs a real Mac and writes a report to dist/verification.txt.
#   1. unit tests (DSP kernel, EQ, ducking, profiles, persistence, tone analysis)
#   2. release build + app bundle
#   3. end-to-end independence test through the real audio system (plays two test tones ~8 s)
set -uo pipefail
cd "$(dirname "$0")/.."
mkdir -p dist
REPORT=dist/verification.txt
{
  echo "AirMix verification — $(date)"
  sw_vers
  uname -m
  echo
  echo "== swift test =="
  swift test 2>&1 | tail -n 25
  echo
  echo "== build app =="
  scripts/build-app.sh 2>&1 | tail -n 5
  echo
  echo "== end-to-end independence test (real audio) =="
  echo "macOS may ask to allow System Audio Recording for AirMix (or Terminal): click Allow, then re-run if needed."
  ./dist/AirMix.app/Contents/MacOS/AirMix --selftest
  echo "exit code: $?"
} 2>&1 | tee "$REPORT"
echo
echo "Report saved to $(pwd)/$REPORT"
