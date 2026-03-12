#!/bin/sh
# Find free ports for worker API and Vite frontend, then start both.

# Kill all children on exit (ensures workerd releases its port)
cleanup() { kill 0 2>/dev/null; }
trap cleanup EXIT INT TERM

find_free_port() {
  port=$1
  while lsof -i :"$port" >/dev/null 2>&1; do
    port=$((port + 1))
  done
  echo "$port"
}

WORKER_PORT=$(find_free_port 4555)
VITE_PORT=$(find_free_port $((WORKER_PORT + 1)))

export WORKER_PORT VITE_PORT

echo ""
echo "  Open → http://localhost:$VITE_PORT"
echo ""

cd apps/web
mkdir -p dist/client
cat > dist/client/index.html <<PLACEHOLDER
<!DOCTYPE html>
<html><head><meta http-equiv="refresh" content="0;url=http://localhost:$VITE_PORT"></head>
<body>Redirecting to <a href="http://localhost:$VITE_PORT">dev server</a>...</body></html>
PLACEHOLDER

pnpm exec concurrently -n worker,vite -c blue,green --kill-others \
  "pnpm exec wrangler dev --var DEV_MODE:true --port $WORKER_PORT" \
  "pnpm exec vite --port $VITE_PORT"
