'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { preview, normalize } = require('../../services/patientProgramDraftPreview.service');
const { solveBookingProfile } = require('../../lib/booking-profile-solver');
const { solutionsForCalendar } = require('../../services/appointmentBookingAvailability.service');
const { addVirtualBusy } = require('../../services/patientProgramBooking.service');
const { localInstant, civilLocal } = require('../../lib/program-reschedule');
const now = new Date('2030-01-01T00:00:00Z'), zone = 'Europe/Madrid';
const profile = { version: 1, phases: [{ key: 'care', duration_minutes: 30, installation_ids: [9],
  professionals: { mode: 'any', ids: [5], preferred_id: 5 } }] };
function plan({ external = false, manual = false } = {}) {
  return { timeZone: zone, voucher: { id: 1, clinic_id: 1, patient_id: 1 }, snapshot: { sha256: 'a'.repeat(64), kind: 'program', cadence: null,
    appointments: Array.from({ length: 3 }, (_, i) => ({ offset_days: manual ? null : i * 15 })) },
    sessions: Array.from({ length: 3 }, (_, position) => ({ key: 's' + position, label: 'Sesión ' + (position + 1), position,
      scheduling_status: external && position === 0 ? 'unrecorded' : 'pending', start_at: null, end_at: null,
      duration_minutes: 30, offset_days: manual ? null : position * 15, booking_profile: profile })) };
}
function input(rows, action = 'cascade', extra = {}) {
  return { from_date: '2030-01-07', days: 90, draft_strategy: { action, pivot_key: 's0', sessions: rows, ...extra } };
}
function rows(dates = ['2030-01-07T10:00', '2030-01-22T10:00', '2030-02-06T10:00'], placed = []) {
  return dates.map((local, i) => ({ key: 's' + i, start_at: localInstant(local, zone).toISOString(), placed: placed.includes(i),
    selections: { care: { installation_id: 9, doctor_id: 5 } } }));
}
function fixture(p = plan()) {
  const resource = key => ({ resource_key: key, windows: [{ start: '2030-01-01T00:00:00Z', end: '2031-01-01T00:00:00Z' }], busy: [] });
  const context = { timeZone: zone, doctors: new Map([[5, resource('doctor:5')]]), installations: new Map([[9, resource('installation:9')]]),
    installationKeys: new Map([[9, 'installation:9']]), patientBusy: [] };
  let reads = 0;
  const run = payload => preview({ plan: p, payload, actorId: 1, now, contextFor: async () => { reads++; return context; },
    dto: () => ({ sessions: p.sessions, snapshot_sha256: p.snapshot.sha256 }), solve: solveBookingProfile, slots: solutionsForCalendar,
    addVirtualBusy, supportIds: () => [], supportAvailable: () => true, assessment: () => null });
  return { p, context, run, reads: () => reads };
}
test('initial external continuation anchors the first managed original session, not its absolute offset; one bulk read and no context mutation', async () => {
  const f = fixture(plan({ external: true }));
  const result = await f.run({ from_date: '2030-01-07', days: 45, draft_strategy: { action: 'initial' } });
  assert.deepEqual(result.proposals.map(row => row.key), ['s1','s2']);
  assert.equal(result.proposals[0].solution.start_local.slice(0,10), '2030-01-07');
  assert.equal(result.proposals[1].solution.start_local.slice(0,10), '2030-01-22');
  assert.equal(f.reads(), 1); assert.equal(f.context.doctors.get(5).busy.length, 0); assert.equal(f.context.patientBusy.length, 0);
});
test('cascade preserves prefix, resources and placed following drafts by civil wall-clock shift across DST', async () => {
  const f = fixture(), supplied = rows(['2030-03-01T10:00','2030-03-18T10:00','2030-04-02T10:00'],[0,2]);
  const result = await f.run(input(supplied,'cascade',{pivot_key:'s1',start_local:'2030-03-25T10:00'}));
  assert.deepEqual(result.proposals.map(row => civilLocal(row.solution.start_at,zone)), ['2030-03-01T10:00','2030-03-25T10:00','2030-04-09T10:00']);
  assert.deepEqual(result.draft_strategy.affected_keys,['s1','s2']); assert.deepEqual(result.draft_strategy.placed_keys,['s0','s2']);
  assert.equal(result.proposals[2].solution.start_at,'2030-04-09T08:00:00.000Z'); assert.equal(result.proposals[2].placed,true);
  assert.equal(result.proposals[2].solution.start_local,'2030-04-09T10:00'); assert.equal(result.proposals[2].solution.end_local,'2030-04-09T10:30');
  assert.equal(f.reads(),1);
});
test('next/previous time remain on the same clinic day and skip actual patient occupancy; unavailable direction preserves current draft', async () => {
  const f = fixture(); f.context.patientBusy.push({ start:'2030-01-07T09:15:00Z',end:'2030-01-07T10:00:00Z' });
  const result = await f.run(input(rows(),'next_time'));
  assert.equal(civilLocal(result.proposals[0].solution.start_at,zone),'2030-01-07T11:00');
  assert.equal(civilLocal(result.proposals[1].solution.start_at,zone),'2030-01-22T11:00');
  const empty = fixture(); const unchanged = await empty.run(input(rows(['2030-01-07T00:00','2030-01-22T00:00','2030-02-06T00:00']),'previous_time'));
  assert.equal(unchanged.draft_strategy.applied,false); assert.equal(civilLocal(unchanged.proposals[0].solution.start_at,zone),'2030-01-07T00:00');
});
test('next day keeps preferred civil time and cascades all later provisional rows', async () => {
  const f=fixture(); const result=await f.run(input(rows(),'next_day'));
  assert.deepEqual(result.proposals.map(row=>civilLocal(row.solution.start_at,zone)),['2030-01-08T10:00','2030-01-23T10:00','2030-02-07T10:00']);
});
test('reset preserves every placed draft and reapplies the canonical intervals only to unplaced rows', async () => {
  const f=fixture();const result=await f.run(input(rows(['2030-03-20T10:00','2030-04-20T11:00','2030-05-20T11:00'],[0]),'reset'));
  assert.equal(civilLocal(result.proposals[0].solution.start_at,zone),'2030-03-20T10:00');
  assert.deepEqual(result.proposals.slice(1).map(row=>row.solution.start_local.slice(0,10)),['2030-04-04','2030-04-19']);
  assert.deepEqual(result.draft_strategy.affected_keys,['s1','s2']);
});
test('hard room/patient occupancy never becomes a forceable draft, and manual unknown protocol never invents dates', async () => {
  const f=fixture();f.context.installations.get(9).busy.push({start:'2030-01-07T10:00:00Z',end:'2030-01-07T10:30:00Z'});
  const unavailable=await f.run(input(rows(),'cascade',{start_local:'2030-01-07T11:00'}));
  assert.equal(unavailable.proposals[0].solution,null);
  const manual=fixture(plan({manual:true}));const result=await manual.run({from_date:'2030-01-07',days:30,draft_strategy:{action:'initial'}});
  assert(result.proposals.every(row=>row.solution===null));
});
test('unregistered, reserved, unknown, duplicate or overbounded draft identities and illegal resources are rejected; DST gaps are not guessed', async () => {
  const f=fixture(plan({external:true})); await assert.rejects(f.run(input(rows(),'reset')),{code:'program_draft_invalid'});
  const ordinary=fixture();const duplicate=rows();duplicate[1].key='s0';await assert.rejects(ordinary.run(input(duplicate,'reset')));
  const foreign=rows();foreign[0].selections.care.doctor_id=99;await assert.rejects(ordinary.run(input(foreign,'reset')),{code:'program_selection_invalid'});
  await assert.rejects(ordinary.run(input(rows(),'cascade',{start_local:'2030-03-31T02:30'})),{code:'voucher_schedule_dst_conflict'});
  ordinary.p.sessions[0].scheduling_status='reserved';await assert.rejects(ordinary.run(input(rows(),'reset')));
  assert.throws(()=>normalize(plan(),{...input(rows(),'reset'),mode:'resume'},now));
  for (const selections of [[], 'invalid', { care: { installation_id: '9' } }, { care: { force: true } }, { care: null }]) {
    const supplied=rows(); delete supplied[0].start_at; supplied[0].selections=selections;
    await assert.rejects(fixture().run(input(supplied,'reset')), {code:'program_booking_selection_invalid'});
  }
});
test('an undated manual session can be placed explicitly without an invented old date or following protocol; existing later dates require a real origin', async () => {
  const manual=fixture(plan({manual:true}));
  const sessions=manual.p.sessions.map(row=>({key:row.key,placed:false}));
  const placed=await manual.run(input(sessions,'cascade',{start_local:'2030-01-07T10:00'}));
  assert.equal(placed.proposals[0].solution.start_local,'2030-01-07T10:00');
  assert(placed.proposals.slice(1).every(row=>row.solution===null));
  assert.equal(placed.proposals[0].requested_start_local,'2030-01-07T10:00');
  const following=sessions.map(row=>({...row}));following[1].start_at='2030-01-22T09:00:00.000Z';
  await assert.rejects(manual.run(input(following,'cascade',{start_local:'2030-01-07T10:00'})),{code:'program_draft_origin_date_required'});
});
test('initial preferences skip excluded clinic weekdays, prefer afternoon after an initial lower hour, and explain a real morning fallback',async()=>{
  const f=fixture();
  const response=await f.run({from_date:'2030-01-04',days:45,draft_strategy:{action:'initial',start_local:'2030-01-04T09:00',preferences:{exclude_weekdays:[5],prefer_after_minutes:960}}});
  assert.equal(response.proposals[0].solution.start_local,'2030-01-05T16:00');
  assert(response.proposals.every(row=>!row.preference_warnings));
  const morning=fixture();morning.p.sessions=morning.p.sessions.slice(0,1);
  for(const map of [morning.context.doctors,morning.context.installations]) for(const resource of map.values()) resource.windows=[{start:'2030-01-07T08:00Z',end:'2030-01-07T11:00Z'}];
  const fallback=await morning.run({from_date:'2030-01-07',days:1,draft_strategy:{action:'initial',preferences:{prefer_after_minutes:960}}});
  assert.equal(fallback.proposals[0].solution.start_local,'2030-01-07T09:00');
  assert.equal(fallback.proposals[0].preference_warnings[0].code,'program_preference_time_fallback');
  const blocked=await f.run(input(rows(),'cascade',{start_local:'2030-01-04T10:00',preferences:{exclude_weekdays:[5]}}));
  assert.equal(blocked.proposals[0].solution,null);assert.equal(blocked.proposals[0].reason_code,'program_booking_preference_conflict');
});
test('keeping a professional is a real soft preference, with fallback warnings; it never overrides explicit resources or the clinical priority',async()=>{
  const f=fixture();f.p.sessions=f.p.sessions.slice(0,2);
  for(const row of f.p.sessions) row.booking_profile={...profile,phases:[{...profile.phases[0],professionals:{mode:'any',ids:[5,6],preferred_id:5}}]};
  f.context.doctors.set(6,{resource_key:'doctor:6',windows:[{start:'2030-01-01Z',end:'2031-01-01Z'}],busy:[]});
  f.context.doctors.get(5).busy.push({start:'2030-01-06T23:00Z',end:'2030-01-07T23:00Z'});
  const result=await f.run({from_date:'2030-01-07',days:45,draft_strategy:{action:'initial',preferences:{keep_professional:true}}});
  assert.deepEqual(result.proposals.map(row=>row.solution.phases[0].doctor_ids),[[6],[5]]);
  assert.equal(result.proposals[1].preference_warnings[0].code,'program_preference_professional_fallback');
  assert.equal(result.proposals[1].solution.requires_priority_acknowledgement,false);
  const supplied=result.proposals.map(row=>({key:row.key,start_at:row.solution.start_at,placed:true,selections:{care:{installation_id:9,doctor_id:6}}}));
  const explicit=await f.run(input(supplied,'reset',{preferences:{keep_professional:true}}));
  assert.deepEqual(explicit.proposals.map(row=>row.solution.phases[0].doctor_ids),[[6],[6]]);
  assert.equal(explicit.proposals[1].solution.requires_priority_acknowledgement,true);
});
test('the draft window is bounded to thirty original identities and never accepts a thirty-first provisional row',()=>{
  const p=plan();p.sessions=Array.from({length:32},(_,position)=>({...p.sessions[0],key:'s'+position,position}));
  const initial=normalize(p,{from_date:'2030-01-07',days:1,draft_strategy:{action:'initial'}},now);
  assert.equal(initial.rows.length,30);assert.equal(initial.rows[29].key,'s29');
  assert.throws(()=>normalize(p,{from_date:'2030-01-07',days:1,draft_strategy:{action:'reset',sessions:p.sessions.slice(0,31).map(row=>({key:row.key,placed:false}))}},now),{code:'program_draft_invalid'});
});
