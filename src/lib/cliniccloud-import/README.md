# ClinicCloud: reconciliación offline y revisión

El adaptador de planificación **no importa en la base ni activa mensajes**. Lee fuentes, captura
opcionalmente un snapshot local en transacción READ ONLY, calcula diferencias y
prepara comandos revisados. No carga modelos, Express, Redis ni workers.

Desde el corte del 2026-09-07 hay ejecutores **separados y acotados**, no un
`apply` genérico del plan. Contactos existentes, adscripción/seguimientos,
altas nuevas, HOLD de citas y manual corporal tienen preparación, aprobación por huella,
backup y diario privado. Ninguno activa recordatorios, publica protocolos,
vende programas ni resuelve automáticamente los candidatos ambiguos.

## Ejecutar

Desde `back-dev`, primero el snapshot explícitamente acotado:

```sh
node src/scripts/cliniccloud-import-snapshot.js \
  --target crm \
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
temp del frontend, almacenamiento público ni logs de aplicación. El planificador
no acepta `--execute`, `--apply` ni `--activate`; los ejecutores inferiores sí
requieren un modo de aplicación explícito y su propio paquete validado.

## Ejecutores acotados

- `cliniccloud-import-contact-aliases.js`: `--target crm --mode prepare`
  con `--contacts`, `--review` y `--private-output`. La revisión privada contiene
  `reviewed_by` y `links` con `source_contact_id`/`patient_id`. Exige coincidencia
  única de nombre completo y teléfono, sin contradicción de DNI/nacimiento;
  ID fuente único y sin otro propietario en el grupo. `--mode apply` añade
  `--package`, `--approved-sha256`, `--backup-manifest` y `--private-journal`.
  Solo inserta un campo adicional `source_column=idContacto`, conservando IDs,
  datos, clínica principal, historia y snapshots previos. Paquete de dos horas,
  backup CRM verificado, bloqueo/CAS, diario durable y replay sin nuevas filas.
  No es un fusor de pacientes ni acepta parecidos de nombre como identificación.
  Para un apellido de captación abreviado/distinto, cada enlace puede llevar una
  revisión explícita `native_first_visit` (`source_row`, `appointment_id`,
  `created_by`, `clinic_id`, `reason`). Añadir `--appointments`, `--plan` y
  `--live-comparison`: CSV normalizado idéntico al plan, comparación íntegra de
  menos de dos horas con un único ID real observado en ClinicCloud y teléfono
  exclusivo en el export. Además exige nombre de pila exacto, teléfono exclusivo
  en el grupo y una sola primera visita nativa en esa clínica e instante,
  creada por la persona revisada. Bloquea y coteja también la cita, sin editarla.
  DNI/nacimiento contradictorios, otro propietario o cualquier deriva impiden
  escribir. No transforma esa prueba de identidad en una decisión de sustituir
  o duplicar citas. Los paquetes nuevos usan versión 2; replay de versión 1
  mantiene su comprobación estricta original.
- `cliniccloud-import-physical-installations.js`: mapa físico documental BS,
  distinto de las antiguas agendas virtuales. `--target crm --mode prepare
  --sources … --private-output …` recibe una lista privada de archivos y hashes.
  `--mode apply --package … --approved-sha256 … --backup-manifest …
  --private-journal …` crea cabinas inactivas y aliases físicos entre clínicas.
  No cambia instalaciones antiguas, horarios, citas ni flags; Hospital queda
  pendiente de capacidad externa. Requiere activar después únicamente el mapa
  conciliado. Si se repite un paquete ya aplicado, el cambio de estado exige
  revisar el diario en lugar de crear duplicados. El plan de catálogo acepta
  `cabins_by_clinic` para resolver cada sala compartida al ID de su clínica.
- `cliniccloud-import-contacts-apply.js`: solo parches no vacíos de contactos
  enlazados inequívocamente y sin conflictos de comparación a tres versiones.
  `--mode prepare --plan … --snapshot … --private-output …` captura antes e
  identidad; `--mode apply --package … --approved-sha256 … --backup-manifest …
  --private-output …` aplica una transacción de hasta 200 registros, compara
  todas las columnas antes/después y no crea ni fusiona pacientes. Diario
  persistido antes de SQL; ausencia de resultado tras un crash exige revisión
  manual, no replay ciego. Los campos permitidos son nombre, apellidos, email,
  teléfono, DNI y nacimiento. WhatsApp y clínica principal quedan excluidos.
- Adscripción/membresías y seguimientos: [PRIMARY_FOLLOWUPS_APPLY](./PRIMARY_FOLLOWUPS_APPLY.md).
  Revisiones canónicas importadas y actor técnico `NULL`, nunca un usuario
  humano inventado; estados históricos y fechas administrativas conservados.
- Altas nuevas: [NEW_PATIENTS_APPLY](./NEW_PATIENTS_APPLY.md). Solo identidades
  revisadas sin colisión en el grupo, fuentes nuevas ni histórico; número de
  historia independiente, fechas válidas y evidencia de clínica principal.
  Una transacción para ficha, membresías y trazabilidad; ninguna cita ni mensaje.
  Conserva por separado la línea base original y los valores normalizados
  almacenados: reimportar el mismo CSV no propone cambios por mayúsculas,
  formato de teléfono o email, y no sobrescribe ediciones locales posteriores.
- Citas: [APPOINTMENTS_APPLY](./APPOINTMENTS_APPLY.md). Únicamente metadata HOLD
  y trazabilidad de citas ya coincidentes. No crea ni mueve citas, no cancela
  ni completa estados; no equivale a haber actualizado la agenda.
- Altas semanales: `cliniccloud-import-week-appointments.js`, descrito en
  [APPOINTMENTS_APPLY](./APPOINTMENTS_APPLY.md#altas-semanales-con-identidad-ya-resuelta).
  Creación separada, revisada e idempotente; no sustituye la conciliación de
  cambios, anulaciones ni duplicados existentes.
- `cliniccloud-import-protocol-draft.js`: manual aportado íntegro como un único
  borrador no asociado. Requiere la migración específica de actores técnicos;
  fuente y paquete inmutables, revisión canónica y reintento por huella.

Secuenciar los ejecutores y re-preparar si cambia el snapshot de sus guardas.
No ejecutar en paralelo el importador antiguo/manual ni seeds. Los locks de
filas y del propio importador no constituyen una garantía de unicidad frente
a escritores ajenos que no respeten la identidad externa. Los runtimes normales
no crean identidades `source=cliniccloud`; el importador marketing conserva los
valores existentes y crea sus campos nuevos con `source=import`. Verificar esta
precondición de nuevo en otro corte, no convertirla en garantía permanente.

Un rollback de datos debe cotejar antes/después y conservar actuaciones
posteriores. Nunca restaurar toda la base compartida ni borrar historia para
retirar este código. Los archivos privados usan creación exclusiva y `fsync`
tanto del contenido como del directorio.

## Invariantes efectivas

- IDCONTACTO es identidad externa; NUM es número de historia. Alertas usan NUM.
- Una fila CSV sin IDCITA no adquiere un ID externo inventado. Coincidencias
  únicas recuperan el histórico; huella/fila permiten trazabilidad y repetición.
- Una cita local candidata a un cambio de fecha/duplicado todavía sin resolver
  se conserva como `SOURCE_LINK_UNDER_REVIEW`; no se declara ausente solo porque
  el CSV no permita recuperar su ID histórico. Las ediciones locales se contrastan
  también con `last_imported`, no solo con un booleano opcional de modificación.
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
