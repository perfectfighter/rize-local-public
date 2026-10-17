# Rize Local

An independent Windows desktop time tracker with a Rize-inspired interface and an
optional self-hosted service for accounts, team synchronization, AI, and work
integrations. It contains no proprietary Rize application bundle and does not use
Rize's private backend. It is not affiliated with Rize.

The local tracker works without an account or API key. Cloud features need your
own running service; AI and integrations need configured provider accounts. This
repository is an implementation, not a claim of complete Rize product parity.
See the [feature matrix](docs/FEATURES.md) for exact behavior and remaining limits.

## Run the desktop app

Use Windows x64, Node.js **22.13 or newer**, and npm:

```sh
npm ci
npm test
npm run build
npm start
```

Choose **Create my workspace** for an empty workspace or **Explore a sample
workspace** for labeled sample records. Automatic tracking is off by default and
cannot run in sample mode. Enable it with the power button or in Settings.

Manual entries, timers, and local data can run in Electron on other desktop
systems; native foreground tracking and the packaged download target Windows x64.
`npm run dev` is a read-only browser UI preview with sample data. It does not
record or save workspace changes.

## What is implemented

- Opt-in foreground app/window collection, idle cutoff, schedules, private-window
  redaction, exclusions, local tagging rules, and local storage.
- Day/week/month calendars; manual entries; review, split, merge, bulk edits,
  rule regeneration, labels, and client/project/task tagging.
- Focus, meeting, and break timers with pause/resume, goals, extensions, and saved
  active intervals; local noise/ambient audio and user-selected audio files.
- Personal/team timesheets, weekly allocations/capacity, strict allocation CSV
  import, contracts, multicurrency profitability, invoice PDF export, and manual
  payment records.
- Self-hosted accounts, teams, invitations, role and resource permissions,
  versioned synchronization, explicit conflict choices, and opt-in automatic sync.
- Configured AI chat, embedding-based tagging proposals, saved editable reports,
  skills, recurring report routines, and a read-only MCP stdio service.
- Explicit task imports from Linear, ClickUp, and Asana; approved-time export to
  supported ClickUp/Asana tasks; calendar import with recurrence and timezone
  handling; Google Calendar and Outlook OAuth with explicit primary-calendar
  pulls when registered applications are configured. Provider setup details are in
  [PROVIDERS.md](docs/PROVIDERS.md).
- Portable Windows packaging and NSIS installer packaging. Update checks,
  downloads, and installation have an implemented trust-checked path for a signed
  installed release; the unsigned development artifacts cannot update themselves.

Invoices do not email clients or charge payment methods. Vendor credentials,
licensed music services, hosted infrastructure, production signing certificates,
and a published update feed are not included.

## Connect accounts, teams, and providers

Start the companion service in a separate terminal:

```sh
npm run server
```

It listens on `http://127.0.0.1:4791` and stores its SQLite database under `data/`
by default. In the desktop's **Team** page, configure that address, register or
sign in, and create or join a team. Review the sharing consent before synchronizing.
An invitation produces a single-use code for a specific email; the app does not
send the code by email. Share it using your own communication channel.

[SELF-HOSTING.md](docs/SELF-HOSTING.md) covers durable storage, TLS, roles,
registration, backups, and deployment. [PROVIDERS.md](docs/PROVIDERS.md) covers AI,
provider credentials, calendars, and MCP. A local server needs no provider key until
you enable a feature that calls that provider.

## Build the Windows downloads

```sh
npm ci
npm test
npm run build
npm run package:windows
npm run package:installer
```

Portable packaging requires Python 3. It downloads the pinned official Electron
Windows runtime, verifies its SHA-256 against the official manifest, checks the
x64 executable/native addon headers, and creates
`release/rize-local-windows-x64.zip`. Extract the entire folder and launch
`RizeLocal.exe`; keep its companion files. Editable source is included.

Installer packaging produces a Windows x64 NSIS `.exe` under `release/`.
These are unsigned development artifacts unless a publisher supplies signing
credentials and matching release configuration. Do not describe an unsigned build
as a verified commercial publisher release.

The **Build Windows desktop app** GitHub Actions workflow runs tests, the renderer
build, portable packaging, and installer packaging on Windows. Download its
`rize-local-windows-x64` and `rize-local-windows-installer` artifacts after a
successful run. Artifacts are retained for 30 days. CI does not automatically
publish a GitHub Release or deploy a server.

For functional self-updates, the publisher must configure `win.publisherName` to
match the actual Authenticode certificate, sign the NSIS installer, and publish a
newer GitHub Release with its installer, blockmap, and matching `latest.yml` to the
configured repository/feed. The default unsigned build has no trusted publisher;
its update page explains that setup is required. Portable/dev builds do not install
updates. Checks, downloads, and restart/install remain separate user actions.

The explicit `npm run release:windows` command publishes only on Windows with
`WIN_PUBLISHER_NAME`, `CSC_LINK`, `CSC_KEY_PASSWORD`, and `GH_TOKEN` configured.
It forces code signing and uses the certificate's actual publisher identity.
Run tests and the renderer build first. This command creates a public release;
ordinary CI and `package:installer` do not publish one.

## Time and billing behavior

Calendar work hours count approved intervals once, excluding overlap. Personal
reports/timesheets sum each saved entry interval; overlapping entries count
individually there. Team analytics unions overlapping approved time per person/day
in the selected timezone. These views deliberately answer different questions.

Manual sessions create entries only if automatic collection was off throughout the
session, preventing duplicate tracking. Breaks remain in session history but do not
become work entries. Running timers checkpoint completed active intervals; after a
restart they resume only when explicitly requested. Closed-app time is not counted.

Contracts support hourly, fixed-period retainer, and retainer-plus-overage terms.
Retainer/hybrid contracts require an end date and matching invoice period; there is
no automatic recurrence or proration. Financial reports keep currencies separate,
use integer minor units for money, and do not perform FX conversion. Invoices use
UTC entry-start dates for selecting time, reserve a permanent invoice number, and
freeze the line/rate snapshot once marked sent. Payments record money received
outside the app. This is operational billing software, not tax determination or a
payment gateway.

## Data and privacy

The desktop keeps `workspace.json` in Electron's per-user **Rize Local** app-data
directory. Export backups in Settings before moving or replacing data. Import
validates the workspace, asks for replacement confirmation, and disables imported
tracking. Closing the window hides it to the tray; **Quit Rize Local** exits.

Raw app/window metadata and pending entries remain local. The app does not collect
screenshots, keystrokes, executable paths, or URLs. Recognizable private-window
titles are redacted, and rules can exclude additional sensitive windows. Approved
entry descriptions may still contain sensitive text: review them before sharing.

Cloud sync sends only reviewed descriptions, intervals, tags, and permitted team
records. Server administrators operate the database; this is not end-to-end
encryption. Provider tokens are encrypted in server storage with your supplied
key. Desktop session tokens remain in the main process and are persisted only
when platform secure storage is available. AI and provider actions require their
visible consent and configuration; those services receive the selected work data.

## Validation and limitations

Run `npm test` for the automated accounting, storage, native-contract, renderer/DOM,
authentication, authorization, sync, provider, calendar, audio, and updater tests.
Provider tests use injected responses and make no billable vendor requests. CI
builds Windows packages; it does not prove foreground collection, tray operation,
listening experience, production signing, live OAuth, or visual fidelity on a user's
Windows device. These require live verification before a production rollout.

See [RECONSTRUCTION.md](docs/RECONSTRUCTION.md) for provenance and earlier
reconstruction limits. Dependencies are pinned by `package-lock.json`; asset and
dependency licenses are in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
