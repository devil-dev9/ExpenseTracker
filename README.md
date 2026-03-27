# Expense Tracker

Expense Tracker is a full-stack family finance planner built with Node.js, Express, SQLite, and a vanilla frontend. It supports phone + PIN login, admin user management, monthly budgeting, family member contributions, invoices, and exports.

## Local run

```powershell
npm install
Copy-Item .env.example .env
npm start
```

Open [http://localhost:3000](http://localhost:3000).

## Environment variables

- `PORT`: server port
- `SESSION_SECRET`: required in production; use a long random secret
- `DATA_DIR`: folder for SQLite database and session store
- `NODE_ENV`: set to `production` on the hosted site

## Production notes

- The app stores data in SQLite, so production hosting must provide a persistent disk.
- Sessions are cookie-based and should run behind HTTPS.
- Keep `data/` out of git and back it up regularly.

## Render deployment

This repo includes [render.yaml](C:\Users\SushmaReddy\Desktop\Expense%20Tracker\render.yaml) for an easy first deployment.

1. Push this project to GitHub.
2. In Render, create a new Blueprint deployment from the repo.
3. Confirm the generated `SESSION_SECRET`.
4. Deploy and wait for the health check on `/api/health`.

Render will mount a persistent disk at `/var/data`, which keeps the SQLite database and session files across deploys.
