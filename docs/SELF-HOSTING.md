# Run your own companion service

The desktop remains usable locally without this service. Accounts, shared teams,
AI, integrations, and MCP connect to this independent server, not Rize's backend.
No server or paid provider account has been provisioned by the source repository.

## Requirements and local start

Use Node.js **22.13+** with its built-in `node:sqlite`, npm, a persistent local disk,
and a trusted environment. Run one service process per SQLite database. From the
repository root:

```sh
npm ci
npm test
npm run server
```

The default listener is `127.0.0.1:4791`. `GET /healthz` returns JSON with `ok:true`.
The default database is `data/rize-service.sqlite` relative to the process working
directory. It is created with WAL journaling and restrictive file permissions
where supported. Use an absolute `RIZE_DB_PATH` in any long-running deployment.
Do not put this database on ephemeral storage or commit it to Git.

In the desktop **Team** page, set `http://127.0.0.1:4791`, then register with your
name, email and a 12–256 character password. Create a team, or use an invitation
code issued for the same email address. Select the team, review the descriptions
you will share, approve the sharing consent, and choose **Sync approved workspace**.
Automatic sync is a separate opt-in while the desktop remains open. Conflicts stop
for review and never choose a winner automatically.

## Configuration

Set environment variables in the process manager or secret manager that starts the
server. The application does not promise automatic `.env` loading. Restart after
changing configuration.

| Variable | Default / meaning |
| --- | --- |
| `RIZE_DB_PATH` | `data/rize-service.sqlite`; use an absolute persistent path |
| `RIZE_SERVER_HOST` | `127.0.0.1`; non-loopback binding requires `RIZE_PUBLIC_ORIGIN` |
| `RIZE_SERVER_PORT` | `4791`; `PORT` takes precedence when set |
| `RIZE_PUBLIC_ORIGIN` | Exact `https://host` origin required for non-loopback binding; no path/trailing slash |
| `RIZE_ALLOWED_ORIGINS` | Empty by default; comma-separated exact browser origins; HTTPS except loopback HTTP |
| `RIZE_DISABLE_REGISTRATION` | Set `1` to reject new account registration |
| `RIZE_SECRET_KEY` | Base64 encoding of a random 32-byte provider-credential encryption key |
| `RIZE_AI_BASE_URL` | HTTPS OpenAI-compatible API base, such as your provider's `/v1` endpoint |
| `RIZE_AI_API_KEY` | Server-side AI provider credential |
| `RIZE_AI_MODEL` | Chat model available to your provider account |
| `RIZE_EMBEDDING_MODEL` | Embedding model used for semantic tag proposals |
| `RIZE_RUN_ROUTINES` | Set `1` to run enabled/due consented routines; otherwise disabled |
| `RIZE_GOOGLE_CLIENT_ID` / `RIZE_GOOGLE_CLIENT_SECRET` | Registered confidential Google Web application credentials for read-only Calendar OAuth |
| `RIZE_MICROSOFT_CLIENT_ID` / `RIZE_MICROSOFT_CLIENT_SECRET` | Registered confidential Microsoft Web application credentials for delegated Calendar OAuth |
| `RIZE_MICROSOFT_TENANT` | Optional Microsoft tenant, default `common` |

Generate an encryption key once:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Store the output as the server's `RIZE_SECRET_KEY` in secret configuration. Back it
up separately from the database. Provider tokens are AES-256-GCM encrypted with
team/provider-bound authenticated data. The key is not generated or stored for
you. Losing/changing it makes existing tokens unreadable; reconnect providers after
an intentional rotation. Tokens are not returned by list/status APIs.

For a temporary PowerShell local setup, for example:

```powershell
$env:RIZE_DB_PATH = Join-Path $PWD 'data\rize-service.sqlite'
$env:RIZE_SECRET_KEY = node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
npm run server
```

That example creates a new key in the current process environment; preserve it
securely before restarting if you connect integrations. It is not durable secret
provisioning. Keep provider API keys and session tokens out of shell transcripts,
logs, screenshots, source, and committed client configurations.

## Remote deployment and TLS

Run the service under a dedicated OS identity with write access only to its data
folder. Keep a stable working directory or use an absolute database path. Configure
a process manager to restart the service and deliver SIGTERM for graceful shutdown.
The process itself serves HTTP; put a correctly configured TLS reverse proxy in
front of it. The desktop accepts HTTPS for remote addresses and plain HTTP only
for loopback.

A same-machine proxy can forward to `127.0.0.1:4791` while the service keeps its
loopback default. For a container/private-network listener, set
`RIZE_SERVER_HOST=0.0.0.0` and `RIZE_PUBLIC_ORIGIN=https://your-real-host`, restrict
the backend port to the proxy, and terminate TLS at that proxy. Setting the origin
variable does not create TLS, a certificate, DNS, or a firewall rule.

Only add `RIZE_ALLOWED_ORIGINS` for browser clients you actually operate. Native
main-process requests do not need a browser CORS origin. The server rejects
unlisted supplied origins and wildcard origin configuration; it does not use
cookie-based sessions. Request bodies, header counts, provider response sizes,
timeouts, and authentication attempts are bounded. Rate limits are process-local;
a reverse proxy should also enforce appropriate connection limits. Do not assume
untrusted forwarded headers become a real-client-IP rate limit.

