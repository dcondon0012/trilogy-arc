
#!/bin/bash

set -e

cd /opt/trilogy

git fetch -q origin main

[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] && exit 0

git reset --hard origin/main

npm install --no-audit --no-fund

sudo systemctl restart trilogy

echo "deployed $(git rev-parse --short HEAD) at $(date)"

