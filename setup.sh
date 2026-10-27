#!/bin/bash
# One-command setup: installs dependencies, creates your .env if missing,
# makes the data folder, then starts the server.
# Run this from inside the karo-recon folder: bash setup.sh

set -e

if [ ! -f .env ]; then
  echo "No .env found — copying .env.example to .env"
  echo "Open .env and fill in your real M-Pesa/Equity keys before going live."
  cp .env.example .env
fi

mkdir -p data

echo "Installing dependencies..."
npm install

echo "Starting server..."
npm start
