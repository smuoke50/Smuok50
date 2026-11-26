#!/usr/bin/env bash
# Bundles obd-scanner into ios/www for the app (single classic script: no ES-module loading in the app).
set -euo pipefail
cd "$(dirname "$0")/../.."
rm -rf ios/www
mkdir -p ios/www/icons
npx -y esbuild@0.24.0 obd-scanner/src/app.js --bundle --format=iife --minify --outfile=ios/www/app.js --log-level=warning
cp obd-scanner/styles.css ios/www/
cp obd-scanner/icons/icon.svg ios/www/icons/
sed -e 's#<script type="module" src="src/app.js"></script>#<script src="app.js" defer></script>#' \
    -e '/rel="manifest"/d' \
    obd-scanner/index.html > ios/www/index.html
grep -q '<script src="app.js" defer></script>' ios/www/index.html
echo "ios/www ready: $(ls ios/www | tr '\n' ' ')"
