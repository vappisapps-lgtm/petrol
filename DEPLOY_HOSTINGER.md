# Hostinger Node.js Deployment

This repository has been converted to a Node.js app for Hostinger's Node.js app flow.

## Hostinger settings

- Build/install command: `npm install`
- Start command: `npm start`
- Entry file: `app.js`
- Node version: Node 20 or newer
- Port: use Hostinger's provided `PORT` environment variable
- Required environment variable: `SESSION_SECRET`
- Optional environment variable: `PETROL_DB` if the SQLite file is stored outside the project root

## Data

The app uses `petrol_station.sqlite3` in the project root by default. Keep a backup before every live deploy if real station data is inside this file.

## Local run

```bash
npm install
npm start
```

Then open `http://127.0.0.1:3000`.
