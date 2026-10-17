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


test('advanced calendar split and contiguous merge preserve milliseconds and original duration',async()=>{
 const now=+new Date(2026,9,17,12),store=createStore({now:()=>now});store.mutate({type:'workspace.create',payload:{displayName:'Test'}});
 const start=new Date(2026,9,17,10,0,5,123).toISOString(),end=new Date(2026,9,17,10,0,10,456).toISOString();
 store.mutate({type:'entry.upsert',payload:{id:'precision',start,end,description:'Precision work',status:'approved',source:'manual',category:'productive'}});
 const app=await mount(store,now);
 try{
  await click(app.container.querySelector('.cal-entry'));
  await click(button(app.container,'Split entry'));
  assert.equal(app.container.querySelector('input[type="datetime-local"]').getAttribute('step'),'0.001');
  await submit(app.container.querySelector('.cal-entry-modal form'));
  assert.equal(store.getState().entries.length,2);
  assert.equal(store.getState().entries.reduce((n,e)=>n+e.durationMs,0),5333);
  await click(button(app.container,'Select entries'));
  await click(button(app.container,'Select visible period'));
  assert.match(app.container.querySelector('.cal-bulk-bar strong').textContent,/2 selected/);
  await click(button(app.container,'Merge contiguous'));
  assert.equal(store.getState().entries.length,1);assert.equal(store.getState().entries[0].start,start);assert.equal(store.getState().entries[0].end,end);assert.equal(store.getState().entries[0].durationMs,5333);
 }finally{await app.cleanup();}
});
test('bulk edit dispatch changes chosen field only and rejects incompatible merges visibly',async()=>{
 const now=+new Date(2026,9,17,12),store=createStore({now:()=>now});store.mutate({type:'workspace.create',payload:{displayName:'Test'}});
 for(const [id,hour]of [['a',9],['b',11]])store.mutate({type:'entry.upsert',payload:{id,start:new Date(2026,9,17,hour).toISOString(),end:new Date(2026,9,17,hour,30).toISOString(),description:id,status:'approved',source:'manual',category:'productive'}});
 const before=store.getState().entries.map(e=>({id:e.id,start:e.start,end:e.end,description:e.description}));
 const app=await mount(store,now);
 try{
  await click(button(app.container,'Select entries'));await click(button(app.container,'Select visible period'));await click(button(app.container,'Merge contiguous'));
  assert.ok(app.container.querySelector('[role="alert"]'));assert.equal(store.getState().entries.length,2);
  await click(button(app.container,'Edit selected'));
  const select=[...app.container.querySelectorAll('.cal-entry-modal select')].find(el=>el.parentElement.textContent.startsWith('Category'));
  for(const option of select.options)option.selected=option.value==='neutral';
  await act(async()=>select.dispatchEvent(new window.Event('change',{bubbles:true})));
  await submit(app.container.querySelector('.cal-entry-modal form'));
  assert.equal(app.container.querySelector('.cal-entry-modal'),null);
  assert.ok(store.getState().entries.every(e=>e.category==='neutral'));
  assert.deepEqual(store.getState().entries.map(e=>({id:e.id,start:e.start,end:e.end,description:e.description})),before);
 }finally{await app.cleanup();}
});
test('local-rule reapplication adds matching labels and an ordinary edit preserves them',async()=>{
 const now=+new Date(2026,9,17,12),store=createStore({now:()=>now});store.mutate({type:'workspace.create',payload:{displayName:'Test'}});
 store.mutate({type:'label.upsert',payload:{id:'label-docs',name:'Writing',color:'#7660bd',keywords:['draft']}});
 store.mutate({type:'rule.upsert',payload:{id:'rule-docs',name:'Writing work',keyword:'draft',action:'productive'}});
 store.mutate({type:'entry.upsert',payload:{id:'draft',start:new Date(2026,9,17,9).toISOString(),end:new Date(2026,9,17,9,30).toISOString(),description:'Draft a project brief',status:'pending',source:'manual',category:'neutral'}});
 const app=await mount(store,now);
 try{
  await click(app.container.querySelector('.cal-inbox-item'));
  await click(button(app.container,'Reapply local rules'));
  const entry=store.getState().entries[0];assert.equal(entry.category,'productive');assert.deepEqual(entry.labelIds,['label-docs']);
  assert.match(app.container.querySelector('.cal-inbox dl').textContent,/Writing/);
  await click(button(app.container,'Edit time entry'));
  assert.equal(app.container.querySelector('.cal-label-field input[type="checkbox"]').checked,true);
  await submit(app.container.querySelector('.cal-entry-modal form'));
  assert.deepEqual(store.getState().entries[0].labelIds,['label-docs']);
 }finally{await app.cleanup();}
});
