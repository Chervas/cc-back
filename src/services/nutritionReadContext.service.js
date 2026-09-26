'use strict';

const id = value => ['number', 'string'].includes(typeof value) && /^[1-9]\d*$/.test(String(value))
  && Number.isSafeInteger(Number(value)) ? Number(value) : null;
const forbidden = () => Object.assign(new Error('access_policy_forbidden'), { status: 403 });
const notFound = () => Object.assign(new Error('measurement_not_found'), { status: 404 });

// A shared patient identity is not a grant to the clinical history of every
// clinic in its group. Resolve permissions once, before selecting any values.
function createNutritionReadContextResolver({ db, getAccessibleClinicIdsForFeature, assertUserCanAccessFeature }) {
  return async ({ patient, actorUserId, clinicId = null, measurement = null, featureKey = null }) => {
    const actorId = id(actorUserId);
    if (!actorId) throw Object.assign(new Error('auth_failed'), { status: 401 });
    const links = await db.PacienteClinica.findAll({ where: { paciente_id: patient.id_paciente }, attributes: ['clinica_id'] });
    const memberships = [...new Set([patient.clinica_id, ...links.map(link => link.clinica_id)].map(id).filter(Boolean))];
    const grants = await Promise.all(['patients.view', 'patients.sensitive.view', 'nutrition.workspace.view']
      .map(featureKey => getAccessibleClinicIdsForFeature({ actorId, featureKey, clinicIds: memberships })));
    const readableClinicIds = memberships.filter(clinic => grants.every(allowed => allowed.includes(clinic)));
    if (!readableClinicIds.length) throw forbidden();
    if (clinicId !== null && clinicId !== undefined && !id(clinicId)) {
      throw Object.assign(new Error('Revisa la clínica seleccionada.'), { status: 400, code: 'nutrition_clinic_id_invalid' });
    }
    if (measurement && (Number(measurement.patient_id) !== Number(patient.id_paciente)
      || !readableClinicIds.includes(Number(measurement.clinic_id)))) throw notFound();
    const targetClinicId = id(clinicId) || Number(measurement?.clinic_id)
      || (readableClinicIds.includes(Number(patient.clinica_id)) ? Number(patient.clinica_id) : readableClinicIds[0]);
    if (!readableClinicIds.includes(targetClinicId)) throw forbidden();
    if (measurement && targetClinicId !== Number(measurement.clinic_id)) throw notFound();
    if (featureKey) await assertUserCanAccessFeature({ actorId, featureKey, clinicId: targetClinicId });
    return { patientId: Number(patient.id_paciente), clinicId: targetClinicId, readableClinicIds };
  };
}

// Cached HTML/PDF can contain comparisons and projections from OTHER clinics.
// Validate both immutable provenance and the current patient/clinic ownership
// of every contributing measurement. Never relabel a restricted final report.
function nutritionSnapshotDependencies(row) {
  let snapshot = row?.snapshot_json;
  if (typeof snapshot === 'string') { try { snapshot = JSON.parse(snapshot); } catch { return null; } }
  if (!snapshot || snapshot.kind !== 'nutrition_measurement_report' || Number(snapshot.snapshot_version) !== 15
    || Number(snapshot.patient?.id) !== Number(row.patient_id)
    || Number(snapshot.measurement?.id) !== Number(row.measurement_id)
    || Number(snapshot.report?.measurement_id) !== Number(row.measurement_id)) return null;
  const measurements = [snapshot.measurement, ...(snapshot.previous_measurement ? [snapshot.previous_measurement] : [])];
  if (measurements.some(item => !id(item.id) || !id(item.clinic_id)
    || Number(item.patient_id) !== Number(row.patient_id))) return null;
  const measurementIds = measurements.map(item => Number(item.id));
  const clinicIds = [row.clinic_id, snapshot.patient.clinic_id, ...measurements.map(item => item.clinic_id)];
  if (snapshot.appointment && (!id(snapshot.appointment.clinica_id)
    || !clinicIds.map(Number).includes(Number(snapshot.appointment.clinica_id)))) return null;
  if (snapshot.report.comparison?.available) measurementIds.push(snapshot.report.comparison.previous_measurement_id);
  const projection = snapshot.projection;
  if (projection?.available) {
    if (!Array.isArray(projection.metric_projections) || !projection.metric_projections.length
      || !Array.isArray(projection.based_on_measurement_ids) || !projection.based_on_measurement_ids.length) return null;
    measurementIds.push(...projection.based_on_measurement_ids);
    for (const metric of projection.metric_projections) measurementIds.push(metric.previous_measurement_id, metric.current_measurement_id);
  }
  // Added to new snapshots without rewriting the historical ones.
  const sources = snapshot.meta?.source_measurements;
  if (sources !== undefined) {
    if (!Array.isArray(sources) || !sources.length) return null;
    for (const source of sources) { measurementIds.push(source.id); clinicIds.push(source.clinic_id); }
  }
  if (measurementIds.some(value => !id(value)) || clinicIds.some(value => !id(value))) return null;
  return { measurementIds: [...new Set(measurementIds.map(Number))], clinicIds: [...new Set(clinicIds.map(Number))] };
}

function isNutritionSnapshotReadable(row, context, measurementClinics) {
  const dependencies = nutritionSnapshotDependencies(row);
  return Number(row?.patient_id) === context.patientId && dependencies !== null
    && dependencies.clinicIds.every(clinic => context.readableClinicIds.includes(clinic))
    && dependencies.measurementIds.every(measurement => context.readableClinicIds.includes(measurementClinics.get(measurement)));
}

module.exports = { createNutritionReadContextResolver, nutritionSnapshotDependencies, isNutritionSnapshotReadable };
