# Extension implementation contract

Goal: implement the previously omitted feature families with working code, tests,
and honest setup requirements. Do not claim live vendor/cloud parity without configured
providers. Existing source on main has 61 passing tests; preserve those behaviors.

Root owns src/App.jsx, desktop/main.cjs, desktop/preload.cjs,
desktop/cloud-client.cjs, package manifests, CI/build configuration and final docs.
Other agents own only assigned files and coordinate through root.

## Local domain additions (business agent owns store + business module)

Keep schemaVersion1 with backwards-compatible optional business field. Business:
`{profile:{name,address,email,paymentInstructions,invoicePrefix},clientTerms:[],contracts:[],
invoices:[],allocations:[],labels:[],nextInvoiceNumber:1}`. All defaults populated when old snapshots omit it.
clientTerms item `{id,clientId,contact,email,address,currency,paymentDays}`.
Contract `{id,clientId,projectId,type:'hourly'|'retainer'|'hybrid',hourlyRate,retainerMinor,
includedHours,budgetHours,costRate,startDate,endDate,currency}`. Rates decimal currency units;
money totals integer minor units with currency fraction digits. No FX conversions.
Allocation `{id,memberId,memberName,projectId,week:'YYYY-MM-DD',hours,capacityHours}`.
Labels `{id,name,color,keywords}`. Entry can have optional labelIds and external source IDs.

Commands: business.profile.update; business.clientTerms.upsert; contract.upsert/delete;
allocation.upsert/delete; label.upsert/delete; invoice.create({clientId,startDate,endDate,
currency,taxBps,discountMinor,paymentDays,notes}); invoice.update({id,...draftFields});
invoice.markSent({id}); invoice.payment({id,amountMinor,date,reference}); invoice.void({id,reason}).
Invoice snapshot includes id,number,clientId,clientName,billTo,issuer,currency,currencyDigits,
issueDate,dueDate,status(draft|sent|paid|void),lines[{id,entryId,description,quantityHours,
rate,amountMinor}],subtotalMinor,taxBps,taxMinor,discountMinor,totalMinor,payments,
paidMinor,outstandingMinor,notes,paymentInstructions. Immutable after sent; void preservesnumber.
Avoid double-invoicing same approved billable entries across active invoices.
Advanced entry commands entry.split({id,at}), entry.merge({ids}), entry.bulk({ids,patch}),
entry.regenerate({id}) uses local rules (must label as rules, AI actions use server separately).
Exports business.cjs: financialSummary(state,{startDate,endDate}), invoiceHtml(invoice),
validateBusiness(value,state), defaultBusiness(), applyBusinessCommand(state,command,now).
Store adds mergeShared(records) for remote imported clients/projects/tasks/entries,
preserving local timer/settings/pending activity and all unrelated records. Remote deletions
must only remove previously synchronized IDs, never erase unrelated local data.

## Cloud server (auth/server agent)

Node HTTP + node:sqlite (Node>=22.13), defaults127.0.0.1:4791. Exports
`createService({dbPath,env?,fetchImpl?,now?}) -> {server,listen(port?,host?),close(),...}`.
Root npm script runs server/index.cjs. No paid/external calls in tests.

Routes return JSON, errors `{error,code}`. Password scrypt, opaque hashed sessions,
rate limits, bounded bodies, explicit CORS. Bearer session token held by desktop main,
not returned to renderer. Registration `{email,password,name}`, login `{email,password}`
return `{token,user}`. Auth endpoints POST /v1/auth/register|login|logout; GET /v1/me.
GET/POST /v1/teams; POST /v1/teams/join `{code}`; GET /v1/teams/:id/members;
POST /v1/teams/:id/invites `{email,role}` returns single-use code (no implicit email send);
PATCH /v1/teams/:id/members/:userId `{role,finance,resourcing}`. Roles owner/admin/member/viewer.
Prevent self/escalation/last-owner loss. Records owner-bound, finance access scoped.

