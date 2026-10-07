'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const recovery = require('../../lib/whatsappSameDayRecovery');
const now = Date.parse('2026-10-07T07:00:00.000Z');
function fixture() {
    const a = { id_cita: 10, clinica_id: 66, paciente_id: 20, inicio: '2026-10-07T09:00:00.000Z',
        estado: 'recordatorio_confirmado', source_system: 'cliniccloud', source_reference: 'source:10',
        import_metadata: { cliniccloud_reconciliation: { automation_policy: 'hold' },
            notification_suppression: { appointment_details: true, day_before: true, same_day: true } } };
    const e = { template_version_id: 1777, trigger_type: 'appointment_reminder_window',
        trigger_entity_type: 'appointment', trigger_entity_id: 10, clinic_id: 66,
        created_at: '2026-10-07T06:50:00.000Z', context: { appointment: { inicio: a.inicio } } };
    const raw = { version: 1, purpose: 'same_day_reminder_recovery', date: '2026-10-07', approvedBy: 1,
        approvalRef: 'carlos_20261007_recover_missing_same_day', approvedAt: '2026-10-07T06:45:00.000Z',
        expiresAt: '2026-10-07T22:00:00.000Z', automaticBacklogReplay: false,
        appointments: [{ id:10, patientId:20, clinicId:66, templateVersionId:1777,
            startAt:a.inicio, sourceSystem:a.source_system, sourceReference:a.source_reference }] };
    return { a, e, raw, policy: recovery.validate(raw) };
}
test('only the exact confirmed future imported reservation and same-day flow are released; receipts remain untouched', () => {
    const f = fixture(), before = JSON.stringify(f.a);
    assert(recovery.permits(f.a, { execution:f.e, templateName:'clinicaclick_recordatorio_mismo_dia_v17', policy:f.policy, now }));
    assert.equal(JSON.stringify(f.a), before);
    for (const change of [{ estado:'recordatorio_enviado' }, { estado:'cancelada' }, { es_provisional:true },
        { clinica_id:72 }, { paciente_id:21 }, { inicio:'2026-10-07T09:15:00.000Z' },
        { source_reference:'changed' }, { source_system:null }, { import_metadata:{ qa_demo:true } }]) {
        assert.equal(recovery.permits({ ...f.a, ...change }, { execution:f.e, templateName:'clinicaclick_recordatorio_mismo_dia_v17', policy:f.policy, now }), false);
    }
    for (const templateName of ['clinicaclick_recordatorio_dia_antes_v17', 'consentimiento', '']) {
        assert.equal(recovery.permits(f.a, { execution:f.e, templateName, policy:f.policy, now }), false);
    }
    for (const change of [{ template_version_id:611 }, { trigger_type:'consent_required' },
        { trigger_entity_id:11 }, { clinic_id:72 }, { created_at:'2026-10-07T06:00:00.000Z' }]) {
        assert.equal(recovery.permits(f.a, { execution:{ ...f.e, ...change }, templateName:'clinicaclick_recordatorio_mismo_dia_v17', policy:f.policy, now }), false);
    }
    assert.equal(recovery.permits(f.a, { execution:f.e, templateName:'clinicaclick_recordatorio_mismo_dia_v17', policy:f.policy, now:Date.parse(f.a.inicio) }), false);
    assert.equal(recovery.permits(f.a, { execution:f.e, templateName:'clinicaclick_recordatorio_mismo_dia_v17', policy:f.policy, now:Date.parse(f.raw.expiresAt) }), false);
});
test('scope cannot expand to another date, clinic, consent flow, backlog or duplicate patient', () => {
    const f = fixture();
    for (const change of [{ date:'2026-10-08' }, { purpose:'consent_required' }, { automaticBacklogReplay:true },
        { expiresAt:'2026-10-08T22:00:00.000Z' }, { appointments:[{ ...f.raw.appointments[0], clinicId:99 }] },
        { appointments:[{ ...f.raw.appointments[0], templateVersionId:611 }] },
        { appointments:[f.raw.appointments[0], { ...f.raw.appointments[0], id:11 }] }]) {
        assert.throws(() => recovery.validate({ ...f.raw, ...change }), /invalid_same_day_recovery/);
    }
    assert.equal(recovery.read({}), null);
});
