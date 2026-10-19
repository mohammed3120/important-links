// Manifest V3 service worker. It can be suspended at any time, so it keeps no state that matters:
// sync progress and settings live in chrome.storage, and alarms wake it up again.
import { handleMessage, onAlarm, ensureAlarms } from './messages.js';

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || typeof msg?.type !== 'string' || !msg.type.startsWith('sync:')) return false;
  handleMessage(msg).then(sendResponse);
  return true; // keep the channel open for the async response
});

chrome.alarms.onAlarm.addListener((alarm) => { onAlarm(alarm.name); });
chrome.runtime.onInstalled.addListener(ensureAlarms);
chrome.runtime.onStartup.addListener(ensureAlarms);
ensureAlarms();
