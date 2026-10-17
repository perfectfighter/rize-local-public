# AI, work integrations, calendars and MCP

These are independent implementations against public APIs. They do not connect to
Rize's private backend. The desktop connects to the companion server using the
account/team setup described in the main README. No provider credentials are bundled.
Tests inject synthetic responses and do not make billable AI or vendor API calls.

## AI setup

Set these on the **server**, then restart it:

```text
RIZE_AI_BASE_URL=https://your-provider.example/v1
RIZE_AI_API_KEY=your-server-side-key
RIZE_AI_MODEL=your-enabled-chat-model
RIZE_EMBEDDING_MODEL=your-enabled-embedding-model
```

Use an HTTPS OpenAI-compatible API exposing `/chat/completions` and, for semantic
suggestions, `/embeddings`. Choose model IDs supported by your provider. The chat
adapter uses `messages`, `stream:false`, and `max_completion_tokens:1800`; the
embedding adapter requests float vectors. Gateways/models with incompatible APIs
must be adapted before use. There is no hard-coded model, free service, or keyword
substitute presented as AI. Requests time out, redirects are rejected, response
sizes are bounded, and vendor errors are sanitized.

Chat and reports send only approved shared entry descriptions, time/tag IDs, and
configured client/project/task names, plus the user's prompt and selected skill.
They never send the local raw application/window titles or pending activity. Each
interactive AI action requires the visible consent checkbox. The configured provider
receives this information and its own retention/billing terms apply. The server's
team/owner filters apply before constructing context. AI text is advisory and cannot
execute tools or mutate time. Reports are saved, editable and deletable. Semantic
tags compare real embedding vectors using cosine similarity; the score is similarity,
not a calibrated probability. All proposals require explicit user approval.

Skills store a name and reusable instructions. Routines store a prompt, optional
skill, an interval of at least 15 minutes, explicit consent, and enabled state.
The server runs them only when `RIZE_RUN_ROUTINES=1`, the server remains running,
and the routine is enabled/due. Scheduler runs are bound to each routine owner's
current team permissions. Missed intervals coalesce into one run; the next run and
safe last error are persisted. Generated reports do not approve or export time.
This is an interval scheduler, not a hosted cron service or an arbitrary code agent.

## Credential storage

Before connecting integrations, generate a random key and set it on the server:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Store the output as `RIZE_SECRET_KEY`; keep it out of source control. The server
uses AES-256-GCM, a random nonce, and team/provider-bound authenticated data for
stored provider tokens. Only encrypted tokens go into server KV; tokens are never
returned by status/list APIs. Back up the key securely with the database. Losing or
changing it makes existing connections unreadable; reconnect using the new key.
A key change does not silently re-encrypt existing records. TLS is required for a
remote server, including requests carrying the connection token from the desktop.

## Work integrations

Team owners/admins can connect, import, export and disconnect. Connection validates
the token with the vendor before saving it. Task import is explicit, paginated and
capped at 2,000 items. Missing remote tasks are never automatically deleted locally.
Synchronization preserves local task tagging and deterministic external IDs.

| Provider | Connection fields | Implemented |
| --- | --- | --- |
| Linear | Personal API key, optional team ID | Import issue IDs/names/status, project relationship and URL through GraphQL. No native time-entry export. |
| ClickUp | Personal token, list ID; workspace ID for time export | Import list tasks including subtasks and closed tasks. Push selected approved linked time with millisecond duration and billable flag. |
| Asana | Personal access token and project ID | Import project tasks. Push selected approved linked time using whole minutes and the entry's ISO start date. |

Asana time tracking requires a vendor plan with time tracking access. Extra add-on
fields are not sent. The API accepts whole minutes, so entries with partial minutes
are rejected instead of silently rounded. Adjust the duration explicitly first.
The entered date is taken from the stored ISO timestamp (UTC); date-local export
policies require explicit date handling before use. Linear issues can be tagged
locally; no invented native time-tracking mutation is sent.

Time export is a separate consented action; import never implicitly exports.
Only entries approved and visible to the invoking account and linked to imported
tasks for that provider are eligible. A persistent per-entry export journal prevents
a retry from duplicating a completed or uncertain vendor write. If connectivity is
lost after a vendor might have accepted an entry, the UI reports the export as
uncertain. Check the vendor before asking the server operator to clear that specific
`time-exports` journal key; never blindly retry or clear all journal records. Already
exported entries are not updated/deleted in the external service when edited locally.
Tokens are scoped by the vendor account; imported task visibility follows that token.

No automatic background provider sync, OAuth marketplace listing, or provider webhooks are implemented. Linear/ClickUp/Asana use personal tokens. Google/Microsoft use the configured OAuth flow below.

## Google and Microsoft OAuth calendars

Register your own confidential **Web application** OAuth clients and set the server's
public origin and credentials. Never put OAuth client secrets in the desktop bundle.

```text
RIZE_PUBLIC_ORIGIN=https://your-server.example
RIZE_GOOGLE_CLIENT_ID=your-google-web-client-id
RIZE_GOOGLE_CLIENT_SECRET=your-google-client-secret
RIZE_MICROSOFT_CLIENT_ID=your-entra-application-client-id
RIZE_MICROSOFT_CLIENT_SECRET=your-entra-client-secret
RIZE_MICROSOFT_TENANT=common
```

Register exact redirect URIs:

```text
https://your-server.example/v1/oauth/google/callback
https://your-server.example/v1/oauth/microsoft/callback
```

