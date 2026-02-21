#!/bin/bash
set -e

echo "Installing dependencies..."
npm install --legacy-peer-deps

echo "Compiling project..."
npm run compile

echo "Running tests..."
npx vitest run
