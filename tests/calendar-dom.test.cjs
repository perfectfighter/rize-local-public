const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {parseHTML} = require('linkedom');
const esbuild = require('esbuild');
const {window} = parseHTML('<!doctype html><html><body></body></html>');

// Linkedom supplies a DOM, not browser layout or native Windows behavior.
// Advertise its input event support before React performs feature detection.
window.document.oninput = null;
for (const name of ['window','document','HTMLElement','HTMLInputElement','HTMLTextAreaElement','HTMLSelectElement','Event','MouseEvent','Node']) {
  if (window[name]) Object.defineProperty(globalThis,name,{value:window[name],configurable:true,writable:true});
}
Object.defineProperty(globalThis,'navigator',{value:{userAgent:'Linkedom integration test'},configurable:true});
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = require('react');
const {act} = React;
const {createRoot} = require('react-dom/client');
const {createStore} = require('../desktop/store.cjs');
const compiled = esbuild.buildSync({
  entryPoints:[path.join(__dirname,'../src/CalendarPage.jsx')],bundle:true,write:false,
  format:'cjs',platform:'node',external:['react','react-dom','react-feather'],loader:{'.css':'empty'},
});
const calendarModule = {exports:{}};
new Function('require','module','exports',compiled.outputFiles[0].text)(require,calendarModule,calendarModule.exports);
const CalendarPage = calendarModule.exports.default;

function button(container,text) {
  const found=[...container.querySelectorAll('button')].find(el=>el.textContent.trim()===text);
  assert.ok(found,`Expected button: ${text}`);
  return found;
}
async function click(element) { await act(async()=>element.dispatchEvent(new window.Event('click',{bubbles:true}))); }
async function submit(form) { await act(async()=>form.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}))); }
async function input(element,value) {
  const prototype=Object.getPrototypeOf(element);
  const descriptor=Object.getOwnPropertyDescriptor(prototype,'value');
  assert.equal(typeof descriptor?.set,'function','DOM control must expose its native value setter');
  descriptor.set.call(element,value);
  await act(async()=>element.dispatchEvent(new window.Event('input',{bubbles:true})));
}
async function mount(store,now) {
  const container=document.createElement('div');document.body.appendChild(container);
  const root=createRoot(container);
  const render=()=>root.render(React.createElement(CalendarPage,{state:store.getState(),now,mutate:command=>{const state=store.mutate(command);render();return state;}}));
  await act(async()=>render());
  return {container,cleanup:async()=>{await act(async()=>root.unmount());container.remove();}};
}

test('calendar approves a short pending record without rounding its original timestamps',async()=>{
  const now=+new Date(2026,9,17,12),store=createStore({now:()=>now});
  store.mutate({type:'workspace.create',payload:{displayName:'Test'}});
  const start=new Date(2026,9,17,10,0,5,123).toISOString(),end=new Date(2026,9,17,10,0,10,456).toISOString();
  store.mutate({type:'entry.upsert',payload:{id:'short',start,end,description:'Short review',status:'pending',source:'automatic'}});
  const app=await mount(store,now);
  try {
    await click(app.container.querySelector('.cal-inbox-item'));
    await click(button(app.container,'Approve'));
    const saved=store.getState().entries[0];
    assert.equal(saved.status,'approved');assert.equal(saved.start,start);assert.equal(saved.end,end);assert.equal(saved.durationMs,5333);
    assert.equal(app.container.querySelector('.cal-status').textContent,'Approved');
  } finally {await app.cleanup();}
});

test('a failed manual save keeps the entered draft and succeeds when storage is restored',async()=>{
  const temp=fs.mkdtempSync(path.join(process.cwd(),'.calendar-dom-'));
  const data=path.join(temp,'data'),backup=path.join(temp,'saved-data');
  const now=+new Date(2026,9,17,12),store=createStore({file:path.join(data,'workspace.json'),now:()=>now});
  store.mutate({type:'workspace.create',payload:{displayName:'Test'}});
  const app=await mount(store,now);
  try {
    await click(button(app.container,'Add entry'));
    await input(app.container.querySelector('textarea'),'Draft survives an interrupted save');
    fs.renameSync(data,backup);fs.writeFileSync(data,'Directory temporarily unavailable');
    await submit(app.container.querySelector('.cal-entry-modal form'));
    assert.ok(app.container.querySelector('[role="alert"]'),'Save failure must be visible');
    assert.equal(app.container.querySelector('textarea').value,'Draft survives an interrupted save');
    assert.equal(store.getState().entries.length,0,'Failed write must not commit state');
    fs.unlinkSync(data);fs.renameSync(backup,data);
    await submit(app.container.querySelector('.cal-entry-modal form'));
    assert.equal(app.container.querySelector('.cal-entry-modal'),null);
    const entries=store.getState().entries;
    assert.equal(entries.length,1);assert.equal(entries[0].description,'Draft survives an interrupted save');
    assert.equal(entries[0].durationMs,30*60000);assert.equal(entries[0].status,'approved');
  } finally {await app.cleanup();fs.rmSync(temp,{recursive:true,force:true});}
});

test('month navigation from January 31 clamps the selected day to February 28',async()=>{
  const now=+new Date(2025,0,31,12),store=createStore({now:()=>now});
  const app=await mount(store,now);
  try {
    await click(button(app.container,'Month'));
    await click(app.container.querySelector('[aria-label="Next period"]'));
    await click(button(app.container,'Day'));
    const actual=app.container.querySelector('.cal-date-controls strong').textContent;
    const expected=new Date(2025,1,28).toLocaleDateString([],{weekday:'short',month:'long',day:'numeric',year:'numeric'});
    assert.equal(actual,expected);
    assert.equal(app.container.querySelectorAll('.cal-day-column').length,1);
  } finally {await app.cleanup();}
});
