#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

if grep -rInE "sk-or-[A-Za-z0-9]{20,}" --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.git .; then
  echo "ERROR: potential OpenRouter API key found above." >&2
  exit 1
fi

if [ -f .ox/key ] || [ -f ~/.ox/key ]; then :; fi

echo "no-secrets: OK"
