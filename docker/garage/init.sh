#!/usr/bin/env sh
set -eu

GARAGE_CONFIG="${GARAGE_CONFIG:-/etc/garage.toml}"
ACCESS_KEY_ID="${GARAGE_ACCESS_KEY_ID:-trinket-dev-key}"
SECRET_ACCESS_KEY="${GARAGE_SECRET_ACCESS_KEY:-trinket-dev-secret-key}"
BUCKETS="${GARAGE_BUCKETS:-trinket-userassets trinket-snapshots trinket-materials trinket-useravatars trinket-exports}"

garage() {
  /garage -c "$GARAGE_CONFIG" "$@"
}

echo "Waiting for Garage to become available..."
until garage status >/dev/null 2>&1; do
  sleep 1
done

if garage status | grep -q "NO ROLE"; then
  NODE_ID="$(garage node id -q | cut -d@ -f1)"
  garage layout assign -z dc1 -c 1G "$NODE_ID"
  garage layout apply --version 1
fi

if ! garage key info "$ACCESS_KEY_ID" >/dev/null 2>&1; then
  garage key import "$ACCESS_KEY_ID" "$SECRET_ACCESS_KEY" -n "Trinket development key" --yes
fi

for BUCKET in $BUCKETS; do
  if ! garage bucket info "$BUCKET" >/dev/null 2>&1; then
    garage bucket create "$BUCKET"
  fi

  garage bucket allow --read --write --owner "$BUCKET" --key "$ACCESS_KEY_ID"
  garage bucket website --allow "$BUCKET"
done

echo "Garage is initialized for Trinket."
