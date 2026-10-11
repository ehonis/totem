#!/bin/sh

set -eu

if command -v tailscale >/dev/null 2>&1; then
  TAILSCALE_IP="$(tailscale ip -4 | head -n 1 | tr -d '\r')"
else
  TAILSCALE_IP="$(ip -4 addr show tailscale0 | awk '/inet / { sub(/\/.*/, "", $2); print $2; exit }')"
fi

if [ -z "${TAILSCALE_IP:-}" ]; then
  echo "Could not determine a Tailscale IPv4 address. Is Tailscale connected?" >&2
  exit 1
fi

echo "Using Tailscale IP: $TAILSCALE_IP"
export REACT_NATIVE_PACKAGER_HOSTNAME="$TAILSCALE_IP"

exec npx expo start --lan "$@"
