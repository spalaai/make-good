#!/usr/bin/env bash
# Pre-publish check: fails if tracked files contain local paths, real-looking keys or non-example emails.
# Usage: bash scripts/prepublish-check.sh   (run from the repo root, after git add)
set -u
fail=0
files=$(git ls-files | grep -v -E '^(package-lock\.json|web/package-lock\.json|scripts/prepublish-check\.sh)$')
check() { # $1 label, $2 regex
  hits=$(printf '%s\n' $files | xargs grep -I -n -E "$2" 2>/dev/null || true)
  if [ -n "$hits" ]; then echo "FAIL: $1"; echo "$hits" | cut -c1-200; fail=1; else echo "ok:   $1"; fi
}
check "local paths" '/Users/|/home/[a-z]|/workspace/'
check "Google API key" 'AIza[0-9A-Za-z_-]{30,}'
check "OpenAI/Anthropic key" '(^|[^A-Za-z0-9-])sk-(ant-)?[A-Za-z0-9_]{20,}'
check "PayPal client id/secret shape" '(^|[^A-Za-z0-9])(A[A-Za-z0-9_-]{78}|E[A-Za-z0-9_-]{78})([^A-Za-z0-9_-]|$)'
check "bearer token" 'Bearer [A-Za-z0-9._-]{30,}'
check "non-example email" '[A-Za-z0-9._%+-]+@(gmail|yahoo|outlook|hotmail|icloud|proton)[A-Za-z.]*|sb-[a-z0-9]+@'
if git ls-files | grep -E '(^|/)\.env($|\.)' | grep -v '\.env\.example$'; then echo "FAIL: a .env file is tracked"; fail=1; else echo "ok:   no .env tracked"; fi
grep -q 'MIT License' LICENSE && echo "ok:   MIT LICENSE" || { echo "FAIL: LICENSE is not MIT"; fail=1; }
exit $fail
