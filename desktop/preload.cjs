'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, value) => ipcRenderer.invoke(channel, value);
const subscribe = (channel, callback) => {
  if (typeof callback !== 'function') throw new TypeError('An event callback is required.');
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('rize', Object.freeze({
  getState: () => invoke('rize:get-state'),
  getStatus: () => invoke('rize:get-status'),
  mutate: command => invoke('rize:mutate', command),
  onState: callback => subscribe('rize:state', callback),
  onStatus: callback => subscribe('rize:status', callback),
  windowAction: action => invoke('rize:window', action),
  exportData: format => invoke('rize:export', format),
  importData: () => invoke('rize:import'),
  cloud: (action, payload = {}) => invoke('rize:cloud', { action, payload }),
  businessReport: query => invoke('rize:business-report', query),
  invoicePdf: payload => invoke('rize:invoice-pdf', payload),
  updates: action => invoke('rize:updates', action),
}));
