'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {normalizePreferences,allowedInterval,assertAllowed,preferredStart,timeWarning}=require('../../lib/program-booking-preferences');
const {bookingRequest}=require('../../lib/program-booking');
test('preferences are canonical, bounded and receipt-bound; omitted and inactive defaults retain the legacy request hash',()=>{
  const body={request_key:'owned-preferences-0001',snapshot_sha256:'a'.repeat(64),sessions:[{key:'s0',start_at:'2030-01-07T09:00:00Z'}]};
  const legacy=bookingRequest(body);
  assert.deepEqual(bookingRequest({...body,booking_preferences:{exclude_weekdays:[],keep_professional:false}}),legacy);
  const one=bookingRequest({...body,booking_preferences:{exclude_weekdays:[5,0],prefer_after_minutes:960,keep_professional:true}});
  const two=bookingRequest({...body,booking_preferences:{keep_professional:true,prefer_after_minutes:960,exclude_weekdays:[0,5]}});
  assert.equal(one.request_sha256,two.request_sha256);assert.notEqual(one.request_sha256,legacy.request_sha256);
  assert.deepEqual(one.booking_preferences,{exclude_weekdays:[0,5],prefer_after_minutes:960,keep_professional:true});
  for(const value of [{exclude_weekdays:[7]},{exclude_weekdays:[5,5]},{exclude_weekdays:['5']},{prefer_after_minutes:1440},{keep_professional:'yes'},{force:true},[]])
    assert.throws(()=>normalizePreferences(value),{code:'program_booking_preferences_invalid'});
});
test('preferred start range is strict, canonical and receipt-bound without changing legacy after-only hashes',()=>{
  const body={request_key:'owned-range-0001',snapshot_sha256:'a'.repeat(64),sessions:[{key:'s0',start_at:'2030-01-07T09:00:00Z'}]};
  const afterOnly=bookingRequest({...body,booking_preferences:{prefer_after_minutes:960}});
  assert.deepEqual(afterOnly.booking_preferences,{prefer_after_minutes:960});
  const one=bookingRequest({...body,booking_preferences:{prefer_before_minutes:1080,exclude_weekdays:[5,1],prefer_after_minutes:960}});
  const reordered=bookingRequest({...body,booking_preferences:{exclude_weekdays:[1,5],prefer_after_minutes:960,prefer_before_minutes:1080}});
  assert.deepEqual(one,reordered);
  assert.notEqual(one.request_sha256,afterOnly.request_sha256);
  assert.notEqual(one.request_sha256,bookingRequest({...body,booking_preferences:{prefer_after_minutes:960,prefer_before_minutes:1081,exclude_weekdays:[1,5]}}).request_sha256);
  assert.deepEqual(normalizePreferences({prefer_after_minutes:0,prefer_before_minutes:1439}),{prefer_after_minutes:0,prefer_before_minutes:1439});
  for(const value of [
    {prefer_before_minutes:1080},
    {prefer_after_minutes:960,prefer_before_minutes:960},
    {prefer_after_minutes:1080,prefer_before_minutes:960},
    {prefer_after_minutes:0,prefer_before_minutes:1440},
    {prefer_after_minutes:-1,prefer_before_minutes:30},
    {prefer_after_minutes:960,prefer_before_minutes:-1},
    {prefer_after_minutes:960,prefer_before_minutes:1080.5},
    {prefer_after_minutes:960,prefer_before_minutes:'1080'},
    {prefer_after_minutes:960,prefer_before_minutes:NaN},
    {prefer_after_minutes:960,prefer_before_minutes:Infinity},
  ]) assert.throws(()=>normalizePreferences(value),{code:'program_booking_preferences_invalid'});
});
test('time preferences use inclusive clinic-local starts, not UTC, duration or the server timezone',()=>{
  const range={prefer_after_minutes:960,prefer_before_minutes:1080};
  for(const start of ['2030-01-07T15:00Z','2030-01-07T16:30Z','2030-01-07T17:00Z']) {
    assert.equal(preferredStart(range,start,'Europe/Madrid'),true);
    assert.deepEqual(timeWarning(range,{start_at:start,end_at:'2030-01-07T19:00Z'},'Europe/Madrid'),[]);
  }
  for(const start of ['2030-01-07T14:59Z','2030-01-07T17:01Z']) {
    assert.equal(preferredStart(range,start,'Europe/Madrid'),false);
    assert.equal(timeWarning(range,{start_at:start},'Europe/Madrid')[0].code,'program_preference_time_fallback');
  }
  assert.equal(preferredStart(range,'2030-01-07T15:00Z','UTC'),false);
  assert.equal(preferredStart(range,'2030-06-07T14:00Z','Europe/Madrid'),true);
  const fullDay={prefer_after_minutes:0,prefer_before_minutes:1439};
  assert.equal(preferredStart(fullDay,'2030-01-06T23:00Z','Europe/Madrid'),true);
  assert.equal(preferredStart(fullDay,'2030-01-07T22:59Z','Europe/Madrid'),true);
  assert.equal(preferredStart({prefer_after_minutes:960},'2030-01-07T22:59Z','Europe/Madrid'),true);
});
test('DST overlaps and spring transitions use their clinic wall-clock minute for preference ranking only',()=>{
  const morning={prefer_after_minutes:120,prefer_before_minutes:180};
  // Both occurrences of 02:30 are in range; scheduling still rejects ambiguous
  // user inputs separately. This helper never resolves/authorizes a local time.
  for(const start of ['2030-10-27T00:30Z','2030-10-27T01:30Z','2030-03-31T01:00Z'])
    assert.equal(preferredStart(morning,start,'Europe/Madrid'),true);
  assert.equal(preferredStart(morning,'2030-03-31T00:59Z','Europe/Madrid'),false);
  assert.equal(preferredStart(morning,'2030-03-31T01:01Z','Europe/Madrid'),false);
});
test('excluded weekdays use clinic civil dates, not UTC/server dates, including a visit crossing midnight',()=>{
  const preferences={exclude_weekdays:[5]};
  assert.equal(allowedInterval(preferences,'2030-01-03T12:30Z','2030-01-03T13:30Z','Pacific/Kiritimati'),false);
  assert.equal(allowedInterval(preferences,'2030-01-03T12:30Z','2030-01-03T13:30Z','UTC'),true);
  assert.equal(allowedInterval(preferences,'2030-01-03T22:50Z','2030-01-03T23:20Z','Europe/Madrid'),false);
  assert.equal(allowedInterval(preferences,'2030-01-03T22:30Z','2030-01-03T23:00Z','Europe/Madrid'),true);
  assert.throws(()=>assertAllowed(preferences,[{key:'s0',start_at:'2030-01-03T23:30Z',end_at:'2030-01-04T00:00Z'}],'Europe/Madrid'),{code:'program_booking_preference_conflict'});
});
