#!/usr/bin/env node
'use strict';
// Runs alongside the passive importer; never replays pre-activation/history events.
require('../lib/whatsappBrokerClient').assertStaging(process.env);
require('../services/socket.service').enableBackgroundPublishing();
const { tick } = require('../services/whatsappFreshInbound.service');
const { tick: realtime } = require('../services/whatsappFreshRealtime.service');
const log = value => process.stdout.write(JSON.stringify(value)+'\n');
console.log = console.warn = console.error = () => {}; // No patient text in this operational service's journal.
let stopping = false;
process.once('SIGINT', () => { stopping=true; });process.once('SIGTERM', () => { stopping=true; });
(async()=>{
  while (!stopping) {
    try { const result=await realtime();if(result.notified)log({event:'fresh_realtime_published',...result}); }
    catch { log({event:'fresh_realtime_retry'}); }
    try { const result=await tick();if(result.dispatched)log({event:'fresh_inbound_dispatched',...result}); }
    catch { log({event:'fresh_inbound_retry'}); }
    if (!stopping) await new Promise(resolve=>setTimeout(resolve,5000));
  }
  process.exit(0);
})().catch(()=>{log({event:'fresh_inbound_stopped'});process.exit(1);});
