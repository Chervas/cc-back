'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createGoogleReviewAiDraft, USE_CASE, TTL_MS, __testing } = require('../../services/googleReviewAiDraft.service');
const good = () => ({ disposition: 'draft', professionalName: 'absent', offensiveOrHurtful: 'absent',
  confidence: 0.99, draft: 'Gracias por compartir tu opinión.' });
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(options = {}) {
  const state = { allowed: true, session: true, paused: false, runtime: true, time: 1800000000000,
    settings: { prompt: 'INSTRUCCIÓN FICTICIA DE PRUEBA', configured: true, version: 1 },
    source: { clinicName: 'Clínica ficticia', groupId: 4, authority: { mappingId: 8, clinicIds: [7, 9] },
      review: { id: 11, comment: 'Esperé demasiado y el precio me pareció caro.', star_rating: 1,
        has_reply: false, reply_comment: null, google_missing_at: null, update_time: '2026-11-02T10:00:00Z',
        reviewer_name: 'DO_NOT_SEND_REVIEWER', matched_paciente_id: 'DO_NOT_SEND_PATIENT' } } };
  const calls = [], checks = [];
  const denied = (code, status = 403) => { throw Object.assign(Error(code), { code, status }); };
  const service = createGoogleReviewAiDraft({
    now: () => state.time, settings: { read: async () => ({ ...state.settings }) },
    loadSource: async context => {
      checks.push(context);
      if (!state.allowed || context.userId === 999 || context.clinicId === 999) denied('scope_write_forbidden');
      return structuredClone({ ...state.source, review: { ...state.source.review, id: context.reviewId } });
    },
    verifySession: async () => { if (!state.session) denied('business_profile_session_required', 401); },
    assertRuntime: () => { if (!state.runtime) denied('review_ai_broker_required', 503); },
    assertAllowed: async useCase => { assert.equal(useCase, USE_CASE); if (state.paused) denied('ai_function_manually_paused', 409); },
    analyze: async input => { calls.push(input); await input.beforeDispatch(); return good(); },
    ...options,
  });
  const requestId = randomUUID();
  const generate = (overrides = {}) => service.generate({ clinicId: 7, reviewId: 11, userId: 21, input: { requestId }, ...overrides });
  return { state, calls, checks, service, generate };
}

test('one bounded draft, local public data only, tenant telemetry and no low-rating abuse assumption', async () => {
  const f = fixture(); const result = await f.generate();
  assert.deepEqual(result, { success: true, reviewId: 11, draft: good().draft, disposition: 'draft', reasons: [], reused: false,
    expiresAt: new Date(f.state.time + TTL_MS).toISOString() });
  assert.equal(f.calls.length, 1);
  const call = f.calls[0];
  assert.equal(call.useCase, USE_CASE); assert.equal(call.clinicId, 7); assert.equal(call.groupId, 4);
  assert.equal(call.coerceOutput, false); assert.equal(call.maxTokens, 1800);
  assert.equal(call.requireBroker, true);
  assert.equal(call.prompt, f.state.settings.prompt);
  assert.deepEqual(JSON.parse(call.inputText), { clinicName: 'Clínica ficticia', review: {
    comment: f.state.source.review.comment, starRating: 1 } });
  assert.doesNotMatch(JSON.stringify(call), /DO_NOT_SEND/);
  assert(f.checks.length >= 3);
});

test('no comment, answered, oversized, professional names and explicit abuse are cost-free even without prompt/runtime', async () => {
  const cases = [
    [{ comment: null }, 'no_comment'], [{ comment: ' \n ' }, 'no_comment'],
    [{ has_reply: true }, 'already_replied'], [{ reply_comment: 'Existing reply' }, 'already_replied'],
    [{ comment: 'x'.repeat(12001) }, 'review_too_long'],
    [{ comment: 'La Dra. Pérez fue excelente' }, 'professional_name_detected'],
    [{ comment: 'La higienista Ana fue amable' }, 'professional_name_detected'],
    [{ comment: 'Son unos imbéciles' }, 'offensive_or_hurtful'],
  ];
  for (const [patch, reason] of cases) {
    const f = fixture(); Object.assign(f.state.source.review, patch);
    f.state.settings = { prompt: '', configured: false, version: 0 }; f.state.runtime = false; f.state.paused = true;
    const result = await f.generate();
    assert.equal(result.disposition, 'manual_review'); assert.equal(result.draft, null); assert(result.reasons.includes(reason));
    if (reason === 'offensive_or_hurtful') assert(result.reasons.includes('consider_reporting'));
    assert.equal(f.calls.length, 0);
  }
});

