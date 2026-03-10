#!/bin/bash
# Build, deploy to local OpenClaw, and restart gateway
set -e

echo "Building..."
npm run build

echo "Copying to extensions..."
cp dist/* ~/.openclaw/extensions/port42-openclaw/dist/

echo "Restarting gateway..."
npx openclaw gateway restart

echo "Done. Checking logs in 3s..."
sleep 3
tail -20 ~/.openclaw/logs/gateway.log | grep -E '\[port42\]|error|Error' || echo "No port42 log lines found"
