'use strict';
const { QueryTypes } = require('sequelize');
const snapshots = require('../lib/review-care-snapshot');
const { resolveLastAttendedAppointmentDate } = require('../lib/marketing-template-variables');
const { parseImportedCareDate } = require('../lib/marketing-import-care-date');
const { createPatientLastCareReader, createSqlPatientLastCareRepository } = require('./patientLastCare.service');

const chunks = (values, size = 200) => Array.from({ length: Math.ceil(values.length / size) }, (_, i) => values.slice(i * size, (i + 1) * size));
const plain = value => value?.get ? value.get({ plain: true }) : value;
const failure = (code, message, status = 403) => Object.assign(Error(message), { code, status });

function createReviewCareContext({ db, access, createReader = createPatientLastCareReader } = {}) {
  const query = (sql, replacements) => db.sequelize.query(sql, { replacements, type: QueryTypes.SELECT, logging: false });
  const repository = createSqlPatientLastCareRepository({ query });

  // Same global-patient predicate as patientImportHeld. A retained identity in
  // another site cannot be bypassed by selecting this site's latest service.
  async function heldPatientIds(patientIds) {
    const ids = [...new Set(patientIds.map(Number).filter(id => Number.isSafeInteger(id) && id > 0))];
    const held = new Set();
    for (const batch of chunks(ids)) {
      let rows;
      try { rows = await query(`SELECT patient_id FROM PatientImportedIdentities
        WHERE patient_id IN (:patientIds) AND messages_hold=1
        UNION SELECT paciente_id AS patient_id FROM PatientCustomFields
        WHERE paciente_id IN (:patientIds) AND source='cliniccloud' AND JSON_VALID(value)
          AND (JSON_UNQUOTE(JSON_EXTRACT(IF(JSON_VALID(value),value,'{}'),'$.import.automation_policy'))='hold'
            OR JSON_EXTRACT(IF(JSON_VALID(value),value,'{}'),'$.import.messages_enabled')=CAST('false' AS JSON))`, { patientIds: batch }); }
      catch (_) { throw failure('review_care_hold_unavailable', 'No se pudo comprobar la retención de comunicaciones. Inténtalo de nuevo.', 503); }
      for (const row of rows) held.add(Number(row.patient_id));
    }
    return held;
  }

  async function enrichCore(items, scope) {
    const authority = scope?.reviewCareAuthority;
    // Legacy background creation keeps its existing contract. New clinical
    // projections can only originate in a verified administrative request.
    if (!authority || typeof authority.authorize !== 'function') return items;
    const allowed = new Set(scope.clinicIds || []), byClinic = new Map();
    for (const value of items) {
      const item = plain(value), patientId = Number(item?.paciente_id), clinicId = Number(item?.clinica_id);
      if (!Number.isSafeInteger(patientId) || patientId <= 0) continue;
      if (!allowed.has(clinicId)) throw failure('review_care_scope_invalid', 'El paciente no pertenece al ámbito seleccionado');
      if (!byClinic.has(clinicId)) byClinic.set(clinicId, []);
      byClinic.get(clinicId).push(patientId);
    }
    const care = new Map();
    for (const [clinicId, patientIds] of byClinic) {
      const reader = createReader({ repository, authorize: input => authority.authorize(input) });
      for (const batch of chunks([...new Set(patientIds)], 10000)) {
        const result = await reader.read({ clinicId, patientIds: batch });
        for (const row of result.items) care.set(`${row.patientId}:${row.clinicId}`, row);
      }
    }
    const held = await heldPatientIds([...care.values()].map(row => row.patientId));
    const pairs = [...care.values()].map(row => ({ patientId: row.patientId, clinicId: row.clinicId }));
    for (const batch of chunks(pairs, 1000)) await access.assertPatientPairs({ pairs: batch });
    // Recheck after HOLD reads too; no permission decision is cached across requests.
    for (const clinicId of byClinic.keys()) await authority.authorize({ clinicId, phase: 'after' });
    return items.map(value => {
      const item = plain(value), detail = care.get(`${Number(item?.paciente_id)}:${Number(item?.clinica_id)}`);
      if (!detail) return !String(item.status || '').startsWith('excluded') && !Number(item.paciente_id)
        ? { ...item, status: 'excluded_patient_missing', selected: false, exclusion_reason: 'paciente_no_registrado',
          reason: 'Registra o vincula el paciente antes de solicitarle una reseña.' } : item;
      const oldDate = parseImportedCareDate(resolveLastAttendedAppointmentDate(item));
      let latest = detail.latestCare;
      if (oldDate.status === 'valid' && (!latest || oldDate.date > latest.date)) {
        latest = { date: oldDate.date, kind: 'declared_care_date', precision: 'day', provenance: [] };
      }
      const snapshot = latest ? snapshots.sealCareSnapshot({ care: { ...detail, latestCare: latest,
        importedMessagesHold: held.has(detail.patientId) }, item, listId: item.list_id ?? null,
        actorId: authority.actorId }) : null;
      return { ...item,
        custom_fields: { ...snapshots.stripCareSnapshot(item.custom_fields), ...(snapshot ? { [snapshots.KEY]: snapshot } : {}) },
        ...(!String(item.status || '').startsWith('excluded') && held.has(detail.patientId) ? { status: 'excluded_import_hold', selected: false,
          exclusion_reason: 'importacion_comunicaciones_retenidas',
          reason: 'Comunicaciones retenidas en la importación. La fecha de atención se conserva; este paciente no está habilitado para el envío.' }
          : !String(item.status || '').startsWith('excluded') && !latest ? { status: 'excluded_no_performed_care', selected: false,
            exclusion_reason: 'sin_atencion_realizada', reason: 'Sin atención realizada registrada en esta clínica.' } : {}),
      };
    });
  }

  async function guardCore({ list, items = [], scope, actorId, background = false, checkHold = false } = {}) {
    const protectedItems = items.filter(snapshots.hasCareSnapshot);
    const protectedList = Number(list?.criteria?.review_care_version) === 1;
    if (!protectedList && !protectedItems.length) return;
    const pairs = (protectedList ? items : protectedItems).map(value => { const item = plain(value);
      return { patientId: Number(item.paciente_id), clinicId: Number(item.clinica_id) }; })
      .filter(pair => Number.isSafeInteger(pair.patientId) && pair.patientId > 0);
    const clinicIds = [...new Set(pairs.map(pair => pair.clinicId))];
    if (!clinicIds.length) clinicIds.push(...(scope?.clinicIds || []));
    const authority = scope?.reviewCareAuthority;
    async function verify(phase) {
      if (authority?.authorize) {
        for (const clinicId of clinicIds) await authority.authorize({ clinicId, phase });
      } else if (background) {
        const creator = Number(list?.criteria?.review_care_actor_id || list?.created_by || 0);
        if (!creator) throw failure('review_care_authority_required', 'La campaña necesita una autorización válida para consultar la atención.');
        await access.assertActorClinics({ actorId: creator, clinicIds });
      } else throw failure('review_care_authority_required', 'La campaña necesita una autorización válida para consultar la atención.');
    }
    await verify('before');
    for (const batch of chunks(pairs, 1000)) await access.assertPatientPairs({ pairs: batch });
    for (const item of protectedItems) snapshots.validateCareSnapshot(item, list);
    if (checkHold) {
      const held = await heldPatientIds(pairs.map(pair => pair.patientId));
      if (held.size) throw failure('review_care_messages_held', 'Las comunicaciones de este paciente siguen retenidas por la importación.', 409);
      if (protectedList && items.some(value => !snapshots.hasCareSnapshot(value))) {
        throw failure('review_care_evidence_required', 'Comprueba la atención realizada del paciente antes de preparar este envío.', 409);
      }
    }
    for (const batch of chunks(pairs, 1000)) await access.assertPatientPairs({ pairs: batch });
    await verify('after');
  }
  function patientPairs(items) {
    return items.map(value => { const item = plain(value); return { patientId: Number(item.paciente_id), clinicId: Number(item.clinica_id) }; })
      .filter(pair => Number.isSafeInteger(pair.patientId) && pair.patientId > 0);
  }
  async function audited(items, scope, work) {
    const authority = scope?.reviewCareAuthority;
    if (!authority?.auditRead) return work();
    const pairs = patientPairs(items);
    const clinicIds = [...new Set(pairs.length ? pairs.map(pair => pair.clinicId) : (scope.clinicIds || []))];
    const revalidate = async () => {
      for (const batch of chunks(pairs, 1000)) await access.assertPatientPairs({ pairs: batch });
      for (const clinicId of clinicIds) await authority.authorize({ clinicId, phase: 'after' });
    };
    return authority.auditRead({ revalidate, work: async () => ({ value: await work(), metadata: {
      clinicIds, patientIds: [...new Set(pairs.map(pair => pair.patientId))], resultCount: items.length, includesSensitive: pairs.length > 0,
    } }) });
  }
  async function enrich(items, scope) {
    if (items.length > 10000) {
      const combined = [];
      for (const batch of chunks(items, 10000)) combined.push(...await enrich(batch, scope));
      return combined;
    }
    return audited(items, scope, () => enrichCore(items, scope));
  }
  async function guard(input = {}) {
    const items = input.items || [];
    if (Number(input.list?.criteria?.review_care_version) !== 1 && !items.some(snapshots.hasCareSnapshot)) return;
    if (items.length > 10000) {
      for (const batch of chunks(items, 10000)) await guard({ ...input, items: batch });
      return;
    }
    return audited(items, input.scope, () => guardCore(input));
  }
  return { enrich, guard, heldPatientIds };
}

let instance;
function current() {
  instance ||= createReviewCareContext({ db: require('../../models'), access: require('./reviewCareAccess.service').current() });
  return instance;
}
module.exports = { createReviewCareContext, current };
