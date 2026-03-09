#!/bin/bash
set -e

echo "Installing dependencies..."
npm install --legacy-peer-deps

echo "Compiling..."
npm run compile

echo "Packaging VSIX..."
vsce package

VSIX=$(ls -t *.vsix | head -1)
echo "Built: $VSIX"