test('missing prompt, paused case, unavailable broker, missing authority and session stop inference', async () => {
  for (const [change, code] of [
    [s => { s.settings.configured = false; }, 'review_ai_prompt_not_configured'],
    [s => { s.paused = true; }, 'ai_function_manually_paused'],
    [s => { s.runtime = false; }, 'review_ai_broker_required'],
    [s => { s.allowed = false; }, 'scope_write_forbidden'],
    [s => { s.session = false; }, 'business_profile_session_required'],
    [s => { s.source.review.google_missing_at = '2026-11-02'; }, 'business_profile_review_not_found'],
  ]) {
    const f = fixture(); change(f.state);
    await assert.rejects(f.generate(), { code }); assert.equal(f.calls.length, 0);
  }
});

test('strict request UUID and body reject injected prompts, public text, batch and malformed IDs before reading', async () => {
  const f = fixture();
  for (const input of [null, {}, [], { requestId: 'anything' }, { requestId: randomUUID(), prompt: 'override' },
    { requestId: randomUUID(), comment: 'override' }, { requestId: randomUUID(), reviews: [11, 12] }]) {
    await assert.rejects(f.generate({ input }), { code: 'review_ai_request_invalid' });
  }
  for (const reviewId of ['11junk', -1, 0, '1e2', Number.MAX_SAFE_INTEGER]) {
    await assert.rejects(f.generate({ reviewId }), { code: 'review_ai_request_invalid' });
  }
  assert.equal(f.checks.length, 0); assert.equal(f.calls.length, 0);
});

test('AI analysis is conservative, does not leak draft/reasons, and rejects malformed fields', async () => {
  const cases = [
    [{ professionalName: 'present' }, 'professional_name_detected'],
    [{ offensiveOrHurtful: 'present' }, 'offensive_or_hurtful'],
    [{ offensiveOrHurtful: 'uncertain' }, 'uncertain_safety'],
    [{ confidence: 0.94 }, 'uncertain_safety'], [{ confidence: '0.99' }, 'invalid_ai_output'],
    [{ professionalName: undefined }, 'invalid_ai_output'], [{ draft: { unsafe: true } }, 'invalid_ai_output'],
    [{ draft: '' }, 'invalid_ai_output'], [{ draft: 'x'.repeat(4097) }, 'invalid_ai_output'],
    [{ disposition: 'manual_review' }, 'manual_review_required'],
    [{ draft: 'La doctora Ana confirma que eres paciente.' }, 'professional_name_detected'],
  ];
  for (const [patch, reason] of cases) {
    const f = fixture({ analyze: async () => ({ ...good(), ...patch, reasons: ['PRIVATE_PROVIDER_CONTENT'] }) });
    const result = await f.generate();
    assert.equal(result.draft, null); assert.equal(result.disposition, 'manual_review'); assert(result.reasons.includes(reason));
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_PROVIDER_CONTENT/);
  }
});

test('same/different UUIDs and simultaneous authorized callers reuse one inference; request UUID is bound to input', async () => {
  let release, calls = 0;
  const hold = new Promise(resolve => { release = resolve; });
  const f = fixture({ analyze: async () => { calls++; await hold; return good(); } });
  const first = f.generate(); await tick();
  const same = f.generate(); const other = f.generate({ userId: 22, input: { requestId: randomUUID() } });
  await tick(); assert.equal(calls, 1); release();
  const results = await Promise.all([first, same, other]);
  assert.deepEqual(results.map(r => r.reused), [false, true, true]);
  assert.equal((await f.generate({ input: { requestId: randomUUID() } })).reused, true);
  await assert.rejects(f.generate({ reviewId: 12 }), { code: 'review_ai_request_conflict' });
  f.state.source.review.comment = 'Texto editado';
  await assert.rejects(f.generate(), { code: 'review_ai_request_conflict' });
  assert.equal(calls, 1);
});

