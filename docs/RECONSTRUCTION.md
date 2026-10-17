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

Final production build passed. All 61 automated tests passed in this workspace.

Node tests exercise actual store transactions, time accounting, native sampler
contracts with injected native calls, calendar math, and rendered Timer states.
Vite builds the production renderer. Native helpers are not loaded during tests.

Three integration tests drive genuine production React DOM input, submit, and
click events through Linkedom and the real store. They verify exact 5.333-second
entry approval, a real filesystem save failure that retains a manual draft and
then succeeds on retry, and January 31 month navigation clamping to February 28.
They simulate a DOM, not a browser or the Windows runtime.

The Browser plugin's JavaScript surface was not exposed in this environment.
Earlier preview/native verification was blocked, and no alternative browser path
or security bypass was used. DOM simulations, where recorded, are not evidence of
browser layout, console health, Windows launch, tray behavior, or visual fidelity.
No visual-match acceptance is claimed. The Windows runtime was not executed here.

Before wider use, launch the portable build on Windows x64, create a real workspace,
opt into tracking, change foreground apps, cross the idle boundary, lock/resume,
review entries, pause/resume/stop a timer, restart, export/import a backup, and
check tray behavior. Compare Calendar/Review/Timer at matching viewport and DPI.
