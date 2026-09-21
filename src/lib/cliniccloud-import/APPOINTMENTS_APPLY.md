# Aplicación acotada de citas: HOLD y trazabilidad

Este ejecutor **no crea, mueve, cancela ni completa citas**. Solo añade trazabilidad
y supresión de notificaciones a importadas ClinicCloud cuyo ID histórico,
paciente, estado, horario y asignación ya coinciden exactamente. No sustituye al
futuro writer de conciliación. No activa flags ni recordatorios.

Las transiciones de estado están deshabilitadas en código: no hay flag ni
declaración de mantenimiento que eluda ese límite. Algunos consumidores antiguos
carecen de FK/índice por cita; un lock sobre la cita no protege todas las relaciones
frente a ellos. Se conservan nativas/Graci, relaciones firmadas, notas y datos
económicos. Nunca se modifican pacientes, opt-outs, WhatsApp, jobs ni eventos.

## Preparación READ ONLY

```sh
node src/scripts/cliniccloud-import-appointments-apply.js \
  --mode prepare \
  --plan /home/ubuntu/secure-imports/cliniccloud-plan-NUEVO.json \
  --local-snapshot /home/ubuntu/secure-imports/cliniccloud-local-snapshot-NUEVO.json \
  --private-output /home/ubuntu/secure-imports/cliniccloud-appointments-hold-NUEVO.json
```

Plan/snapshot originales deben verificar sus hashes. En transacción consistente
READ ONLY se capturan fila completa, identidad externa actual, FK/scope, solapes
y automatizaciones. Se descartan primero los cambios de estado/horario sin consultas
de detalle y se resuelven identidades en lote solo durante preparación. Aplicación
revalida sin caché; no cuenta relaciones clínicas/económicas que nunca modifica.
Si existe un trigger SQL de citas, se rechaza el
ejecutor. Campos nuevos/modificados desde el snapshot producen incidencias; no se
actualiza a ciegas el plan. Toda la evidencia queda en archivo privado 0600,
directorio 0700; stdout contiene exclusivamente hash y recuentos.

## Aprobación y aplicación: solo por el operador responsable

Crear backup verificado y revisar paquete/exclusiones antes de autorizar. El JSON
privado de aprobación debe contener:

```json
{
  "package_sha256": "HUELLA_LOGICA_DEL_PAQUETE",
  "reviewed_by": "IDENTIDAD_REAL_DEL_OPERADOR",
  "reviewed_at": "INSTANTE_UTC_ISO",
  "expires_at": "CADUCIDAD_UTC_ISO",
  "backup_manifest_sha256": "SHA256_BYTES_DEL_MANIFIESTO_BACKUP",
  "automation_policy": "hold",
  "confirm_in_place_only": true,
  "action_keys": ["CLAVE_EXPLICITA_DE_CADA_OPERACION_APROBADA"]
}
```

No asignar un usuario humano ficticio a `updated_by`: se conserva ese campo; el
operador real de importación queda identificado en el journal/metadata privado.

```sh
node src/scripts/cliniccloud-import-appointments-apply.js \
  --mode apply \
  --package /home/ubuntu/secure-imports/cliniccloud-appointments-hold-NUEVO.json \
  --approval /home/ubuntu/secure-imports/cliniccloud-appointments-approval-NUEVO.json \
  --backup-manifest /home/ubuntu/secure-imports/BACKUP/manifest.json \
  --private-journal /home/ubuntu/secure-imports/cliniccloud-appointments-journal-NUEVO.jsonl \
  --max-operations 25
```

Cada fila tiene transacción propia: `FOR UPDATE`, comparación de hash completo y
contexto actual, journal `prepared` con antes/después y `fsync`, actualización
exclusiva de `import_metadata`/`updated_at`, lectura de comprobación, commit y
journal `committed`. Un error detiene el lote; las filas previas permanecen
confirmadas y auditables. Se sincroniza también el directorio del journal al
abrirlo y se comprueba su cadena SHA. GET_LOCK por paquete y por ruta canónica de
journal evita carreras entre ejecutores; no sustituye al lock/CAS de datos. No se
bloquean tablas enteras.

El marcador idempotente reside también en la misma fila/transaction. Si hay un
fallo tras commit y antes de journal, reejecutar el mismo paquete/aprobación aún
vigente reconoce la operación sin escribir de nuevo. No restaura cambios locales
posteriores. Una marca incompatible, un journal truncado, un hash cambiado o una
aprobación vencida requieren revisión. No autoarreglar ni sobreescribir archivos.

`source_system=cliniccloud` conserva la exclusión histórica de los runtimes
anteriores. Se añaden `notification_suppression.appointment_details/day_before/
same_day=true` y `cliniccloud_reconciliation.automation_policy=hold`. La futura
activación necesitará un procedimiento independiente; no basta cambiar un flag.
No se generan recordatorios retrospectivos ni se invoca el motor de eventos.

Rollback no implementado automáticamente: usar antes/después del journal y
comprobar que siguen siendo los valores escritos; si hubo actuaciones posteriores,
revisar. Nunca restaurar toda la base compartida ni borrar historia.

