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
function fixture(p = plan(), at = now) {
  const resource = key => ({ resource_key: key, windows: [{ start: '2030-01-01T00:00:00Z', end: '2031-01-01T00:00:00Z' }], busy: [] });
  const context = { timeZone: p.timeZone, doctors: new Map([[5, resource('doctor:5')]]), installations: new Map([[9, resource('installation:9')]]),
    installationKeys: new Map([[9, 'installation:9']]), patientBusy: [] };
  let reads = 0;
  const run = payload => preview({ plan: p, payload, actorId: 1, now: at, contextFor: async () => { reads++; return context; },
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
test('initial date-only search starts today after now, including old hidden hours, without changing a future lower hour', async () => {
  const at = new Date('2030-01-07T10:07:34Z'); // 11:07 in the clinic, not the host timezone.
  for (const startLocal of [undefined, '2030-01-07T09:00', '2030-01-07T11:07']) {
    const f = fixture(plan(), at);
    const result = await f.run({ from_date: '2030-01-07', days: 45,
      draft_strategy: { action: 'initial', ...(startLocal ? { start_local: startLocal } : {}) } });
    assert.equal(result.proposals[0].solution.start_local, '2030-01-07T11:15', startLocal);
    assert(result.proposals.every(row => new Date(row.solution.start_at) > at));
    assert.equal(result.proposals[1].solution.start_local.slice(0, 10), '2030-01-22');
    assert.equal(f.context.patientBusy.length, 0);
  }
  const future = await fixture(plan(), at).run({ from_date: '2030-01-07', days: 45,
    draft_strategy: { action: 'initial', start_local: '2030-01-07T14:00' } });
  assert.equal(future.proposals[0].solution.start_local, '2030-01-07T14:00');
});
test('today is clinic-local around midnight and DST, never UTC or browser time', async () => {
  for (const [timeZone, at, date, expected] of [
    ['Europe/Madrid', '2030-01-01T23:07:00Z', '2030-01-02', '2030-01-02T00:15'],
    ['America/New_York', '2030-01-02T02:07:00Z', '2030-01-01', '2030-01-01T21:15'],
    ['Europe/Madrid', '2030-03-31T01:07:00Z', '2030-03-31', '2030-03-31T03:15'],
    ['Europe/Madrid', '2030-10-27T01:07:00Z', '2030-10-27', '2030-10-27T03:00'],
  ]) {
    const p = plan(); p.timeZone = timeZone; p.sessions = p.sessions.slice(0, 1);
    const result = await fixture(p, new Date(at)).run({ from_date: date, days: 1, draft_strategy: { action: 'initial' } });
    assert.equal(result.proposals[0].solution.start_local, expected, timeZone + ' ' + at);
    assert(new Date(result.proposals[0].solution.start_at) > new Date(at));
  }
});
test('today respects hard exclusions and soft ranges, and an exhausted day is unavailable rather than a past appointment', async () => {
  const at = new Date('2030-01-07T17:07:00Z'), p = plan(); p.sessions = p.sessions.slice(0, 1);
  const f = fixture(p, at);
  const fallback = await f.run({ from_date: '2030-01-07', days: 1, draft_strategy: { action: 'initial', start_local: '2030-01-07T09:00',
    preferences: { prefer_after_minutes: 960, prefer_before_minutes: 1080 } } });
  assert.equal(fallback.proposals[0].solution.start_local, '2030-01-07T18:15');
  assert.equal(fallback.proposals[0].preference_warnings[0].code, 'program_preference_time_fallback');
  const excluded = await f.run({ from_date: '2030-01-07', days: 1,
    draft_strategy: { action: 'initial', preferences: { exclude_weekdays: [1] } } });
  assert.equal(excluded.proposals[0].solution, null);
  for (const resources of [f.context.doctors, f.context.installations]) for (const resource of resources.values())
    resource.windows = [{ start: '2030-01-07T08:00Z', end: '2030-01-07T17:00Z' }, { start: '2030-01-08T08:00Z', end: '2030-01-08T17:00Z' }];
  const exhausted = await f.run({ from_date: '2030-01-07', days: 1, draft_strategy: { action: 'initial' } });
  assert.equal(exhausted.proposals[0].solution, null);
  assert.equal(exhausted.proposals[0].reason_code, 'program_booking_unavailable');
  const following = await f.run({ from_date: '2030-01-07', days: 2, draft_strategy: { action: 'initial' } });
  assert.equal(following.proposals[0].solution.start_local, '2030-01-08T09:00');
});
test('initial search rejects genuinely past, invalid, mismatched or over-year days and never shifts an explicit past placement', async () => {
  const at = new Date('2030-01-07T10:07:00Z');
  for (const date of ['2030-01-06', '2030-02-30', '2030-13-01', '2031-01-09']) {
    const f = fixture(plan(), at);
    await assert.rejects(f.run({ from_date: date, days: 1, draft_strategy: { action: 'initial' } }), { code: 'program_draft_invalid' });
    assert.equal(f.reads(), 0);
  }
  await assert.rejects(fixture(plan(), at).run({ from_date: '2030-01-07', days: 1,
    draft_strategy: { action: 'initial', start_local: '2030-01-08T09:00' } }), { code: 'program_draft_invalid' });
  for (const action of ['initial', 'reset', 'cascade']) {
    const supplied = rows(undefined, [0]);
    await assert.rejects(fixture(plan(), at).run(input(supplied, action,
      action === 'cascade' ? { start_local: '2030-01-07T09:00' } : {})), { code: 'program_draft_invalid' });
  }
  await assert.rejects(fixture(plan(), at).run(input(rows(['2030-01-08T10:00', '2030-01-23T10:00', '2030-02-07T10:00']), 'cascade',
    { start_local: '2030-01-07T09:00' })), { code: 'program_draft_invalid' });
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
test('initial/reset prefer inclusive start ranges, can end later, and never override a conflicting patient or resource',async()=>{
  const preferences={prefer_after_minutes:960,prefer_before_minutes:1080},f=fixture();
  f.context.patientBusy.push({start:'2030-01-07T15:00Z',end:'2030-01-07T15:30Z'});
  f.context.installations.get(9).busy.push({start:'2030-01-07T15:30Z',end:'2030-01-07T16:00Z'});
  const response=await f.run({from_date:'2030-01-07',days:45,draft_strategy:{action:'initial',preferences}});
  assert.equal(response.proposals[0].solution.start_local,'2030-01-07T17:00');
  assert(response.proposals.every(row=>!row.preference_warnings));
  assert.deepEqual(response.draft_strategy.preferences,preferences);
  const atBoundary=fixture();atBoundary.p.sessions=atBoundary.p.sessions.slice(0,1);
  for(const resources of [atBoundary.context.doctors,atBoundary.context.installations])
    for(const resource of resources.values()) resource.windows=[{start:'2030-01-07T17:00Z',end:'2030-01-07T17:30Z'}];
  const endingLater=await atBoundary.run({from_date:'2030-01-07',days:1,draft_strategy:{action:'initial',preferences}});
  assert.equal(endingLater.proposals[0].solution.start_local,'2030-01-07T18:00');
  assert.equal(endingLater.proposals[0].solution.end_local,'2030-01-07T18:30');
  assert(!endingLater.proposals[0].preference_warnings);
  const reset=await fixture().run(input(rows(undefined,[0]),'reset',{preferences}));
  assert.equal(reset.proposals[0].solution.start_local,'2030-01-07T10:00');
  assert.equal(reset.proposals[0].preference_warnings[0].code,'program_preference_time_fallback');
  assert(reset.proposals.slice(1).every(row=>row.solution.start_local.endsWith('T16:00')&&!row.preference_warnings));
});
test('range fallback is explicit on either side, while a full-day range retains the earliest real slot',async()=>{
  for(const [start,end,expected] of [['2030-01-07T08:00Z','2030-01-07T11:00Z','2030-01-07T09:00'],
    ['2030-01-07T18:00Z','2030-01-07T20:00Z','2030-01-07T19:00']]) {
    const f=fixture();f.p.sessions=f.p.sessions.slice(0,1);
    for(const resources of [f.context.doctors,f.context.installations])for(const resource of resources.values())resource.windows=[{start,end}];
    const result=await f.run({from_date:'2030-01-07',days:1,draft_strategy:{action:'initial',preferences:{prefer_after_minutes:960,prefer_before_minutes:1080}}});
    assert.equal(result.proposals[0].solution.start_local,expected);
    assert.equal(result.proposals[0].preference_warnings[0].code,'program_preference_time_fallback');
  }
  const allDay=await fixture().run({from_date:'2030-01-07',days:1,draft_strategy:{action:'initial',preferences:{prefer_after_minutes:0,prefer_before_minutes:1439}}});
  assert.equal(allDay.proposals[0].solution.start_local,'2030-01-07T00:00');
  assert(!allDay.proposals[0].preference_warnings);
});
test('directional range search stays on the requested day/direction and prefers in-range starts before fallback',async()=>{
  const preferences={prefer_after_minutes:960,prefer_before_minutes:1080};
  for(const [action,initial,expected] of [
    ['next_time',['2030-01-07T10:00','2030-01-22T10:00','2030-02-06T10:00'],'2030-01-07T16:00'],
    ['previous_time',['2030-01-07T20:00','2030-01-22T20:00','2030-02-06T20:00'],'2030-01-07T18:00'],
    ['next_day',undefined,'2030-01-08T16:00'],
    ['previous_day',undefined,'2030-01-06T16:00'],
  ]) {
    const f=fixture(),result=await f.run(input(rows(initial),action,{preferences}));
    assert.equal(result.proposals[0].solution.start_local,expected,action);
    assert(result.proposals.every(row=>!row.preference_warnings),action);
    assert.equal(f.context.patientBusy.length,0);
  }
  const fallback=await fixture().run(input(rows(),'previous_time',{preferences}));
  assert.equal(fallback.proposals[0].solution.start_local,'2030-01-07T09:45');
  assert.equal(fallback.proposals[0].preference_warnings[0].code,'program_preference_time_fallback');
});
test('manual cascade may choose outside the soft range but still preserves civil offsets across DST and hard exclusions',async()=>{
  const f=fixture(),preferences={prefer_after_minutes:960,prefer_before_minutes:1080};
  const result=await f.run(input(rows(['2030-03-15T16:00','2030-03-30T16:00','2030-04-14T16:00'],[0,1,2]),'cascade',
    {pivot_key:'s1',start_local:'2030-03-31T19:00',preferences}));
  assert.deepEqual(result.proposals.map(row=>row.solution.start_local),['2030-03-15T16:00','2030-03-31T19:00','2030-04-15T19:00']);
  assert(!result.proposals[0].preference_warnings);
  assert(result.proposals.slice(1).every(row=>row.preference_warnings[0].code==='program_preference_time_fallback'));
  assert.equal(result.proposals[1].solution.start_at,'2030-03-31T17:00:00.000Z');
  assert.deepEqual(result.draft_strategy.placed_keys,['s0','s1','s2']);
  const excluded=await fixture().run(input(rows(),'cascade',{start_local:'2030-01-08T17:00',preferences:{...preferences,exclude_weekdays:[2]}}));
  assert.equal(excluded.proposals[0].solution,null);
  assert.equal(excluded.proposals[0].reason_code,'program_booking_preference_conflict');
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
test('an invalidated placed draft clears only its own placement and keeps valid prefix/following proposals coherent with placed_keys',async()=>{
  for(const action of ['reset','cascade','excluded_day']){
    const f=fixture(),supplied=rows(undefined,[0,1,2]);
    const newDate=action==='cascade'?'2030-01-23T10:00':null;
    if(action!=='excluded_day')f.context.installations.get(9).busy.push({start:action==='cascade'?'2030-01-23T09:00Z':'2030-01-22T09:00Z',end:action==='cascade'?'2030-01-23T09:30Z':'2030-01-22T09:30Z'});
    const response=await f.run(input(supplied,action==='cascade'?'cascade':'reset',{
      ...(newDate?{pivot_key:'s1',start_local:newDate}:{}),...(action==='excluded_day'?{preferences:{exclude_weekdays:[2]}}:{})}));
    assert.deepEqual(response.proposals.map(row=>[row.key,row.placed,!!row.solution]),[['s0',true,true],['s1',false,false],['s2',true,true]],action);
    assert.deepEqual(response.draft_strategy.placed_keys,['s0','s2'],action);
    assert.equal(response.proposals[1].requested_start_local,newDate || '2030-01-22T10:00');
    assert.equal(response.proposals[2].solution.start_local,action==='cascade'?'2030-02-07T10:00':'2030-02-06T10:00');
    assert.equal(f.context.installations.get(9).busy.length,action==='excluded_day'?0:1);
  }
});
