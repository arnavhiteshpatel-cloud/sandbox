#!/bin/bash
# One-step setup on a Mac: checks for Apple's free command-line tools, builds DragShelf,
# runs its tests and self-test, installs it and opens it. No admin password needed.
#
#   bash DragShelf/scripts/setup-mac.sh
set -euo pipefail
cd "$(dirname "$0")/.."

if ! xcode-select -p >/dev/null 2>&1 || ! command -v swift >/dev/null 2>&1; then
  echo "Apple's Command Line Tools are needed (free, ~1 GB)."
  echo "A dialog will open — click Install, wait for it to finish, then run this script again."
  xcode-select --install || true
  exit 1
fi

SWIFT_VERSION="$(swift --version 2>&1 | sed -n 's/.*Swift version \([0-9]*\.[0-9]*\).*/\1/p' | head -1)"
MAJOR="${SWIFT_VERSION%%.*}"; MINOR="${SWIFT_VERSION#*.}"
if [[ -z "$MAJOR" || "$MAJOR" -lt 5 || ( "$MAJOR" -eq 5 && "$MINOR" -lt 9 ) ]]; then
  echo "Swift 5.9 or newer is required (found: ${SWIFT_VERSION:-unknown})."
  echo "Update the Command Line Tools in System Settings › General › Software Update, then try again."
  exit 1
fi

set +e
scripts/build-app.sh --test --dmg --install
code=$?
set -e
if [[ $code == 3 ]]; then
  echo
  echo "Installed, but the self-test reported problems (see above / build/selftest.json)."
elif [[ $code != 0 ]]; then
  echo
  echo "Build failed (exit $code). Please send the output above so it can be fixed."
  exit $code
fi

echo
echo "DragShelf is running. Drag a file to the right edge of your screen, or press ⌃⌥Space."
echo "Settings: click the tray icon in the menu bar."
