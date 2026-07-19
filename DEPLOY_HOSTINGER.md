# Hostinger Node.js Deployment

This repository has been converted to a Node.js app for Hostinger's Node.js app flow.

## Hostinger settings

- Build/install command: `npm install`
- Start command: `npm start`
- Entry file: `app.js`
- Node version: Node 20 or newer
- Port: use Hostinger's provided `PORT` environment variable
- Required environment variable: `SESSION_SECRET`
- Optional environment variable: `PETROL_DATA_DIR` for the persistent SQLite folder
- Optional environment variable: `PETROL_DB` for the exact SQLite file path

## Data

On Linux/Hostinger, the app stores SQLite outside the deploy folder by default:

```text
$HOME/petrol-station-data/petrol_station.sqlite3
```

On first startup after this change, if the persistent DB is missing and an old `petrol_station.sqlite3` exists in the app folder, the app copies it into the persistent folder. It never overwrites an existing persistent DB.

Keep backups before major live changes. `/health` shows the active `database_dir` so you can verify the app is not using the deploy folder.

## Local run

```bash
npm install
npm start
```

Then open `http://127.0.0.1:3000`.
