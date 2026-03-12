#!/bin/sh
# Find free ports for worker API and Vite frontend, then start both.

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

exec pnpm exec concurrently -n worker,vite -c blue,green --kill-others \
  "pnpm exec wrangler dev --var DEV_MODE:true --port $WORKER_PORT" \
  "pnpm exec vite --port $VITE_PORT"
