'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { countPotential } = require('../../services/reviewOverview.service');
const { buildReviewRequestHistory, readReviewRequestHistory } = require('../../lib/review-request-history');
const { aggregateReport, reportRange } = require('../../services/reviewActivityReport.service');
const fs = require('node:fs'), vm = require('node:vm');

test('potential excludes a patient in any queue by patient ID or normalized phone, even with duplicate fichas', () => {
  const history = { patientIds: new Set([3]), phoneKeys: new Set(['34600000004']) };
  const patients = Array.from({ length: 8 }, (_, i) => ({ id_paciente: i + 1, telefono_movil: '+34 600 000 00' + (i + 1), has_care: 1 }));
  assert.equal(countPotential(patients, history, [{ paciente_id: 1 }, { phone: '600000002' }], [{ phone_digits: '34600000005' }]), 3);
  assert.equal(countPotential([...patients, { ...patients[6], id_paciente: 99 }], history,
    [{ paciente_id: 1 }, { phone: '600000002' }], [{ phone_digits: '34600000005' }]), 3);
});
test('no valid mobile or no verified past care is not a potential; canonical imported date evidence is accepted', () => {
  const history = buildReviewRequestHistory();
  const rows = [{ id_paciente: 1, telefono_movil: '600000001', has_care: 0 },
    { id_paciente: 2, telefono_movil: '900000001', has_care: 1 },
    { id_paciente: 3, telefono_movil: '600000003', date_fields: { fecha_ultimo_tratamiento: '14/09/2026' } },
    { id_paciente: 4, telefono_movil: '600000004', date_fields: { fecha_ultimo_tratamiento: '2030-01-01' } },
    { id_paciente: 5, telefono_movil: '600000005', date_fields: { fecha_ultimo_tratamiento: 'no acreditado' } }];
  assert.equal(countPotential(rows, history, [], [], new Date('2026-10-30T00:00:00Z')), 1);
});
test('batch history keeps the same phone independent across clinics and reserves paused queues', async () => {
  let calls = 0;
  const query = async sql => { calls++; return sql.includes('SELECT c.clinic_id') ? [] : [
    { history_clinic_id: 31, paciente_id: 1, phone: '600000001', selected: 1, status: 'ready', list_status: 'paused', dispatch_status: 'pending' },
    { history_clinic_id: 32, paciente_id: 2, phone: '600000002', sent_at: new Date(), dispatch_status: 'sent' },
  ]; };
  const result = await readReviewRequestHistory({ query, clinicIds: [31, 32], byClinic: true });
  assert.equal(calls, 2); assert.equal(result.get(31).phoneKeys.has('34600000001'), true);
  assert.equal(result.get(32).phoneKeys.has('34600000001'), false);
});
test('group series sum to the group total and shared profiles stay explicitly separate', () => {
  const range = reportRange('2d', new Date('2026-10-30T10:00:00Z'));
  const result = aggregateReport([
    { metric: 'requests_sent', clinic_id: 31, at_utc: '2026-10-30T08:00:00Z', total: 7 },
    { metric: 'requests_sent', clinic_id: 32, at_utc: '2026-10-30T08:00:00Z', total: 3 },
    { metric: 'google_reviews_total', clinic_id: 0, at_utc: '2026-10-30T08:00:00Z', total: 2 },
  ], range, { clinicNames: { 31: 'Clinic A', 32: 'Clinic B' } });
  assert.equal(result.totals.requests_sent, 10);
  assert.equal(result.by_clinic.reduce((sum, r) => sum + r.series.find(s => s.key === 'requests_sent').data.reduce((a, p) => a + p.y, 0), 0), 10);
  assert.equal(result.by_clinic.find(r => r.clinic_id === 0).clinic_name, 'Fichas compartidas');
});

for (const endpoint of ['getReviewOverview', 'getReviewPrivateRatings']) {
  test(endpoint + ' checks scope permissions before any SQL reader; aliases keep the canonical queue scope', async () => {
    let allowed = false, reads = 0, options; const scope = {isValid:true,scope:'clinic',clinicIds:[31]};
    const deps = { '../lib/clinicScope':{resolveClinicScope:async()=>scope},'../services/marketingBulkSends.service':{},
      '../lib/marketingScopeAccess':{hasMarketingClinicScopeAccess:async()=>allowed},
      '../services/reviewOverview.service':{current:()=>({overview:async(s,o)=>{reads++;options=o;return {};},privateRatings:async()=>{reads++;return {};}})} };
    const ctx={exports:{},console,require:name=>{assert(name in deps,name);return deps[name];}};
    vm.runInNewContext(fs.readFileSync(require.resolve('../../controllers/marketingBulkSends.controller'),'utf8'),ctx);
    let code=200; const res={set(){},json(){},status(n){code=n;return this;}};
    await ctx.exports[endpoint]({query:{clinicId:'31'},userData:{userId:1}},res);
    assert.equal(code,403); assert.equal(reads,0);
    allowed=true; code=200; await ctx.exports[endpoint]({query:{clinicId:'31'},userData:{userId:1}},res);
    assert.equal(code,200);assert.equal(reads,1);
    if (options) assert.equal(options.scopeRaw,'31');
  });
}
