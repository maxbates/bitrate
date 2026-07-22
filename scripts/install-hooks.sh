#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
mkdir -p .git/hooks
cp scripts/pre-push .git/hooks/pre-push
chmod +x .git/hooks/pre-push
echo "installed .git/hooks/pre-push"
