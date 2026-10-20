'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createClinicalEpisodesController, clinicalEpisodeHandler } = require('../../controllers/clinicalEpisodes.controller');
const C = require('../../lib/clinical-episode-contract');
function response() {
  return { code: 200, headers: {}, set(k, v) { this.headers[k] = v; return this; }, status(value) { this.code = value; return this; }, json(value) { this.body = value; return this; } };
}
const req = patch => ({ params: { id: 'owned-episode' }, query: { clinic_id: '72' }, method: 'GET', userData: { userId: 7 }, ...patch });

test('patient and clinical permissions are checked before reading or writing any episode', async () => {
  for (const denied of ['patients.view', 'patients.sensitive.view', 'clinical.reports.view', 'clinical.reports.manage']) {
    const calls = [], controller = createClinicalEpisodesController({ canAccess: async input => { calls.push(input); return input.featureKey !== denied; },
      episodes: { get: () => { throw Error('DATA_QUERY_FORBIDDEN'); }, save: () => { throw Error('DATA_WRITE_FORBIDDEN'); } } });
    const res = response();
    await controller[denied.endsWith('manage') ? 'save' : 'get'](req(), res);
    assert.equal(res.code, 403); assert.equal(res.body.error.code, 'access_policy_forbidden');
    assert(calls.every(call => call.clinicId === 72 && call.actorId === 7));
  }
});

test('appointment episode lookup uses real clinic and rejects caller clinic mismatch', async () => {
  const calls = [], controller = createClinicalEpisodesController({ findAppointment: async id => ({ id_cita: id, clinica_id: 72 }), canAccess: async () => true,
    episodes: { getForAppointment: async input => { calls.push(input); return { item: null }; } } });
  const mismatch = response(); await controller.getForAppointment(req({ params: { id: '5' }, query: { clinic_id: '73' } }), mismatch);
  assert.equal(mismatch.code, 404); assert.equal(calls.length, 0);
  const valid = response(); await controller.getForAppointment(req({ params: { id: '5' } }), valid);
  assert.equal(valid.code, 200); assert.equal(calls[0].clinicId, 72); assert.equal(calls[0].appointmentId, 5);
});

test('auth, CAS, not-found and schema failures are JSON without leaking SQL or paths', async () => {
  const cases = [[C.error(428, 'clinical_report_version_required', 'Reabre'), 428, 'clinical_report_version_required'],
    [C.error(409, 'clinical_report_version_conflict', 'Conflicto', { current_version: 2 }), 409, 'clinical_report_version_conflict'],
    [Object.assign(Error('SECRET_SQL'), { original: { code: 'ER_NO_SUCH_TABLE' } }), 503, 'clinical_episode_schema_pending'],
    [Error('SECRET_PATH /private/file'), 500, 'clinical_episode_unavailable']];
  for (const [error, status, code] of cases) {
    const res = response(); await clinicalEpisodeHandler(() => { throw error; })(req(), res);
    assert.equal(res.code, status); assert.equal(res.body.error.code, code);
    assert.equal(JSON.stringify(res.body).includes('SECRET'), false); assert.equal(res.headers['Cache-Control'], 'private, no-store');
  }
  const controller = createClinicalEpisodesController({ canAccess: () => { throw Error('AUTH_MUST_WIN'); } });
  const res = response(); await controller.get(req({ userData: null }), res); assert.equal(res.code, 401);
});
