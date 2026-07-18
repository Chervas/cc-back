#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

while IFS= read -r -d '' file; do
  php -l "$file" >/dev/null
done < <(find "$ROOT" -type f -name '*.php' -print0 | sort -z)

php "$ROOT/tests/test-plugin.php"
node "$ROOT/tests/generate-node-contract.js" | php "$ROOT/tests/test-node-contract.php"
node "$ROOT/tests/generate-real-compiler-contract.js" | php "$ROOT/tests/test-real-compiler-contract.php"
node "$ROOT/tests/generate-provisioned-package.js" | php "$ROOT/tests/test-provisioned-package.php"
