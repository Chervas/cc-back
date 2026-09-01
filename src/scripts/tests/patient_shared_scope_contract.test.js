#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const db = require('../../../models');
const pacienteController = require('../../controllers/paciente.controller');

async function main() {
  const scoped = pacienteController.__patientClinicScopeContract.restrictPacientePayloadToClinics({
    id_paciente: 901,
    clinica_id: 55,
    clinica: { id_clinica: 55, nombre_clinica: 'Sede ajena' },
    clinicasVinculadas: [
      { clinica_id: 56, clinica: { id_clinica: 56, nombre_clinica: 'Sede visible' } },
      { clinica_id: 57, clinica: { id_clinica: 57, nombre_clinica: 'Otra sede ajena' } },
    ],
    relaciones: [{
      relacionado: {
        id_paciente: 902,
        clinica_id: 57,
        clinica: { id_clinica: 57, nombre_clinica: 'Otra sede ajena' },
      },
    }],
  }, [56]);

  assert.equal(scoped.clinica_id, 56, 'la ficha usa una sede visible como contexto operativo');
  assert.equal(scoped.clinica.id_clinica, 56);
  assert.deepEqual(scoped.clinicasVinculadas.map((link) => link.clinica_id), [56]);
  assert.equal(scoped.scope_limited, true);
  assert.equal(scoped.relaciones[0].relacionado.clinica_id, null);
  assert.equal(scoped.relaciones[0].relacionado.clinica, null);
  assert.equal(scoped.relaciones[0].relacionado.nombre, 'Paciente');
  assert.equal(scoped.relaciones[0].relacionado.privacy_redacted, true);

  const source = fs.readFileSync(
    path.resolve(__dirname, '../../controllers/paciente.controller.js'),
    'utf8',
  );
  assert.match(
    source,
    /getPacienteAppointmentBounds = async \(pacienteId, clinicIds\)[\s\S]*?clinica_id: \{ \[Op\.in\]: readableClinicIds \}/,
    'las citas previa/siguiente deben quedar filtradas por las clínicas visibles',
  );
  assert.match(
    source,
    /citas_pasadas_count: Number\(pastCount \|\| 0\)/,
    'el resumen del paciente debe exponer un contador de citas pasadas para la ficha compacta',
  );
  assert.match(
    source,
    /CitaPaciente\.findAll\(\{[\s\S]*?clinica_id: \{ \[Op\.in\]: readableClinicIds \}/,
    'la actividad de citas debe quedar filtrada por las clínicas visibles',
  );
  const patientListBlock = source.slice(
    source.indexOf('exports.getAllPacientes'),
    source.indexOf('exports.searchPacientes'),
  );
  assert.match(
    patientListBlock,
    /const scopedPatients = pacientes\.map\(\(paciente\) => \([\s\S]*?restrictPacientePayloadToClinics\(paciente, readableClinicIds\)/,
    'el listado debe ocultar vínculos y relaciones de clínicas fuera del scope aunque el actor vea PII',
  );
  assert.doesNotMatch(
    patientListBlock,
    /getPacienteAppointmentBounds/,
    'el listado no debe hidratar límites de citas del paciente',
  );
  const patientSearchBlock = source.slice(
    source.indexOf('exports.searchPacientes'),
    source.indexOf('exports.checkDuplicates'),
  );
  assert.match(
    patientSearchBlock,
    /res\.json\(pacientes\.map\(\(paciente\) => \([\s\S]*?restrictPacientePayloadToClinics\(paciente, clinicIdsList\)/,
    'la búsqueda identificativa debe ocultar vínculos de clínicas fuera del scope solicitado',
  );
  assert.match(
    source,
    /COALESCE\(i\.clinica_id, l\.clinica_id\) IN \(:readableClinicIds\)/,
    'la actividad de reseñas debe quedar filtrada por las clínicas visibles',
  );
  assert.match(
    source,
    /PatientNutritionReport\.findAll\(\{[\s\S]*?clinic_id: \{ \[Op\.in\]: nutritionClinicIds \}/,
    'la actividad nutricional debe quedar filtrada por las clínicas autorizadas',
  );
  assert.match(
    source,
    /accessibleClinicIds\(req, 'consents\.view', patientClinicIds\(paciente\), \{ requireAll: true \}\)/,
    'los consentimientos legacy globales no deben exponerse con alcance parcial',
  );
  assert.match(
    source,
    /buildPacienteDuplicadoPayloadForRequest[\s\S]*?patients\.sensitive\.view[\s\S]*?privacy_redacted: true/,
    'los duplicados de otra sede deben detectarse sin revelar su ficha si el actor no tiene acceso sensible',
  );
  assert.match(
    source,
    /if \(tutor\?\.id_paciente_relacionado\)[\s\S]*?featureKey: 'patients\.sensitive\.view'[\s\S]*?Tutor no encontrado/,
    'crear una tutoría debe exigir visibilidad sensible sobre la ficha del tutor',
  );

  console.log('patient shared scope contract: ok');
}

main()
  .then(() => db.sequelize.close())
  .catch(async (error) => {
    console.error(error);
    await db.sequelize.close().catch(() => {});
    process.exitCode = 1;
  });
