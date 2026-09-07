# ClinicCloud: reconciliación offline y revisión

Este adaptador **no importa en la base ni activa mensajes**. Lee fuentes, captura
opcionalmente un snapshot local en transacción READ ONLY, calcula diferencias y
prepara comandos revisados. No carga modelos, Express, Redis ni workers.

## Ejecutar

Desde `back-dev`, primero el snapshot explícitamente acotado:

```sh
node src/scripts/cliniccloud-import-snapshot.js \
  --source-account cliniccloud-5880 --clinic-ids 66,72 \
  --coverage-start 2026-08-01 --coverage-end 2026-12-31 \
  --historical-dir /home/ubuntu/secure-imports/clinic-real-20260722/review/backup_data \
  --private-output /home/ubuntu/secure-imports/cliniccloud-snapshot-NUEVO.json
```

Después, el plan (sin snapshot solo es inventario, no reconciliación local):

```sh
node src/scripts/cliniccloud-import-plan.js \
  --source-account cliniccloud-5880 \
  --coverage-start 2026-08-01 --coverage-end 2026-12-31 \
  --contacts /home/ubuntu/frontend_clinicaclick/temp/BACKUP_CONTACTOS_2026-09-05.csv \
  --appointments /home/ubuntu/frontend_clinicaclick/temp/BACKUP_CITAS_2026-08-01_2026-12-31.csv \
  --alerts /home/ubuntu/frontend_clinicaclick/temp/Alertas.xlsx \
  --historical-dir /home/ubuntu/secure-imports/clinic-real-20260722/review/backup_data \
  --local-snapshot /home/ubuntu/secure-imports/cliniccloud-snapshot-NUEVO.json \
  --private-output /home/ubuntu/secure-imports/cliniccloud-plan-NUEVO.json
```

No se sobrescriben artefactos existentes. Los resultados completos solo se
escriben bajo `/home/ubuntu/secure-imports` (raíz 0700, archivos 0600). stdout
contiene únicamente hashes y agregados; no copiar fuentes/planes al repositorio,
temp del frontend, almacenamiento público ni logs de aplicación. No existe flag
`--execute`, `--apply` o `--activate`.

## Invariantes efectivas

- IDCONTACTO es identidad externa; NUM es número de historia. Alertas usan NUM.
- Una fila CSV sin IDCITA no adquiere un ID externo inventado. Coincidencias
  únicas recuperan el histórico; huella/fila permiten trazabilidad y repetición.
- Igual paciente/hora no basta: estado, agenda y servicio pueden distinguir citas.
  Exactas nativas se enlazan sin crear otra; duplicados nativa/importada y cambios
  de fecha quedan explícitos en la revisión.
- El CSV manda dentro de su cobertura, además de las citas nativas. Ausencias
  importadas proponen `supersede_candidate`, nunca borrado físico ni no asistencia.
  Fuera de cobertura y nativas se preservan. Todas las propuestas requieren writer
  transaccional y guardas frescas antes de aplicarlas.
- Campos fuente vacíos no borran cabina/profesional existentes. Contactos utilizan
  comparación de tres versiones y no sustituyen cambios locales silenciosamente.
- WHATSAPP está excluido de campos, permisos, bloqueos y decisiones. Sus bytes
  originales permanecen únicamente en el archivo fuente. Opt-outs locales no se
  consultan ni modifican por este adaptador.
- BLOQUEO no es cita de paciente. Alertas no ocupan agenda; su fecha es de aviso,
  no se resta otro mes ni se inventa fecha clínica objetivo.
- Europe/Madrid: se rechazan horas ambiguas/inexistentes del cambio horario.
- `choosePrimaryClinic` aplica primer tratamiento con pago acreditado; a falta de
  él, primer tratamiento registrado. Estado histórico 3 no acredita pago por sí
  mismo; un empate de clínicas necesita resolución explícita.

## Contrato de revisión

El JSON privado de revisión contiene `plan_sha256`, `reviewed_by`, `reviewed_at`
y `decisions`. Cada decisión refiere un `action_key` del plan; requiere motivo.
Disposiciones disponibles:

| Disposición | Datos adicionales | Efecto preparado |
| --- | --- | --- |
| `defer` | — | Sigue pendiente. |
| `preserve` | `reason` | Registrar conservación explícita. |
| `map_patient` | `local_patient_id`, `reason` | Enlazar ID fuente a paciente real; no sobrescribe sus campos. |
| `link_appointment` | `local_appointment_id`, `reason` | Enlazar cita existente, incluida nativa, sin cambiar agenda/estado. |
| `upsert_appointment` | `local_patient_id`, `assignment`, `reason`; `local_appointment_id` opcional | Alta o actualización de importada, nunca nativa. |
| `supersede` | `reason` | Solo para una ausencia importada propuesta dentro del intervalo. |
| `import_followup` | `clinic_id`, `local_patient_id` opcional, `reason` | Seguimiento HOLD con fecha administrativa original. |

`assignment` requiere `clinic_id`, `doctor_id`, `installation_id`, `treatment_id`
y `appointment_type` canónico. Una actualización puede heredar IDs ya existentes;
el tipo debe ser explícito. En un enlace/upsert, `superseded_local_ids` permite
identificar duplicados **importados** del mismo paciente dentro de cobertura;
conserva historia y apunta al canónico. No permite retirar nativas ni citas fuera
de cobertura. No hay creación automática de pacientes por teléfono o email.

```sh
node src/scripts/cliniccloud-import-review.js \
  --plan /home/ubuntu/secure-imports/cliniccloud-plan-NUEVO.json \
  --local-snapshot /home/ubuntu/secure-imports/cliniccloud-snapshot-NUEVO.json \
  --review /home/ubuntu/secure-imports/cliniccloud-decisiones-NUEVO.json \
  --private-output /home/ubuntu/secure-imports/cliniccloud-comandos-NUEVO.json
```

El compilador verifica hashes de plan/snapshot y conflictos entre decisiones.
El paquete resultante mantiene `executable: false`: antes de aplicarlo falta el
writer común de agenda, validar permisos/scope, recursos, concurrencia, vigencia
del snapshot y ledger idempotente. No basta cambiar ese booleano. Los comandos
transportan hash esperado, motivo y procedencia para esa integración, sin SQL.

## Pruebas

```sh
node --test src/scripts/tests/cliniccloud_import.test.js
```

Pruebas puras con datos sintéticos. El lector XLSX solo requiere Python 3 estándar.
No se añaden dependencias a la aplicación. Los planes y snapshots reales nunca
son fixtures de tests.

## Catálogo Excel

```sh
node src/scripts/cliniccloud-import-catalog-plan.js \
  --workbook /home/ubuntu/frontend_clinicaclick/temp/BASE_DE_DATOS_TRATAMIENTOS_y_BS_MEDICAL-CAPILAR-actualizado.xlsx \
  --read-local-catalog true \
  --private-output /home/ubuntu/secure-imports/cliniccloud-catalogo-NUEVO.json
node --test src/scripts/tests/cliniccloud_import_catalog.test.js
```

Lee personal/instalaciones/catálogo existentes en READ ONLY, sin credenciales ni
datos de pacientes en resultados. `--resource-map` admite JSON privado con
`cabins: {"C7": ID}` y `professionals: {"Dr. Camacho": ID}` para equivalencias
explícitamente validadas. Números coincidentes de cabinas y nombres parciales de
profesional solo son candidatos, no equivalencias físicas o de identidad.

Clasifica actos, complementos, programas, bonos, honorarios y productos. No crea
agenda para prótesis sueltas/honorarios ni interpreta tres sesiones de 30 minutos
como una cita de 90. Los 37 precios de bonos adicionales se extraen solo de Bono5/
Bono10, nunca de Sale a/Ahorro. Hilos requieren cantidad y preparación; cirugía
capilar requiere Loza y Ainhoa. Plexr/C7 y bariátrica/Hospital aplican decisiones
expresas del usuario. Los perfiles candidatos permanecen draft y el importe bruto
se conserva como metadato: `do_not_write_price_base: true` hasta resolver el campo
económico canónico. No cambia ninguna instalación, profesional o tratamiento.