Loopback HTTP can be used for local provider testing when the registered web client
permits that exact URI. For a shared server, use HTTPS and the configured external
origin. Enable Google Calendar API, configure its OAuth consent screen/test users or
verification as required, and enable delegated Microsoft Graph `Calendars.Read`.
Google requests `calendar.readonly`; Microsoft requests `Calendars.Read` and
`offline_access`. The provider may require administrator consent depending on policy.

Connect starts a ten-minute, one-use state bound to the current account/team with
PKCE S256. The server stores only a hash of the state and keeps the verifier in its
pending in-memory flow; restarting it safely expires unfinished flows. The callback
rechecks current team admin membership before exchanging its code. Tokens are
exchanged only on fixed HTTPS vendor endpoints and stored in the encrypted vault;
refresh rotates them in that vault, without exposing tokens to the desktop/browser.
The callback returns a plain completion message. Return to the app and refresh status.

Explicit Pull Calendar imports the connected account's **primary calendar** over a
bounded date range, expands vendor recurring instances, follows safe pagination,
and returns calendar context and pending manual-time proposals. It does not approve
work automatically. All-day dates stay all-day; Microsoft UTC responses are converted
to the event's recognized original zone for its calendar date. It does not import
attendees, body text, attachments or email addresses. Calendar summaries and times
are shared team context, so connect an account/calendar appropriate for that team.
OAuth authorization alone does not perform an import or call the AI provider.

Disconnect removes locally stored tokens and unfinished flows; it does not revoke
all provider account sessions or remove the application's grant at Google/Microsoft.
You can revoke the grant from the provider's connected-app settings. There is no
calendar write-back, secondary-calendar picker, push subscription or live two-way
sync. Missing/cancelled events in a later pull do not erase manual time already
created from earlier imports. Live vendor authorization requires your registered
credentials and was not performed by the automated test suite.

## Google and Outlook calendar files

Export a calendar `.ics` file from Google Calendar or Outlook and import it in
Integrations. Choose the original IANA timezone for floating DATE-TIME values and
a date range (at most 366 days). Parsing uses `node-ical`, which handles IANA/Windows
TZID mappings, daylight-saving changes, RRULE, EXDATE and recurrence overrides.
Occurrences are capped at 1,000 and files at 1 MiB. Subdaily recurring rules are
rejected; export expanded occurrences instead. Unknown custom timezone definitions
may require conversion to a recognized IANA timezone before import.

Calendar data is scheduled time, not evidence of work. Events are stored as calendar
context; timed events return proposals to review and add explicitly as pending manual
time. All-day events remain all-day calendar context, and zero-duration reminders
remain zero duration. No one-hour duration is fabricated. Importing the same UID and
occurrence again updates the same context ID. Changes to recurrence identity create
new context; removing events from a later file does not delete previously imported
context or manual entries. ICS import is a file operation. The OAuth pull flow above is an explicit read-only account import, not live two-way synchronization.

## Read-only MCP

The runnable stdio server supports the explicit MCP **2025-11-25** protocol revision
(the initialize-based era). It does not claim support for the 2026 modern protocol.
Launch it as a subprocess through an MCP client that supports this revision:

```text
command: node
args: ["/absolute/path/to/rize-local/server/mcp.cjs"]
env:
  RIZE_SERVER_URL: https://your-server.example
  RIZE_TEAM_ID: selected-team-id
  RIZE_SESSION_TOKEN: session-token-from-your-own-server-login
```

The server also accepts loopback HTTP for local setup. The session token must stay
in the MCP client's secret environment configuration, not in committed JSON. Obtain
it by authenticating directly to your own companion server's `/v1/auth/login` API;
the desktop intentionally never returns its stored token to the renderer. Revoking
or expiring that session revokes MCP access. Do not reuse another user's session.

Tools are `approved_time_entries`, `search_work`, and `team_analytics`. All are
read-only GET operations against the same authenticated/team-authorized APIs.
Entries expose approved descriptions/tags, not raw titles/apps. MCP access grants
the external client the visible approved work data; configure it only deliberately.
No file access, commands, browser sessions, raw local tracker, writes, or unauthenticated
remote MCP HTTP listener are exposed. Standard output contains only JSON-RPC lines.

## Official API and format references

Reviewed 2026-10-17:

- [OpenAI-compatible chat request contract](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)
- [Embedding request contract](https://developers.openai.com/api/reference/resources/embeddings/methods/create)
- [Linear GraphQL endpoint, authentication and errors](https://linear.app/developers/graphql)
- [ClickUp list tasks](https://developer.clickup.com/reference/gettasks)
- [ClickUp create time entry](https://developer.clickup.com/reference/createatimeentry)
- [Asana project tasks](https://developers.asana.com/reference/gettasksforproject)
- [Asana create time tracking entry and plan requirements](https://developers.asana.com/reference/createTimeTrackingEntry)
- [Asana time tracking fields](https://developers.asana.com/reference/time-tracking-entries)
- [RFC 5545 iCalendar](https://www.rfc-editor.org/rfc/rfc5545.html)
- [node-ical parser and recurrence API](https://github.com/jens-maus/node-ical)
- [MCP 2025-11-25 stdio transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)

- [Google web-server OAuth and offline refresh](https://developers.google.com/identity/protocols/oauth2/web-server)
- [Google PKCE sample maintained by Google](https://github.com/googleapis/google-auth-library-nodejs/blob/main/samples/oauth2-codeVerifier.js)
- [Google Calendar events list and recurrence expansion](https://developers.google.com/workspace/calendar/api/v3/reference/events/list)
- [Microsoft authorization code flow with PKCE](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow)
- [Microsoft calendarView range, timezone and pagination](https://learn.microsoft.com/en-us/graph/api/calendar-list-calendarview?view=graph-rest-1.0)
