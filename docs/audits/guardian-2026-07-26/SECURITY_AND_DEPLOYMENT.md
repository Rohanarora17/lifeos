# Security and Deployment Configuration

Production now fails closed unless authentication is configured.

## Required Server Variables

```dotenv
LIFEOS_AUTH_MODE=required
LIFEOS_API_TOKEN=<random 32-byte-or-longer secret>
LIFEOS_ADMIN_REAUTH_TOKEN=<different random 32-byte-or-longer secret>
LIFEOS_DEVICE_TOKEN=<different random 32-byte-or-longer secret>
LIFEOS_ALLOWED_ORIGINS=http://100.99.194.80:3000
LIFEOS_EXTENSION_ID=<installed Chrome extension id>
```

Generate each token independently with:

```bash
openssl rand -hex 32
```

The current deployment uses HTTP over Tailscale. Set
`LIFEOS_COOKIE_SECURE=false` only for that private HTTP deployment. Move the
service to HTTPS before making it reachable beyond the tailnet.

## Client Credentials

- Chrome extension `API Key`: `LIFEOS_API_TOKEN`, because the popup reads
  personal dashboard and Guardian data.
- Native MacBook client: `LIFEOS_DEVICE_TOKEN`, supplied in its launchd
  environment along with `LIFEOS_SERVER_URL=http://100.99.194.80:3000`.
- Destructive admin calls: send `X-LifeOS-Reauth-Token` with
  `LIFEOS_ADMIN_REAUTH_TOKEN` in addition to the authenticated session.

Never place either token in URLs, logs, screenshots, or audit fixtures.

## Deployment Sequence

GitHub Actions now:

1. checks out and tests the exact source commit;
2. runs the static Guardian audit harness and extension syntax checks;
3. builds the Next.js production application;
4. fetches the exact verified commit on the Mac Mini;
5. writes the deployment commit into `.env.local`;
6. takes an SQLite online backup before migrations;
7. rotates oversized logs without deleting the newest retained copies;
8. restarts every installed LifeOS launchd service; and
9. requires authenticated diagnostics to become reachable.

The remote working directory is still a single release directory. A true
symlink-based atomic release requires updating the installed launchd plist
working directories and remains pending until SSH access is available.

## First Deployment Checks

```bash
curl -H "Authorization: Bearer $LIFEOS_API_TOKEN" \
  http://100.99.194.80:3000/api/diagnostics

LIFEOS_LOG_MAX_BYTES=52428800 node scripts/rotate-logs.cjs
node scripts/guardian-audit-harness.cjs
```

Do not run reset-route tests against `data/lifeos.db`. Use a dedicated
`LIFEOS_DB_PATH` and the study schema in this evidence bundle.
