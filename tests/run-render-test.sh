#!/usr/bin/env bash
# Headless render smoke test runner.
# The app's index.mjs imports 'react' and '@kirocrew/app-sdk' from the dashboard's
# browser import map — not resolvable in plain node. This runner rewires a COPY:
#   react / react-dom  → resolved via a node_modules that has React (KiroCrew website checkout)
#   @kirocrew/app-sdk  → local stub (useNavigate)
set -euo pipefail
cd "$(dirname "$0")"

REACT_HOST="${REACT_HOST:-/workplace/rubencu/KiroCrew/website}"
if [ ! -d "$REACT_HOST/node_modules/react" ]; then
  echo "SKIP: no react at $REACT_HOST/node_modules (set REACT_HOST)"; exit 0
fi

# Stub app-sdk
cat > app-sdk-stub.mjs <<'EOF'
export function useNavigate() { return () => {} }
EOF

# Rewired copy of the UI module (imports only — code untouched)
sed -e "s|from 'react'|from '$REACT_HOST/node_modules/react/index.js'|" \
    -e "s|from '@kirocrew/app-sdk'|from './app-sdk-stub.mjs'|" \
    -e "s|from './classify.mjs'|from '../ui/classify.mjs'|" \
    ../ui/index.mjs > index.test-rewired.mjs

# Rewire the harness's react imports the same way
sed -e "s|from 'react'|from '$REACT_HOST/node_modules/react/index.js'|" \
    -e "s|from 'react-dom/server'|from '$REACT_HOST/node_modules/react-dom/server.js'|" \
    render.test-harness.mjs > render.test-rewired.mjs

PATH="$HOME/.kiro/crew/node20-clean:$PATH" node render.test-rewired.mjs
rc=$?
rm -f app-sdk-stub.mjs index.test-rewired.mjs render.test-rewired.mjs
exit $rc