Pruebas offline: `node --test src/scripts/tests/cliniccloud_import_appointments_apply.test.js`.

## Conciliación de una cita histórica por ID fuente observado

`legacy-source-reconciliation.js` no amplía el ejecutor HOLD anterior ni expone
un endpoint de escritura. Define un recibo verificable para un operador revisado
separadamente: una cita histórica simple conserva su ID local y toda su historia
cuando la lectura autenticada de ClinicCloud confirma el mismo ID fuente con
otro horario o una anulación explícita. La ausencia en el ZIP nunca equivale a
anulación; dos filas de agendas paralelas solo se vinculan con contacto, intervalo,
estado, acto único y nota coincidentes, además del ID canónico observado.

La preparación exige origen ClinicCloud, clínica 66/72, fecha/estado locales aún
iguales al histórico original, sin edición humana identificada, bono, lead,
reserva avanzada ni programa. Mantiene procedimiento, duración, profesional,
instalación, notas y tipo de cita. Rechaza actos compuestos, cambios clínicos,
evidencia de más de una hora y transiciones a realizada/no acudió. El recibo
conserva hashes de antes, fuente y contenido clínico, procedencias CSV, ID fuente
canónico y aliases comprobados; las tres supresiones de notificaciones permanecen
activas. No activa salas ni convierte una asignación antigua en validación clínica.

El operador debe verificar backup, registrar antes/después en diario durable,
bloquear citas y anclas comunes de paciente/profesional/sala, revalidar identidad,
solapes y ausencia de relaciones clínicas/económicas/automatizaciones. Solo puede
actualizar fecha, estado, metadata y fecha técnica, sin crear otra cita ni emitir
mensajes. Las relaciones existentes o nuevas dependencias requieren otro análisis;
este contrato no permite descartarlas ni saltarse el escritor canónico de reservas
complejas. Simular con rollback y comprobar después desde otra conexión y CRM.

Snapshot y plan reconocen el recibo como `preserve_reconciled_legacy_source`:
reprocesar las filas revisadas no mueve la cita atrás ni crea sus copias paralelas.
Un cambio posterior local o de estado/notas fuente devuelve el caso a revisión.
Rollback exclusivamente por comparación del después actual, restaurando los
campos concretos del diario si no hubo actuaciones posteriores; nunca restaurar
la base completa. Evidencia de aplicación y versión del operador en la bitácora
central. Pruebas: `cliniccloud_legacy_source_reconciliation.test.js`.

## Altas semanales con identidad ya resuelta

`cliniccloud-import-week-appointments.js` es un ejecutor distinto, solo para
crear hasta 250 citas de una semana (máximo siete días) en clínicas 66/72 del
mismo grupo. Exige `--target dev|crm`, plan y snapshot coincidentes, revisión
de todas las filas semanales y paciente enlazado por ID externo. No acepta
reprogramaciones sin resolver, colisiones de identidad, estados de asistencia
inferidos ni duplicados conocidos. No modifica ninguna cita existente.

Una decisión `distinct_visit` permite revisar un caso estrecho: el único
candidato es una primera visita nativa anterior y la historia fuente reciente
acredita actuaciones posteriores realizadas, distintas de la nueva visita
pendiente. `distinct-visits.js` exige revisión explícita con motivo/autor,
acción original y evidencia ligadas por hashes, ID real único y contacto/empresa
concordantes. No basta paciente/fecha ni estado «Pagada» sin marca de realización.
La primera visita conserva su estado (también `info_enviada`), horario y todos
sus campos: no se convierte en completada por analogía con ClinicCloud.

Solo crea `continuacion`, sin combinar una revisión de horario. Al escribir,
revalida la fila nativa completa bajo lock, la ausencia de otro propietario del
ID fuente, la identidad actual y los solapes normales. Evidencia de menos de
una hora; un cambio posterior difiere la operación. El recibo queda en
`cliniccloud_distinct_visit`, no se cambian el plan ni sus candidatos para
eludir una revisión. La copia en varias agendas se enlaza mediante el contrato
de procedencia paralelo, no creando otra reserva. Pruebas focales:
`cliniccloud_distinct_visits.test.js`.

Preparar con `--mode prepare --plan … --snapshot … --review … --private-output …`.
La revisión contiene `plan_sha256`, `reviewed_by`, `reviewed_at`, `week` con
`start/end` y una decisión por `action_key`: `disposition=create|defer` y `reason`.
Cada alta exige `assignment` (`clinic_id`, `doctor_id`, `installation_id`,
`treatment_id`, `appointment_type`), `evidence` y `pending_assignment` para cada
asignación explícitamente desconocida (`null`). No convertir el nombre de una
agenda/cabina en identidad del profesional ni equiparar cabinas por su número.

Aplicar con los mismos inputs, `--mode apply --package … --approval …
--backup-manifest … --private-journal …`. La aprobación contiene `package_sha256`,
`reviewed_by`, `expires_at`, `backup_manifest_sha256`, `automation_policy=hold` y
`confirm_create_only=true`. Exige backup del destino verificado completamente,
creación desde el worktree operador DEV y diario durable. DEV aislado nunca
recibe datos reales por este procedimiento.

