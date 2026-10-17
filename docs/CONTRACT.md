# Original reconstruction contract (historical)

This document records the initial local-only schema and bridge. The current source
adds business, cloud, provider, audio, and updater features described in
[EXTENSION-CONTRACT.md](EXTENSION-CONTRACT.md) and [FEATURES.md](FEATURES.md).
Use the current source and tests for exact API behavior; the list below is not the
complete present-day state or command surface.

This is a reconstructed Windows desktop app, based on retained notes from the
previous build. It is not the original lost source and not Rize's proprietary code.

Renderer: React + Vite, ESM. Desktop: Electron CommonJS modules.

State: `{schemaVersion:1,onboarded,demo,settings,entries,clients,projects,tasks,rules,sessions,timer}`.
Settings: `{displayName,trackingEnabled,idleSeconds,scheduleEnabled,scheduleStart,scheduleEnd,workDays}`.
Entry: `{id,start,end,description,app,title,status,source,category,clientId,projectId,taskId,billable,durationMs}`.
Entity links use empty string for none. `status` is pending or approved. Duration is
always derived from ISO start/end. Client has name and hourlyRate. Project has name,
clientId,keywords. Task has name,projectId,clientId,keywords. Rule has name,keyword,
action(productive|neutral|distracting|exclude),clientId,projectId,taskId.
Timer: null or `{id,kind,goal,targetMs,status,startedAt,resumedAt,elapsedMs,segments,clientId,projectId,taskId}`.
Segments are actual running `{start,end}` intervals; paused time never becomes entries.
Session has these metadata plus endedAt, elapsedMs and final segments.

`createStore({file,now?})` returns `{getState(),mutate({type,payload}),upsertActivity(entries),flush()}`.
All mutation calls are synchronous; return the resulting defensive state copy.
Commands: workspace.create({displayName}), workspace.demo({}), settings.update(partial),
entry.upsert(entry), entry.delete({id}), entry.review({id,status}),
client/project/task/rule.upsert(entity), client/project/task/rule.delete({id}),
timer.start({kind,goal,targetMs,clientId,projectId,taskId}), timer.pause({}),
timer.resume({}), timer.stop({}), timer.extend({minutes}), timer.update(metadata).

`createTrackingEngine({now?})` returns `{consume(sample,state),flush(timestamp,state),reset()}`.
Both consume/flush return entry upserts array. Sample is `{timestamp,app,title,pid,idleSeconds,available}`.
Native sampler exports `createSampler({onSample,onError,powerMonitor,...injections})` with start/stop.

`window.rize`: getState(),getStatus(),mutate(command),onState(callback),onStatus(callback),
windowAction(minimize|maximize|close),exportData(json|csv),importData(). Events return unsubscribe.
Status `{platform,tracking:{enabled,available,state,message},maximized}`.

UI component contracts:
TimerPage default `{state,mutate,now}`; WorkPage named `{kind,state,mutate}` with kind
clients/projects/tasks; ReportsPage `{state}`; SettingsPage `{state,mutate,status}`.
Native-only controls call window.rize when available and provide browser feedback.

All errors are thrown at bridge/store and shown by root or local form. No silent failures.
Root handles calendar, shell UI, styles, build package.json and README. Other agents
must edit only their assigned files, and read this contract before implementation.
