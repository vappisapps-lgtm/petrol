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

## Hostinger MySQL

To use Hostinger MySQL instead of SQLite, set these environment variables:

```text
DB_DIALECT=mysql
DB_HOST=127.0.0.1
DB_PORT=3306
DB_NAME=u116612688_petrol
DB_USER=u116612688_petrol
DB_PASSWORD=<your saved MySQL password>
```

The app creates the MySQL tables on startup. To copy the old live SQLite data into empty MySQL tables, also set a temporary one-time code:

```text
MYSQL_MIGRATION_CODE=<temporary code you choose>
```

Then open `/admin/mysql-migrate` on the live site and submit that code. The migration refuses to run if MySQL already has users, so it does not overwrite an active database.

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
