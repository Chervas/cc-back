# Informes clinicos de cita

> Implementado en `dev` el 2026-07-25.
> Prefijo API: `/api/citas`.
> Migracion: `20260725090000-expand-clinical-accounting-workflows.js`.

## Objetivo

Cada cita puede conservar un informe clinico estructurado visible desde la
cita y desde la historia clinica del paciente. No sustituye adjuntos,
consentimientos ni workspaces por area.

Campos: motivo, resumen, hallazgos, intervenciones, resultado, plan, siguientes
pasos y notas privadas.

En historia clinica, la tarjeta prioriza el motivo de la visita, resume lo
comentado y deja tratamiento y profesional como contexto secundario. En
pacientes compartidos respeta la clinica seleccionada en `clinica_id` antes de
usar la clinica primaria del paciente.

## Ciclo de vida

- El primer guardado crea un borrador version 1.
- Cada edicion incrementa la version y guarda un snapshot en
  `AppointmentClinicalReportRevisions`.
- Finalizar deja el informe inmutable.
- Reabrir es una accion explicita y crea una nueva revision.

## API

- `GET /clinical-reports/patient/:patientId?clinic_id=`
- `GET /:appointmentId/clinical-report`
- `PUT /:appointmentId/clinical-report`
- `POST /:appointmentId/clinical-report/finalize`

Lectura y escritura usan `clinical.reports.view` y
`clinical.reports.manage`. El scope se valida por cita, paciente y clinica. Las
consultas relacionadas se ejecutan por separado y se componen con mapas; no
se usa `LEFT JOIN`.

## Privacidad y rollback

El informe forma parte de la historia clinica y no se expone al portal de
gestoria. No se envia a servicios externos. El rollback de la migracion elimina
informes y revisiones, por lo que no debe ejecutarse cuando existan datos
clinicos que deban conservarse.
