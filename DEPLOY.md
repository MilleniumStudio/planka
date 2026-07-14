# Deploying PLANKA on the FS server

How our fork actually runs on `planka.firestorm-servers.com` (51.178.138.1) and how to
update it safely. Verified against the live server on 2026-07-14.

## How it runs

Everything lives under `/opt/planka` on the server:

```
/opt/planka/
├── docker-compose.yml   ← THE REAL COMPOSE FILE (builds the image locally)
├── .env                 ← BASE_URL, DEFAULT_ADMIN_*, referenced by compose
├── planka/              ← git clone of this repo (origin = MilleniumStudio/planka)
├── backup/              ← daily DB backups (cron)
├── cron/                ├─ backup scripts
└── logs/app             ← app logs (mounted into the container)
```

- **Ignore `planka/docker-compose.yml`** (inside the repo). That is upstream's stock
  file pointing at the official registry image — it is NOT what runs here.
- `/opt/planka/docker-compose.yml` **builds the image locally** from `./planka` and tags
  it `planka:latest`. It passes `NODE_OPTIONS=--max-old-space-size=4096` as a build arg
  (the client build runs out of memory without it — the Dockerfile consumes it via
  `ARG NODE_OPTIONS`).
- Containers: `planka` (app, host port 3000 behind the reverse proxy) and `planka_db`
  (postgres:16-alpine, volume `planka_db-data`).
- **Database migrations run automatically**: the image's `start.sh` executes
  `node db/init.js` (knex `migrate.latest` + seeds) on every container start. There is
  never a manual SQL step.
- The boot seed re-asserts the default admin account from `.env` on every start —
  changing that account's password/role in the UI gets reverted at next boot.

## Update procedure

Prerequisite: the commit you want to deploy is pushed to
`github.com/MilleniumStudio/planka` `master`.

```bash
cd /opt/planka

# 1. Fresh DB dump (escape hatch; daily cron backups exist in ./backup too)
docker exec planka_db pg_dump -U postgres -Fc planka > pre-deploy-$(date +%Y%m%d-%H%M).dump

# 2. Keep the current image for instant rollback
docker tag planka:latest planka:rollback-$(date +%Y%m%d)

# 3. Update the source
git -C planka pull --ff-only

# 4. Rebuild (takes several minutes; NODE_OPTIONS comes from the compose build args)
docker compose build planka

# 5. Swap containers — migrations run automatically during startup
docker compose up -d

# 6. Watch it come up (Ctrl+C to stop following)
docker logs -f planka
```

Verify after deploy:

```bash
docker ps                                  # planka should become "healthy" (~15-30s)
docker exec planka_db psql -U postgres -d planka \
  -c "SELECT name FROM migration ORDER BY id DESC LIMIT 5;"   # newest migrations listed
```

Then log in on the website as an admin and click around.

Afterwards, optionally reclaim disk (the server runs ~85% full):

```bash
docker image prune -f
```

## Rollback

Migrations are one-way in practice — rolling back means restoring the database dump,
not just the old image.

```bash
cd /opt/planka
docker compose stop planka

# Restore the pre-deploy dump
docker exec -i planka_db pg_restore -U postgres -d planka --clean --if-exists < pre-deploy-<timestamp>.dump

# Put the old image back
docker tag planka:rollback-<date> planka:latest
git -C planka reset --hard <previous-commit>     # keep repo in sync with the image
docker compose up -d
```

## Expected side effects of an update

- If the update includes new migrations that touch sessions (e.g. the 2026-07 terms
  migration), **all users are logged out once** and must log back in.
- Brief downtime (seconds to ~1 min) while the container swaps and migrations run.

## Quirks / history

- The commented-out `image: ghcr.io/milleniumstudio/planka:master` line in the compose
  file is an abandoned experiment (registry publishing was never set up); local build
  is the way.
- Empty files `/opt/planka/build` and `/opt/planka/vite`, and the July-2025
  `planka_backup.*` dumps, are leftovers; safe to ignore.
- The `favicons` volume is declared but not mounted into the app container, so the
  favicon cache (link previews) resets on rebuild. Cosmetic; add
  `- favicons:/app/public/favicons` to the planka service volumes if it ever matters.
