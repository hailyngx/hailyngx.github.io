#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
unset npm_config_prefix NPM_CONFIG_PREFIX

NODE_BIN=""
for dir in \
  "$HOME/.nvm/versions/node/v22.5.1/bin" \
  /opt/homebrew/opt/node@22/bin \
  /opt/homebrew/opt/node@20/bin
do
  if [[ -x "$dir/node" ]]; then
    NODE_BIN="$dir"
    break
  fi
done

if [[ -z "$NODE_BIN" ]]; then
  echo "Need Node 18 or newer to run this blog." >&2
  exit 1
fi

export PATH="$ROOT/node_modules/.bin:$NODE_BIN:$PATH"
exec "$@"
