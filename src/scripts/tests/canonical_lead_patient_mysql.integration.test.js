'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { createCanonicalLeadPatientMysqlFixture } = require('./fixtures/canonical_lead_patient_mysql.fixture');

test('lead booking preserves an established patient owner and explicit household identities without creating duplicates',
  { skip: process.env.CANONICAL_LEAD_PATIENT_MYSQL_TEST !== '1', timeout: 180000 }, async t => {
    await withIsolatedCampaignMysql(async context => {
      const f = await createCanonicalLeadPatientMysqlFixture(context), { db } = f;
      let leadId = 800;
      const seed = async ({ snapshot = true, opaque = false, shared = false } = {}) => {
        const n = ++leadId, phone = '34600800' + String(n).slice(-3);
        const canonical = await db.Paciente.create({ public_id: 'pac_owned_canonical_' + n, clinica_id: 100,
          nombre: 'Paciente canónico ficticio', apellidos: String(n), telefono_movil: phone });
        const lead = await f.lead(n, { telefono: phone, nombre: canonical.nombre, created_at: new Date('2026-01-01T10:00:00Z') });
        if (snapshot) await f.contextSnapshot(n, canonical);
        const chat = await f.conversation(n, canonical, opaque ? { contact_id: 'bsuid:ES.10000' + n } : {});
        const other = shared ? await db.Paciente.create({ public_id: 'pac_owned_shared_' + n, clinica_id: 100,
          nombre: 'Otra persona ficticia', apellidos: String(n), telefono_movil: phone }) : null;
        await lead.reload(); await chat.reload();
        return { lead, canonical, other, chat, input: f.body({ lead_intake_id: n, inicio: '2030-01-15T14:00:00Z', fin: '2030-01-15T14:20:00Z',
          paciente: { nombre: canonical.nombre, apellidos: canonical.apellidos, telefono: phone } }) };
      };
      try {
        await t.test('a consistent phone-format booking reuses the established patient without changing the conversation owner', async () => {
          const p = await seed(), count = await db.Paciente.count(); p.input.paciente.telefono = '+34 ' + p.canonical.telefono_movil.slice(2);
          const result = await f.post(p.input); assert.equal(result.statusCode, 201, JSON.stringify(result.body));
          assert.equal(result.body.paciente_id, p.canonical.id_paciente); assert.equal(await db.Paciente.count(), count);
          assert.equal((await p.chat.reload()).patient_id, p.canonical.id_paciente);
        });
        await t.test('a conflicting explicit patient cannot split a lead already owned by another patient', async () => {
          const p = await seed({ shared: true }), before = await f.wholeSnapshot(), observerCount = f.observers.length;
          const result = await f.post({ ...p.input, inicio: '2030-01-16T14:00:00Z', fin: '2030-01-16T14:20:00Z',
            paciente: { id_paciente: p.other.id_paciente, telefono: p.other.telefono_movil } });
          assert.equal(result.statusCode, 409, JSON.stringify(result.body)); assert.equal(result.body.code, 'appointment_lead_patient_mismatch');
          assert.deepEqual(Object.keys(result.body).sort(), ['code', 'message']); assert(!JSON.stringify(result.body).includes(p.canonical.telefono_movil));
          assert.deepEqual(await f.wholeSnapshot(), before); assert.equal(f.observers.length, observerCount);
        });
        await t.test('a changed/unrelated contact cannot create another patient from a lead with captured canonical identity', async () => {
          const p = await seed(), before = await f.wholeSnapshot(), observerCount = f.observers.length;
          const result = await f.post({ ...p.input, inicio: '2030-01-17T14:00:00Z', fin: '2030-01-17T14:20:00Z',
            paciente: { nombre: 'Identidad distinta ficticia', telefono: '34600999881' } });
          assert.equal(result.statusCode, 409, JSON.stringify(result.body)); assert.equal(result.body.code, 'appointment_lead_patient_mismatch');
          assert.deepEqual(await f.wholeSnapshot(), before); assert.equal(f.observers.length, observerCount);
        });
        await t.test('BSUID conversation ownership remains the same patient even when no phone contact_id can be queried', async () => {
          const p = await seed({ opaque: true }), count = await db.Paciente.count();
          const result = await f.post({ ...p.input, inicio: '2030-01-18T14:00:00Z', fin: '2030-01-18T14:20:00Z' });
          assert.equal(result.statusCode, 201, JSON.stringify(result.body)); assert.equal(result.body.paciente_id, p.canonical.id_paciente);
          assert.equal(await db.Paciente.count(), count); assert.equal((await p.chat.reload()).patient_id, p.canonical.id_paciente);
          assert.equal(p.chat.contact_id, 'bsuid:ES.10000' + p.lead.id);
        });
        await t.test('a lead-owned conversation alone also prevents conflicting patient selection when a snapshot is absent', async () => {
          const p = await seed({ snapshot: false, shared: true }), before = await f.wholeSnapshot();
          const result = await f.post({ ...p.input, inicio: '2030-01-21T14:00:00Z', fin: '2030-01-21T14:20:00Z',
            paciente: { id_paciente: p.other.id_paciente, telefono: p.other.telefono_movil } });
          assert.equal(result.statusCode, 409, JSON.stringify(result.body)); assert.equal(result.body.code, 'appointment_lead_patient_mismatch');
          assert.deepEqual(await f.wholeSnapshot(), before);
        });
        await t.test('an explicitly selected different person sharing the phone can book without claiming the other person’s lead or chat', async () => {
          const p = await seed({ shared: true }), count = await db.Paciente.count(), leadBefore = p.lead.toJSON(), chatBefore = p.chat.toJSON();
          const result = await f.post({ ...p.input, lead_intake_id: null, inicio: '2030-01-22T14:00:00Z', fin: '2030-01-22T14:20:00Z',
            paciente: { id_paciente: p.other.id_paciente, telefono: p.other.telefono_movil } });
          assert.equal(result.statusCode, 201, JSON.stringify(result.body)); assert.equal(result.body.paciente_id, p.other.id_paciente);
          assert.equal(result.body.lead_intake_id, null); assert.equal(await db.Paciente.count(), count);
          assert.deepEqual((await p.chat.reload()).toJSON(), chatBefore); assert.deepEqual((await p.lead.reload()).toJSON(), leadBefore);
        });
        await t.test('a true homonym with its own contact and no prior canonical link may still register a distinct patient', async () => {
          const p = await seed(), newLeadId = ++leadId, phone = '34600999882';
          await f.lead(newLeadId, { telefono: phone, nombre: p.canonical.nombre });
          const count = await db.Paciente.count(), chatBefore = p.chat.toJSON();
          const result = await f.post({ ...p.input, lead_intake_id: newLeadId, inicio: '2030-01-23T14:00:00Z', fin: '2030-01-23T14:20:00Z',
            paciente: { nombre: p.canonical.nombre, apellidos: p.canonical.apellidos, telefono: phone } });
          assert.equal(result.statusCode, 201, JSON.stringify(result.body)); assert.notEqual(result.body.paciente_id, p.canonical.id_paciente);
          assert.equal(await db.Paciente.count(), count + 1); assert.deepEqual((await p.chat.reload()).toJSON(), chatBefore);
        });
        await t.test('an explicit different patient also avoids auto-claiming a captured lead when there is no conversation', async () => {
          const p = await seed({ shared: true }); await p.chat.destroy(); const leadBefore = p.lead.toJSON();
          const result = await f.post({ ...p.input, lead_intake_id: null, inicio: '2030-01-24T14:00:00Z', fin: '2030-01-24T14:20:00Z',
            paciente: { id_paciente: p.other.id_paciente, telefono: p.other.telefono_movil } });
          assert.equal(result.statusCode, 201, JSON.stringify(result.body)); assert.equal(result.body.lead_intake_id, null);
          assert.deepEqual((await p.lead.reload()).toJSON(), leadBefore);
        });
        await t.test('four simultaneous forced conflicting requests roll back every patient, NHC, appointment and observer', async () => {
          const p = await seed({ shared: true }), before = await f.wholeSnapshot(), observerCount = f.observers.length;
          const input = { ...p.input, force: true, inicio: '2030-01-25T14:00:00Z', fin: '2030-01-25T14:20:00Z',
            paciente: { id_paciente: p.other.id_paciente, telefono: p.other.telefono_movil } };
          const results = await Promise.all(Array.from({ length: 4 }, () => f.post(input)));
          assert(results.every(r => r.statusCode === 409 && r.body.code === 'appointment_lead_patient_mismatch'), JSON.stringify(results));
          assert.deepEqual(await f.wholeSnapshot(), before); assert.equal(f.observers.length, observerCount);
        });
        await t.test('a conversation owner changed inside booking persistence is rechecked and the entire write is rolled back', async () => {
          const p = await seed({ shared: true }), before = await f.wholeSnapshot();
          const hook = 'owned-canonical-race';
          db.CitaPaciente.addHook('afterCreate', hook, async (row, options) => {
            if (Number(row.lead_intake_id) === p.lead.id) await p.chat.update({ patient_id: p.other.id_paciente }, { transaction: options.transaction });
          });
          try {
            const result = await f.post({ ...p.input, inicio: '2030-01-28T14:00:00Z', fin: '2030-01-28T14:20:00Z' });
            assert.equal(result.statusCode, 409, JSON.stringify(result.body)); assert.equal(result.body.code, 'appointment_lead_patient_mismatch');
            assert.deepEqual(await f.wholeSnapshot(), before);
          } finally { db.CitaPaciente.removeHook('afterCreate', hook); }
        });
        context.report.checks.push('canonical lead patient owner: exact phone, BSUID, explicit conflicts and transactional rollback');
      } finally { await f.close(); }
    });
  });
