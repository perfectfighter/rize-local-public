# Reconstruction provenance and verification

The previous implementation and portable ZIP were removed by automated workspace
cleanup before the source was pushed to GitHub. Its persistent upload had failed.
This project was rebuilt from the retained implementation notes; it is not a
byte-for-byte recovery. Claims about the previous build's 59-test result do not
apply to this source. This project's own tests and build must pass independently.

The retained research records report static REA inspection of official Rize
Windows 3.0.45 using `morluto/rea` / `rea-agents`. They identified Electron
packaging, the Windows foreground/idle workflow, sessions, the remote dashboard,
and Lato/theme tokens. The original research files and installer no longer exist
in this workspace, so this rebuild does not claim a new REA execution. No original
installer or proprietary compiled JavaScript is redistributed.

The retained visual references described Calendar, time-entry review, Home and
Timer screenshots from Rize's documentation. Theme values applied here include
background #121117, surface #1c1b23, input #2b2a30, border #3d3b46, text #d0d0d0,
cyan #00edff and purple #7660bd. Locally bundled Lato comes from Fontsource, and
standard icons come from React Feather. The unchanged public favicon was recovered
separately; its exact URL and checksum are in native-asset.txt.

References for future review:

- https://github.com/morluto/rea
- https://docs.rize.io/automatic-tracking/time-entry-inbox
- https://docs.rize.io/automatic-tracking/manually-adding-time
- https://docs.rize.io/sessions/sessions-timer
- https://github.com/paymo-org/node-active-window

## Validation boundaries

The initial rebuilt source passed its renderer build and initial test suite before
publication. The later feature expansion adds companion-service accounts and
permissions, synchronization/conflicts, financial commands and invoices, provider
adapters/OAuth/calendar handling, generated/local audio, MCP, and installed-update
state/trust checks. Run `npm test` and `npm run build` on the current revision; an
earlier test count is not a certification of newer source.

Node tests exercise actual store transactions, time accounting, native sampler
contracts with injected native calls, calendar math, and rendered states. Cloud
tests run an isolated SQLite-backed HTTP service and exercise authentication,
role/tenant isolation, approved-entry privacy, synchronization versions, and team
analytics. Provider tests inject synthetic vendor responses; they do not incur
external API charges or establish a real provider connection. Vite builds the
production renderer; native foreground helpers are not loaded in unit tests.

Integration tests drive production React DOM input, submit and click events
through Linkedom, including real store transactions and filesystem failures.
They cover exact short-entry approval, draft retention/retry, month navigation,
business forms/payments, calendar/AI actions and native-bridge contracts. These
simulate a DOM; they do not validate browser layout or Windows execution.

No live hosted server, vendor account, OAuth approval, signing identity, or public
update feed is created by automated tests. Signed installed-update behavior needs
a real certificate, correctly configured trusted publisher, and published release
artifacts. Generating an NSIS installer is not equivalent to signing or validating
an installed update on Windows.

The Browser plugin's JavaScript surface was not exposed in this environment.
Earlier preview/native verification was blocked, and no alternative browser path
or security bypass was used. DOM simulations, where recorded, are not evidence of
browser layout, console health, Windows launch, tray behavior, or visual fidelity.
No visual-match acceptance is claimed. The Windows runtime was not executed here.

Before wider use, launch the portable build on Windows x64, create a real workspace,
opt into tracking, change foreground apps, cross the idle boundary, lock/resume,
review entries, pause/resume/stop a timer, restart, export/import a backup, and
check tray behavior. Compare Calendar/Review/Timer at matching viewport and DPI.
