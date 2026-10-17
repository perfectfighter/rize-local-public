# Rize Local

An independent Windows desktop time tracker with a Rize-inspired application
interface. This is a reconstruction from retained implementation and research
notes after the earlier workspace was cleaned up. It is not the exact lost
source or the official Rize application.

## Run from source

Use Windows x64, Node.js 22 or newer, and npm:

```sh
npm ci
npm run build
npm test
npm start
```

Choose **Create my workspace** for an empty workspace or **Explore a sample
workspace** for labeled sample records. Automatic tracking is off by default
and cannot run in sample mode. Enable it with the power button or in Settings.

Manual entries and timers can run in Electron on other desktop systems, but
automatic foreground tracking and the portable package target Windows x64.
`npm run dev` opens a read-only browser UI preview with sample data; it does not
record or save workspace changes.

## Build the Windows download

```sh
npm run build
npm test
npm run package:windows
```

The packager uses Python 3, downloads the official pinned Electron Windows
runtime, verifies its SHA-256 against the official manifest, checks Windows x64
executable/addon headers, and creates `release/rize-local-windows-x64.zip`.
Extract its entire folder and launch `RizeLocal.exe`. Keep its companion files.
The package includes an editable source ZIP. It is an unsigned development build.

The included **Build Windows desktop app** GitHub Actions workflow runs on pushes
to `main`, pull requests, or manual dispatch. Once it passes, open the workflow
run's Artifacts section for `rize-local-windows-x64`. Artifacts are retained for
30 days; GitHub retains the source repository until you delete it. No release
or public website is automatically published.

## Features

- Local, opt-in active app/window-title collection using a bundled Windows
  native helper and Electron idle detection. Five-second samples, idle cutoff,
  work schedules, sensitive-app exclusions, local rules and keyword tags.
- Day/week/month calendars, exact timestamp editing, overlapping entry lanes,
  manual time, linked client/project/task tags, and pending entry review.
- Focus/meeting/break sessions with goals, targets, pause/resume/end, extension,
  actual active intervals, and persistent session history.
- Client rates in USD, project/task lists, search, date/status/group reports,
  billable totals, and explicitly labeled whole-workspace CSV export.
- Local JSON backups/import, atomic validated storage, a system tray,
  single-instance behavior, and lock/suspend handling for automatic tracking.

Calendar work hours count approved intervals once, excluding overlap. Reports
sum entry durations and use current client rates. Manual sessions create entries
only if automatic collection was off throughout the session, preventing duplicate
time. Breaks remain in session history but do not become work entries.

Closing the window hides it to the tray; choose **Quit Rize Local** to exit.
Running timers checkpoint to disk as paused with their actual completed intervals.
After a restart, explicitly resume; time while the app was closed is not counted.

## Data and scope

Data is saved in `workspace.json` under Electron's per-user **Rize Local** app-data
directory. Export backups in Settings before moving or replacing data. Import
validates the workspace and asks for replacement confirmation; imported tracking
is disabled.

No account, subscription, API key, or server is needed. The application does not
configure analytics, outgoing cloud calls, or synchronization. Window metadata
is allowlisted and sanitized; screenshots, keystrokes, executable paths, and URLs
are not collected. Recognizable private-window titles are redacted; app rules can
exclude additional sensitive windows.

Rize's cloud AI, semantic agent, team sync, integrations, accounts, invoices, music
service, commercial licensing, and automatic updates are not implemented. Local
suggestions use rules and keywords. This recreation is not affiliated with Rize
and contains no proprietary Rize application bundle.

## Validation

The production renderer build and all 61 automated accounting, storage,
native-contract, renderer, and DOM/store integration tests pass in the build
environment. See `docs/RECONSTRUCTION.md` for
provenance and precise verification limits. Windows execution, tray/native
collection, and visual fidelity have not been verified on a live Windows device.
The CI workflow builds a package; it does not simulate a user's foreground activity.

Dependencies are pinned by `package-lock.json`. Source assets and dependency
licenses are listed in `THIRD-PARTY-NOTICES.md`.