GET /v1/teams/:id/sync?since=N returns `{cursor,records:[{kind,id,data,version,ownerId,deleted}]}`.
POST same with `{changes:[{kind,id,data,baseVersion,deleted}]}` returns `{cursor,records,conflicts}`.
Kinds clients/projects/tasks/entries/contracts/allocations/invoices/skills/routines/reports/context.
Entries: shared approved time descriptions and tags ONLY; reject raw app/title metadata.
Members can change their own entries; roles gate other kinds. Version conflicts do not overwrite.
GET /v1/teams/:id/analytics returns aggregate timesheet/utilization, no raw windows/titles.

Provider agent owns server/services.cjs and server/providers.cjs. Server delegates
`/v1/teams/:id/services/*` to `handleServices(ctx)`, returns true if handled. ctx:
`{req,res,body,url,user,teamId,member,env,fetchImpl,now,send(status,data),
fail(status,message,code?),authorize(action),getRecords(kind),putRecord(kind,id,data,baseVersion?),
deleteRecord(kind,id,baseVersion?),kvGet(namespace,key),kvPut(namespace,key,value)}`.
authorize actions read/write/finance/resourcing/admin; functions enforce team isolation.
Records returned objects include data/version/id/ownerId. Provider agent messages backend on needs.

Provider endpoints (under services/): GET status; POST ai/chat `{message,skillId?,consent:true}`;
POST ai/tag `{entryIds,consent:true}`; POST ai/report `{prompt,consent:true}`;
GET/POST ai/skills, ai/routines; DELETE ai/skills/:id, ai/routines/:id;
GET integrations; POST integrations/:provider/connect `{token,...options}`;
POST integrations/:provider/sync; DELETE integrations/:provider;
POST calendar/import `{ics}`; POST webhooks/register `{url,secret}` (optional if safe).
Providers Linear/ClickUp/Asana token API and ICS calendar import; Google/Microsoft OAuth
implemented only with proper state/PKCE/server credentials and exact callback docs.
Credentials only in encrypted server KV, never renderer returns. Fail clearly when unconfigured.
AI env RIZE_AI_BASE_URL, RIZE_AI_API_KEY, RIZE_AI_MODEL; optional RIZE_EMBEDDING_MODEL.
Remote requests HTTPS with bounded responses/timeouts, no raw window data sent.
RIZE_SECRET_KEY is base64 32-byte AES-GCM key, required before saving provider secrets.
No keyword fallback falsely labeled as semantic AI. AI returns proposals requiring user approval.

## Desktop cloud bridge (root)

`window.rize.cloud({action,payload})` returns envelope `{cloud,result,workspace?}`.
Root App passes `cloudRequest(action,payload)` to pages; it unwraps result and updates
cloud/workspace when returned. `cloud` shape `{serverUrl,authenticated,user,teams,teamId,
lastSyncAt,conflicts,configured}`. Native side safely stores token encrypted using Electron
safeStorage; require secure storage for persistent credentials. HTTPS serverURL except loopback.
Actions configure({serverUrl}),status,register,login,logout,teams,team.create({name}),
team.select({teamId}),team.join({code}),team.members,team.invite,team.member.update,
sync (explicit approved-entry consent),analytics, and provider actions names:
services.status,ai.chat,ai.tag,ai.report,ai.skills.list/save/delete,ai.routines.list/save/delete,
integrations.list/connect/sync/disconnect,calendar.import. Prefix all team API requests with active team.
All mutating cloud actions require user account/team; no background sync before opt-in.

Root other IPC: invoicePdf({id}) native export; businessReport(query) returns financialSummary;
updates({action:'status'|'check'|'download'|'install'}) for installed NSIS builds.
Music is real local Web Audio noise/tones and user audio files; no unlicensed music service claim.

## UI contracts

BusinessPages.jsx named InvoicesPage,ProfitabilityPage,ResourcingPage,TimesheetsPage:
`{state,mutate,cloud,cloudRequest}`. CloudPages.jsx named CloudPage,AgentPage,IntegrationsPage:
same props. Real forms/errors, credentials fields clear after submission, stateful results
only from native/server. No fake connected status or demo team members.
MusicPlayer.jsx default MusicPage; CalendarPage props unchanged (state,mutate,now).

## Publishing

New dependency installs and package edits belong root. Send requested packages first.
No agents change README or package config or push. Root verifies tests/build/server flows,
publishes source to existing public GitHub repo, and documents setup gates. Never commit
credentials, databases, generated PDFs, music files, test fixtures, or downloaded runtimes.