test('scope, session, reply, content, mapping, settings, broker and pause revocation before dispatch and after AI', async () => {
  const cases = [
    [s => { s.allowed = false; }, 'scope_write_forbidden'],
    [s => { s.session = false; }, 'business_profile_session_required'],
    [s => { s.paused = true; }, 'ai_function_manually_paused'],
    [s => { s.runtime = false; }, 'review_ai_broker_required'],
    [s => { s.source.review.has_reply = true; }, 'review_ai_source_changed'],
    [s => { s.source.review.comment = 'Edited'; }, 'review_ai_source_changed'],
    [s => { s.source.authority.clinicIds.push(33); }, 'review_ai_source_changed'],
    [s => { s.settings.version++; }, 'review_ai_settings_changed'],
  ];
  for (const phase of ['dispatch', 'completion']) for (const [change, code] of cases) {
    let calls = 0, f;
    f = fixture({ analyze: async input => {
      if (phase === 'dispatch') { change(f.state); await input.beforeDispatch(); }
      calls++;
      if (phase === 'completion') change(f.state);
      return good();
    } });
    await assert.rejects(f.generate(), { code }); assert.equal(calls, phase === 'dispatch' ? 0 : 1);
  }
});

test('cached and joined requests revalidate each caller and never bypass a pause or revocation', async () => {
  const f = fixture(); await f.generate();
  await assert.rejects(f.generate({ userId: 999 }), { code: 'scope_write_forbidden' });
  await assert.rejects(f.generate({ clinicId: 999 }), { code: 'scope_write_forbidden' });
  f.state.paused = true; await assert.rejects(f.generate(), { code: 'ai_function_manually_paused' });
  assert.equal(f.calls.length, 1);
  let release, joinedAllowed = true;
  const hold = new Promise(resolve => { release = resolve; });
  const g = fixture({ analyze: async () => { await hold; return good(); }, verifySession: async request => {
    if (request === 'joined' && !joinedAllowed) throw Object.assign(Error(), { code: 'business_profile_session_required', status: 401 });
  } });
  const a = g.generate(); await tick(); const b = g.generate({ request: 'joined', userId: 22 });
  const denied = assert.rejects(b, { code: 'business_profile_session_required' });
  await tick(); joinedAllowed = false; release(); await a; await denied;
});

test('uncertain provider failure is sanitized and cached across UUIDs to avoid accidental paid retries', async () => {
  let calls = 0;
  const f = fixture({ analyze: async () => { calls++; throw Error('SECRET PROMPT AND PROVIDER DETAILS'); } });
  for (const input of [undefined, { requestId: randomUUID() }]) {
    await assert.rejects(f.generate(input ? { input } : {}), { code: 'review_ai_unavailable', status: 503 });
  }
  assert.equal(calls, 1);
});

test('rate limits actor/clinic, in-flight work and bounded cache; reuse costs no new reservation; expiry releases capacity', async () => {
  const f = fixture({ actorPerMinute: 1, clinicPerMinute: 2, maxEntries: 2 });
  await f.generate(); assert.equal((await f.generate()).reused, true);
  await assert.rejects(f.generate({ reviewId: 12, input: { requestId: randomUUID() } }), { code: 'review_ai_rate_limited', status: 429 });
  await f.generate({ userId: 22, reviewId: 12, input: { requestId: randomUUID() } });
  await assert.rejects(f.generate({ userId: 23, reviewId: 13, input: { requestId: randomUUID() } }), { code: 'review_ai_capacity_exceeded' });
  f.state.time += TTL_MS + 1;
  assert.equal((await f.generate()).reused, false); assert.equal(f.calls.length, 3);
  let release;
  const hold = new Promise(resolve => { release = resolve; });
  const g = fixture({ analyze: async () => { await hold; return good(); } });
  const a = g.generate(); await tick();
  await assert.rejects(g.generate({ reviewId: 12, input: { requestId: randomUUID() } }), { code: 'review_ai_rate_limited' });
  release(); await a;
});

test('deterministic rules do not classify ordinary criticism or ratings as abuse', () => {
  for (const text of ['Es caro y la espera fue larga.', 'No me gustó el resultado.', 'Una estrella.', 'Excelente servicio.']) {
    assert.deepEqual(__testing.riskReasons(text), []);
  }
});

test('clinic status contains only configured and requires local enablement, prompt, broker and no pause', async () => {
  const f = fixture();
  assert.deepEqual(await f.service.status(), { configured: true });
  f.state.settings.configured = false; assert.deepEqual(await f.service.status(), { configured: false });
  f.state.settings.configured = true; f.state.runtime = false; assert.deepEqual(await f.service.status(), { configured: false });
  f.state.runtime = true; f.state.paused = true; assert.deepEqual(await f.service.status(), { configured: false });
  const disabled = fixture({ assertRuntime: () => { throw Object.assign(Error(), { code: 'review_ai_not_enabled' }); } });
  assert.deepEqual(await disabled.service.status(), { configured: false });
  assert.equal(f.calls.length, 0);
});
