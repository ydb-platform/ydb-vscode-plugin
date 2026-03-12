#!/bin/bash
set -e

echo "Installing dependencies..."
npm install --legacy-peer-deps

echo "Compiling project..."
npm run compile

echo "Type checking..."
npm run typecheck

echo "Running tests..."
npx vitest run
