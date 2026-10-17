# Implemented behavior and scope

This is an independent desktop app plus companion service. “Implemented” means
there is working source and relevant automated coverage; it does not imply a live
provider account, hosted deployment, signing certificate, or verified parity with
Rize's proprietary service.

| Feature | Implemented behavior | Setup / limits |
| --- | --- | --- |
| Automatic activity | Windows x64 foreground metadata, five-second samples, idle/schedule exclusions, lock/suspend handling | Explicit opt-in; sample mode cannot track; live Windows verification required |
| Local privacy | No screenshots/keys/paths/URLs; private-window title redaction and exclusion rules | Review additional sensitive apps yourself; descriptions can contain private text |
| Calendar | Day/week/month, overlaps, exact timestamp edits, manual time, review and tags | Work hours union approved intervals; personal entry totals count each interval |
| Advanced entries | Split, merge, bulk changes, labels, local rule regeneration | Regeneration is local rules, not semantic AI; invalid merges/changes fail visibly |
| Timers | Focus/meeting/break, goals, targets, pause/resume, extensions, history, actual active intervals | Restart restores paused completed time; no closed-app time fabricated |
| Work organization | Clients, projects, tasks, rates, search, tagging rules, labels | Imported work can be tagged using the same IDs |
| Local reports | Date/status/group breakdown and workspace CSV | Whole-workspace CSV is explicitly labeled; CSV formula characters escaped |
| Personal timesheets | Daily project/client hours, approved/pending split, billable totals | Local midnight clipping; overlapping entries count individually |
| Contracts | Hourly, fixed-period retainer, hybrid, cost rates, budgets, currencies | Retainer/hybrid need end date; no recurrence or proration |
| Profitability | Revenue, labor cost, gross profit/margin, budget consumption per currency | Native calculation; no invented estimates when unavailable; no FX conversion |
| Invoices | Approved billable line/rate snapshot, tax/discount, numbering, due date, PDF, sent/paid/void states, partial payments | UTC entry-start selection; fixed-period billing safeguards; send locks snapshot; no tax jurisdiction engine |
| Invoice delivery/payment | PDF download and manual sent/payment recording | No email delivery, payment collection, refunds, or bank reconciliation |
| Resourcing | Weekly allocations, member capacity, availability/overage, CRUD, atomic CSV import | Real current members or local user; conflicting CSV capacities rejected |
| Accounts | Self-hosted registration/login/logout, scrypt passwords, hashed expiring sessions | Service needed; no hosted SSO, MFA, email verification/reset, or account recovery flow |
| Teams | Creation, email-bound invitation codes, join, member roles and resource flags | Invitations are not emailed; last-owner/self-escalation guards enforced |
| Team sync | Approved work plus permitted records, versioned changes/tombstones, explicit conflicts | Sharing consent; automatic sync separately opt-in; pending/raw metadata excluded |
| Team timesheets | Authorized daily aggregates, unioned durations, billable time/utilization | Requires synchronized approved time and an account/team; no invented people |
| AI chat | Configured HTTPS OpenAI-compatible chat using approved shared context | Server provider/model/key, explicit consent, provider charges/retention apply |
| Semantic tagging | Actual embeddings and cosine matching to configured work | Separate embedding model; proposals only; similarity is not confidence probability |
| Reports/skills | Generated saved editable reports and reusable instruction skills | AI provider for generation; no autonomous tool execution |
| Routines | Owner-bound, consented interval reports and persisted outcomes/errors | Enable `RIZE_RUN_ROUTINES=1`; service stays running; intervals ≥15 minutes |
| Linear | Validated personal-token issue/task import | Explicit capped/paginated import; no native time export |
| ClickUp | Validated token task import and consented approved linked time export | List ID; workspace ID for export; vendor permissions/plan apply |
| Asana | Validated token task import and consented approved linked time export | Project ID; time tracking access; partial minutes rejected instead of rounded |
| Provider sync | Deterministic external IDs, explicit import/export, encrypted tokens, duplicate-write journal | No background provider sync or webhooks; uncertain writes need vendor review |
| Calendar files | Google/Outlook `.ics`, dates/zones, recurrence/EXDATE/overrides | Scheduled context and reviewable proposals, not automatic evidence of work; limits documented in PROVIDERS.md |
| Live calendar accounts | Google Calendar/Outlook OAuth, state/PKCE, encrypted refresh tokens, explicit primary-calendar pull | Registered Web applications and exact HTTPS callbacks; read-only; no writeback/push/secondary picker; live consent unverified without credentials |
| Music | Generated white/pink/brown noise, ambient tones, user-selected local audio | User starts playback; no streaming catalog, subscription, licensed service, or productivity claims |
| MCP | Read-only stdio tools for approved time, work search, analytics | Own server/session/team; explicit MCP 2025-11-25 revision; no writes/raw tracker/remote listener |
| Backups | JSON export/import, atomic local writes, validated restoration | Export before replacing data; server backups are a separate operator task |
| Packaging | Portable Windows x64 ZIP with source and NSIS installer | Build artifacts unsigned until configured; desktop foreground tests still manual |
| Updates | Manual check → download → restart/install via electron-updater | Installed signed NSIS build, actual trusted publisher, published installer/blockmap/latest.yml; unsigned/portable disabled |
| Commercial Rize backend | None | No Rize account/backend access, subscription/licensing system, or complete proprietary feature parity |

## Financial and sharing details

Money is stored in integer minor units with the currency's fraction digits; rates
are decimal currency units. Currency totals are never silently mixed. A contract's
retainer is recognized on its start date, included hours are consumed across the
whole fixed period, and later invoices in that period do not bill the fee twice.
Whole-contract budget totals and selected-range financial totals have different
scopes. Report notes describe the relevant scope.

Synchronization preserves local pending/native activity, timer, settings, and
unrelated IDs. Versions prevent silent conflict overwrite. Changing teams does not
authorize moving another team's cached data into the new team. The server enforces
permissions even if a modified client calls its APIs directly.

Local keyword suggestions, embedding proposals, and generated reports are labeled
according to their real mechanism. None provides an unconfigured remote AI service.
