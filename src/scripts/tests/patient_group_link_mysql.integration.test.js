'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { createPatientGroupLinkMysqlFixture } = require('./fixtures/patient_group_link_mysql.fixture');

test('group-patient enrolment: audited minimal duplicate DTO, atomic restricted link and real destination booking',
  { skip: process.env.PATIENT_GROUP_LINK_MYSQL_TEST !== '1', timeout: 180000 }, async t => {
    await withIsolatedCampaignMysql(async context => {
      const f = await createPatientGroupLinkMysqlFixture(context), { db } = f;
      let index = 0;
      const foreign = async patch => {
        const n = ++index;
        return db.Paciente.create({ public_id: 'pac_owned_group_' + n, clinica_id: 200, nombre: 'Paciente ficticio', apellidos: 'Grupo ' + n,
          telefono_movil: '34600700' + String(n).padStart(3, '0'), email: 'group' + n + '@example.invalid',
          telefono_secundario: 'PHI_SECONDARY_CANARY', dni: 'PHI_DNI_CANARY', alergias: 'PHI_HEALTH_CANARY',
          notas_paciente: 'PHI_NOTES_CANARY', ...patch });
      };
      const get = (p, query = {}) => f.request('checkDuplicates', { query: { clinica_id: '100', telefono: p.telefono_movil, ...query } });
      const link = (p, body = {}) => f.request('vincularPacienteAClinica', { id: p.id_paciente, body: { clinica_id: '100', contacto: { telefono: p.telefono_movil }, ...body } });
      const linkedCount = p => db.PacienteClinica.count({ where: { paciente_id: p.id_paciente, clinica_id: 100 } });
      const eventCount = p => db.PatientOperationalEvent.count({ where: { patient_id: p.id_paciente, clinic_id: 100, event_type: 'patient.clinic_linked' } });
      const deny = feature_key => db.AccessPolicyOverride.create({ scope_type: 'clinic', scope_id: 100, feature_key, role_code: 'reception', effect: 'deny' });
      const isHidden = dto => { assert.equal(dto.paciente, null); assert.equal(dto.privacy_redacted, true); assert.deepEqual(dto.vinculos, []); };
      try {
        await t.test('GET exposes one minimal same-group identity under durable audit, while origin-sensitive access stays denied', async () => {
          const p = await foreign();
          await db.Clinica.create({ id_clinica: 300, grupoClinicaId: 51, nombre_clinica: 'PHI_UNSEEN_CLINIC_CANARY' });
          await db.PacienteClinica.create({ paciente_id: p.id_paciente, clinica_id: 300, es_principal: false });
          assert.equal(await f.acl.canUserAccessFeature({ actorId: 9001, featureKey: 'patients.sensitive.view', clinicId: 200 }), false);
          const response = await get(p, { telefono: '+34 ' + p.telefono_movil.slice(2) }); assert.equal(response.statusCode, 200, JSON.stringify(response));
          const d = response.body; isHidden(d); assert.equal(d.reuseCandidate, true); assert.equal(d.contactMatch, true);
          assert.deepEqual(Object.keys(d.group_link_candidate).sort(), ['id_paciente', 'public_id', 'nombre', 'apellidos', 'numero_historia', 'clinica_id', 'clinicaNombre'].sort());
          assert.equal(d.group_link_candidate.id_paciente, p.id_paciente); assert.equal(d.group_link_candidate.clinica_id, 200);
          assert(!JSON.stringify(d).includes('PHI_')); assert(!JSON.stringify(d).includes(p.email)); assert(!JSON.stringify(d).includes(p.telefono_movil));
          const audit = f.events.filter(e => e.action === 'patient.duplicate_check' && e.stage === 'completed' && e.outcome === 'success').at(-1);
          assert(audit); assert.deepEqual(audit.clinicIds, ['100', '200']); assert.deepEqual(audit.patientIds, [String(p.id_paciente)]); assert.equal(audit.includesSensitive, true);
          assert.equal(await linkedCount(p), 0);
        });
        await t.test('a create POST 409 reveals neither group candidate nor source identity or clinic label', async () => {
          const p = await foreign(); const response = await f.request('createPaciente', { body: { clinica_id: 100, nombre: 'Otro ficticio', telefono_movil: p.telefono_movil } });
          assert.equal(response.statusCode, 409, JSON.stringify(response)); isHidden(response.body);
          assert.equal(response.body.clinicaNombre, null); assert.equal(response.body.reuseCandidate, false);
          assert(!Object.hasOwn(response.body, 'group_link_candidate'));
          for (const value of [p.nombre, p.numero_historia, p.public_id, 'PHI_']) assert(!JSON.stringify(response.body).includes(value), value);
        });
        await t.test('name-only and fuzzy matches cannot enroll an unseen patient; a matching email works with case normalization', async () => {
          const p = await foreign(); const response = await get(p, { telefono: '', nombre: p.nombre, apellidos: p.apellidos });
          assert.equal(response.statusCode, 200, JSON.stringify(response)); isHidden(response.body); assert.equal(response.body.reuseCandidate, false);
          assert.equal(response.body.contactMatch, false); assert(!response.body.group_link_candidate);
          for (const contacto of [{}, { nombre: p.nombre }, { telefono: p.telefono_movil.slice(0, -1) }, { email: 'other@example.invalid' }]) {
            assert.equal((await link(p, { contacto })).statusCode, 403); assert.equal(await linkedCount(p), 0);
          }
          const email = await get(p, { telefono: '', email: '  ' + p.email.toUpperCase() + '  ' });
          assert.equal(email.statusCode, 200); assert(email.body.group_link_candidate);
          const accepted = await link(p, { contacto: { email: p.email.toUpperCase(), telefono: '34699999999' } });
          assert.equal(accepted.statusCode, 200, JSON.stringify(accepted)); assert.equal(accepted.body.paciente.email, p.email);
          assert(!Object.hasOwn(accepted.body.paciente, 'telefono_movil'));
        });
        await t.test('different and absent groups reject linking even when contacts match', async () => {
          for (const group of [51, null]) {
            const p = await foreign(); await db.Clinica.update({ grupoClinicaId: group }, { where: { id_clinica: 200 } });
            try { assert.equal((await link(p)).statusCode, 403); assert.equal(await linkedCount(p), 0); }
            finally { await db.Clinica.update({ grupoClinicaId: 50 }, { where: { id_clinica: 200 } }); }
          }
          const p = await foreign();
          for (const clinica_id of [true, false, '100abc', 0, -100]) assert.equal((await link(p, { clinica_id })).statusCode, 400);
        });
        await t.test('GET to POST contact changes invalidate the prior proof and preserve source identity and NHC', async () => {
          const p = await foreign(), before = p.toJSON(); assert((await get(p)).body.group_link_candidate);
          await db.Paciente.update({ telefono_movil: '34600888999' }, { where: { id_paciente: p.id_paciente } });
          assert.equal((await link(p)).statusCode, 403); assert.equal(await linkedCount(p), 0);
          const current = await db.Paciente.findByPk(p.id_paciente); assert.equal(current.clinica_id, before.clinica_id); assert.equal(current.numero_historia, before.numero_historia);
        });
        await t.test('group membership and destination permission are rechecked between GET and POST', async () => {
          const p = await foreign(); assert((await get(p)).body.group_link_candidate);
          await db.Clinica.update({ grupoClinicaId: 51 }, { where: { id_clinica: 200 } });
          try { assert.equal((await link(p)).statusCode, 403); } finally { await db.Clinica.update({ grupoClinicaId: 50 }, { where: { id_clinica: 200 } }); }
          for (const feature of ['patients.group.link', 'patients.edit']) {
            const rule = await deny(feature); try {
              const hidden = await get(p);
              if (feature === 'patients.edit') assert.equal(hidden.statusCode, 403);
              else { assert.equal(hidden.statusCode, 200); isHidden(hidden.body); assert(!hidden.body.group_link_candidate); assert.equal(hidden.body.reuseCandidate, false); }
              assert.equal((await link(p)).statusCode, 403); assert.equal(await linkedCount(p), 0);
            }
            finally { await rule.destroy(); }
          }
        });
        await t.test('operational event persistence failure rolls the membership back atomically', async () => {
          const p = await foreign(); f.state.failEvent = true;
          try { const response = await link(p); assert.equal(response.statusCode, 500, JSON.stringify(response)); }
          finally { f.state.failEvent = false; }
          assert.equal(await linkedCount(p), 0); assert.equal(await eventCount(p), 0);
        });
        await t.test('four simultaneous requests with a two-connection pool create exactly one membership and audited event', async () => {
          const p = await foreign(), beforePatients = await db.Paciente.count(), beforeCounter = Number((await db.PatientHistoryCounter.findByPk('group:50')).next_number);
          assert.equal(f.sql.connectionManager.pool.maxSize, 2); f.aclReads.length = 0;
          const responses = await Promise.all(Array.from({ length: 4 }, () => link(p)));
          assert(responses.every(r => r.statusCode === 200), JSON.stringify(responses));
          assert.equal(await linkedCount(p), 1); assert.equal(await eventCount(p), 1); assert.equal(await db.Paciente.count(), beforePatients);
          assert.equal(Number((await db.PatientHistoryCounter.findByPk('group:50')).next_number), beforeCounter);
          assert(f.aclReads.filter(r => r.transaction).length >= 12, 'In-transaction ACL reads must reuse the locking transaction');
          const projected = responses[0].body.paciente; assert.equal(projected.clinica_id, 100); assert.equal(projected.telefono_movil, p.telefono_movil);
          assert(!Object.hasOwn(projected, 'email')); assert(!JSON.stringify(projected).includes('PHI_'));
          const stored = await db.Paciente.findByPk(p.id_paciente); assert.equal(stored.clinica_id, 200); assert.equal(stored.numero_historia, p.numero_historia); assert.equal(stored.email, p.email);
        });
        await t.test('the real booking controller denies the source-only identity, then books its destination projection after enrollment', async () => {
          const p = await foreign(), patientsBefore = await db.Paciente.count();
          const booking = { clinica_id: '100', paciente: { id_paciente: p.id_paciente }, inicio: '2030-01-11T10:00:00Z', fin: '2030-01-11T10:20:00Z',
            doctor_id: 1, instalacion_id: 101, tipo_cita: 'primera_sin_trat' };
          const denied = await f.request('createCita', { body: booking }); assert.equal(denied.statusCode, 404, JSON.stringify({ denied, logs: f.logs }));
          const enrolled = await link(p); assert.equal(enrolled.statusCode, 200); booking.paciente = enrolled.body.paciente;
          const created = await f.request('createCita', { body: booking }); assert.equal(created.statusCode, 201, JSON.stringify({ created, logs: f.logs }));
          assert.equal(created.body.paciente_id, p.id_paciente); assert.equal(created.body.clinica_id, 100); assert.equal(await db.Paciente.count(), patientsBefore);
          assert.equal((await db.Paciente.findByPk(p.id_paciente)).clinica_id, 200); assert.equal(await linkedCount(p), 1);
        });
        await t.test('legacy full-source editing still allows same-group linking without a supplied contact', async () => {
          const p = await foreign(); const membership = await db.UsuarioClinica.create({ id_usuario: 9001, id_clinica: 200, rol_clinica: 'propietario' });
          try {
            const d = await get(p); assert.equal(d.statusCode, 200); assert.equal(d.body.privacy_redacted, false); assert.equal(d.body.paciente.id_paciente, p.id_paciente);
            const response = await link(p, { contacto: {} }); assert.equal(response.statusCode, 200, JSON.stringify(response)); assert.equal(await linkedCount(p), 1);
          } finally { await membership.destroy(); }
        });
        await t.test('audit outage never returns candidate identity', async () => {
          const p = await foreign(); f.state.failAudit = true;
          try { const response = await get(p); assert.equal(response.statusCode, 503, JSON.stringify(response)); assert(!JSON.stringify(response).includes(p.public_id)); }
          finally { f.state.failAudit = false; }
        });
        await t.test('a contact changed while audit commits discards the prepared identifying response', async () => {
          const p = await foreign(); let changed = false;
          f.state.onAudit = async event => {
            if (!changed && event.action === 'patient.duplicate_check' && event.stage === 'completed' && event.outcome === 'success') {
              changed = true; await db.Paciente.update({ telefono_movil: '34600888888' }, { where: { id_paciente: p.id_paciente } });
            }
          };
          try { const response = await get(p); assert.equal(response.statusCode, 403, JSON.stringify(response)); assert(!JSON.stringify(response).includes(p.public_id)); }
          finally { f.state.onAudit = null; }
          assert(changed); assert(f.events.some(e => e.action === 'patient.duplicate_check' && e.stage === 'discarded' && e.reason === 'access_changed'));
        });
        context.report.checks.push('patient-group-link: exact contact, scoped DTO, durable audit, transactional ACL/event/link, pool2/concurrency4, actual linked-patient booking');
      } finally { await f.close(); }
    });
  });