The service is a single-node SQLite application, not a distributed high-availability
cluster. Put the database and its WAL on one durable local volume. Do not run
multiple independent containers against an unsupported shared filesystem.

## Permissions and account operation

| Role / permission | Scope |
| --- | --- |
| Owner | Team administration plus finance/resourcing; may change another member's role/resource flags |
| Admin | Invite/manage permitted lower roles and shared work; personal shared records visible across the team |
| Member | Own approved time, skills, routines, reports and context; cannot administer shared projects/tasks |
| Viewer | Read permitted records; no writes |
| Finance flag | Finance records for non-viewers; being admin alone does not automatically grant this flag |
| Resourcing flag | Allocation records for non-viewers; being admin alone does not automatically grant this flag |

Team owners/admins can read team members' approved shared work; ordinary members
see their own personal records. The APIs enforce the permissions independently of
the renderer. Self role edits, escalation by admins, and removing the final owner
are rejected. Invitations expire after seven days, are single-use, are bound to the
recipient email, and are not emailed by this server.

Passwords use salted scrypt; only hashed opaque session tokens are stored in the
database. Sessions expire after seven days; logout revokes that session. Desktop
sessions remain in the main process and persist only through available Electron
secure storage. Otherwise they are session-only. There is no bundled MFA, SSO,
email verification/password-reset, email delivery, or support recovery service.
Choose an operator/account policy that matches this scope before exposing signup.
After creating the intended accounts, set `RIZE_DISABLE_REGISTRATION=1` if new
self-service registration should stop; reopen it deliberately for onboarding.

## Privacy and sharing

Only approved entry descriptions, timestamps, durations and tags synchronize.
Raw application/window titles, URLs, paths, device details and pending activity
are rejected by the server entry schema. Descriptions can still contain private
material, so review them before approval and sharing. Finance/allocation records
have separate permissions. Version conflicts preserve both versions for explicit
resolution; tombstones apply only to synchronized IDs, not unrelated local work.

The server operator can read approved shared records and account metadata in the
database. This is not end-to-end encrypted team storage. The encryption key protects
stored integration credentials, not all team content. AI sends permitted approved
context and the user's prompt/skill to the configured provider only with consent;
provider retention and usage charges apply. Interval routines retain their explicit
consent and run under their owner's current permissions. Integrations may send
consented selected time to their vendor. Read [PROVIDERS.md](PROVIDERS.md) before
connecting accounts.

## Backups, upgrades, and recovery

Back up desktop JSON workspaces separately from the server database. Before a
server upgrade, stop the service gracefully, then copy its database directory
(including any remaining `-wal`/`-shm` files) to protected storage. Keep a secure,
separate copy of `RIZE_SECRET_KEY`. Restart only after the copy completes. A raw
copy of a running WAL database is not a guaranteed consistent backup; use a proper
SQLite online backup mechanism if downtime is unacceptable.

To restore, stop the service, restore the complete database backup with appropriate
permissions, restore the matching key, and restart. Test restoration on an isolated
service before depending on a backup. A restored older server may invalidate sync
cursors; preserve local backups and perform a deliberate full synchronization.
Do not clear conflict/version state or uncertain vendor-write journals blindly.

For upgrades, take a backup, fetch the intended source revision, run `npm ci` and
`npm test`, and restart against the same data path. Schema creation is currently
additive; the repository does not provide arbitrary downgrade migrations, encrypted
full-database backups, multi-node orchestration, or a hosted disaster-recovery SLA.

## AI, integrations, calendars, and MCP

Google and Microsoft live calendar access requires registered confidential Web
applications, consent configuration, and an HTTPS `RIZE_PUBLIC_ORIGIN`. Register
exact callbacks `/v1/oauth/google/callback` and `/v1/oauth/microsoft/callback` under
that origin. Google needs Calendar API access and permitted consent/test users;
Microsoft needs delegated `Calendars.Read` and offline access. State/PKCE and
encrypted refresh-token handling are implemented. Imports explicitly pull only the
primary calendar, keep all-day context, and propose timed entries for review.
They do not write back, subscribe to push changes, choose secondary calendars, or
automatically approve work. Disconnect removes stored tokens; revoke the app grant
in the provider account separately if desired. No live vendor consent was verified
without actual operator credentials.

Provider-specific configuration, calendar file limits, export semantics, and MCP
setup are documented in
[PROVIDERS.md](PROVIDERS.md). Credentials are never bundled. Synthetic provider
coverage does not establish live vendor plan access, OAuth approval, or a
production deployment.

`npm run mcp` runs the read-only stdio MCP process. It needs `RIZE_SERVER_URL`,
`RIZE_TEAM_ID`, and a separate server session token in `RIZE_SESSION_TOKEN`.
Obtain that token by authenticating to your own service API; the desktop deliberately
does not expose its token. Store it only in the MCP client's secret environment.
Its revocation/expiry also revokes MCP access. The stdio process is not a public
HTTP endpoint and cannot mutate work, execute commands, or access the raw tracker.
