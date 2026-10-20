'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {normalizePreferences,allowedInterval,assertAllowed}=require('../../lib/program-booking-preferences');
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
test('excluded weekdays use clinic civil dates, not UTC/server dates, including a visit crossing midnight',()=>{
  const preferences={exclude_weekdays:[5]};
  assert.equal(allowedInterval(preferences,'2030-01-03T12:30Z','2030-01-03T13:30Z','Pacific/Kiritimati'),false);
  assert.equal(allowedInterval(preferences,'2030-01-03T12:30Z','2030-01-03T13:30Z','UTC'),true);
  assert.equal(allowedInterval(preferences,'2030-01-03T22:50Z','2030-01-03T23:20Z','Europe/Madrid'),false);
  assert.equal(allowedInterval(preferences,'2030-01-03T22:30Z','2030-01-03T23:00Z','Europe/Madrid'),true);
  assert.throws(()=>assertAllowed(preferences,[{key:'s0',start_at:'2030-01-03T23:30Z',end_at:'2030-01-04T00:00Z'}],'Europe/Madrid'),{code:'program_booking_preference_conflict'});
});