Cada fila revalida identidad/membresía, recursos operativos, scope del tratamiento
y solapes actuales; clínica compartida, anchors ordenados y padre paciente
bloqueado dentro de una transacción READ COMMITTED. Un conflicto se difiere, no
se fuerza. La FK del paciente evita la carrera con inserciones legacy del mismo
paciente durante el commit; no acredita coordinación de todos los escritores
legacy de cabina/profesional. No comprueba horarios para alterar horas históricas
exportadas; los tratamientos con perfil operativo exigen el comando canónico y
se excluyen de este writer. Revisar también solapes y diferencias tras aplicar.

La huella `delta:cliniccloud-5880:…` es una referencia técnica de importación,
**no un IDCITA inventado**. Metadata conserva la línea base fuente; el lector de
snapshots la valida y permite conciliar exportaciones posteriores aunque la
persona haya editado la cita local. Repetir el mismo paquete reconoce su marca
persistida y no restaura ediciones posteriores. SQL directo no carga modelos,
jobs, eventos ni notificaciones; conserva HOLD y las tres supresiones.

La vista semanal de ClinicCloud puede devolver únicamente el último servicio
de una cita con varios actos. `compound-source-evidence.js` contrasta el ID real,
contacto, empresa, agenda, intervalo, estado y nota con la historia fuente completa
y reconstruye la etiqueta CSV a partir de todos sus conceptos, conservando orden
e IDs de origen. No son IDs de catálogo ClinicaClick. Solo permite enlazar agendas
paralelas si coinciden todos los conceptos de ambas; una PRP simple y una visita
PRP más otro acto no son intercambiables. Se conserva la evidencia original, sin
inventar fases, minutos por acto, precio, programa comprado ni consentimiento.
La normalización de comas/espacios de notas no permite omitir contenido clínico.
Cabinas, catálogo y reparto de fases pendientes permanecen explícitos. Un nombre
de profesional en la nota requiere además identidad/ámbito operativos y ausencia
de solapes locales y fuente antes de asignarlo; no basta la etiqueta de agenda.

La API publica solo `import_review` con procedencia, recordatorios retenidos y
asignaciones que aún faltan realmente. `source_service` añade únicamente el
nombre del servicio de la línea base, limitado a 255 caracteres; no expone notas,
identidad ni evidencias privadas. Es texto de procedencia, no una equivalencia de
catálogo, precio o consentimiento. Sin permiso de datos sensibles se retira todo
`import_review`. Corregir manualmente la asignación elimina su aviso, no activa mensajes.
Pruebas: `cliniccloud_week_appointments.test.js`,
`cliniccloud_import_snapshot_baseline.test.js` y
`appointment_import_review.test.js`; QA SQL aislada
`src/scripts/qa/isolated-week-import.js` revierte toda su fixture ficticia.

## Concretar la cabina física sin cambiar la cita

`cliniccloud-import-cabin-assignments.js` es el paso posterior al alta semanal.
No sirve para reagendar, cambiar estado/paciente/procedimiento/profesional ni
activar instalaciones. Admite solo citas importadas pendientes, sin programa
ni reserva avanzada, con referencia y línea base del delta coincidentes y HOLD.
La sala documental debe pertenecer a la misma clínica, tener una plaza y seguir
inactiva. Cada operación refiere una fila del catálogo con una única cabina;
la equivalencia del acto debe revisarse explícitamente, no inferirse del número
de la antigua agenda virtual. Revisar también colisiones proyectadas del delta
que todavía no figuren en la agenda local, incluidos bloqueos y otras clínicas.

Revisión privada: `plan_sha256`, `catalog_plan_sha256`, `reviewed_by` y `targets`.
Cada target: `action_key`, `appointment_id`, `installation_id`,
`catalog_source_key`, `reason` y `projected_conflicts` (vacío solo tras revisar).
Preparar desde back-dev con `--target crm --mode prepare --plan …
--catalog-plan … --review … --private-output …`. Aplicar esos mismos inputs
con `--mode apply --package … --approved-sha256 … --backup-manifest …
--private-journal …`. Paquete de dos horas y backup CRM verificado.

El escritor bloquea la cita, compara todas sus columnas y conserva los aliases
físicos. Revalida cabina, identidad y solapes locales de paciente/sala, incluidos
aliases y ocupación por fases; adquiere los anchors de sala/paciente. Persiste
solo `instalacion_id`, metadata de procedencia y `updated_at`, con antes/después
durables y marca idempotente. Un replay no restaura ediciones posteriores.
No carga eventos, modelos, colas ni recordatorios. **La colocación de citas en
salas inactivas no habilita aún nuevas reservas ni acredita toda la agenda**;
activación, horarios, asignaciones restantes y compatibilidad de escritores se
validan por separado. No cambiar un tratamiento para lograr que encaje en una sala.

Pruebas: `cliniccloud_cabin_assignments.test.js` y QA SQL DEV aislada
`QA_ISOLATED_CLINICAL_WRITES=bs-startup-isolated-20260920 node
src/scripts/qa/isolated-cabin-assignments.js` (fixtures ficticias y rollback exterior).
