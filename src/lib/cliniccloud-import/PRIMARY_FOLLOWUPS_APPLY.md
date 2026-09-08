# ClinicCloud: aplicación de adscripciones y seguimientos

Solo cuenta `cliniccloud-5880`, clínicas 66/72 del mismo grupo. El comando por
defecto prepara; no aplica. No carga Express, modelos globales, Redis, jobs ni
mensajes. No modifica contactos, WhatsApp, citas, fotografías, documentos,
tratamientos ni economía. No amplía acceso a todas las clínicas del grupo.

## Preparación y revisión

Recalcular primero `cliniccloud-import-primary-plan.js` con snapshot local fresco
y captura de membresías. El ejecutor exige la huella lógica del plan y las diez
fuentes vigentes; no interpreta «candidato» como autorización genérica.

```sh
node src/scripts/cliniccloud-import-primary-followups-apply.js \
  --mode prepare --plan /home/ubuntu/secure-imports/PLAN.json \
  --local-snapshot /home/ubuntu/secure-imports/SNAPSHOT.json \
  --private-output /home/ubuntu/secure-imports/PREPARED-NUEVO.json
```

La captura es una transacción consistente **READ ONLY**. Revalida IDCONTACTO y
NUM separadamente; índice de identidades de las dos clínicas completo para
detectar enlaces duplicados. Los desvíos quedan en `conflicts`, no se aplican.
Revisar `summary`, operaciones y exclusiones antes de aprobar su
`prepared_sha256`. Los textos/IDs individuales permanecen solo en JSON privado.

Adscripción: primer tratamiento pagado según evidencia del plan; sin ella,
primero registrado. No inferir pago desde el código histórico 3. Preserva la
pertenencia anterior y añade únicamente clínicas evidenciadas. Actualiza
`Pacientes.clinica_id` y `PacienteClinicas.es_principal`; no arrastra la historia
de prestación a otra clínica ni cambia permisos clínicos efectivos.

Alertas: fecha administrativa original, objetivo clínico nulo; estados pending,
closed/cancelled conservados. `source_kind=cliniccloud_alert`, namespace de cuenta
y `alert:<idAviso>` estable; cuando no existe ID, referencia explícita
`row:<fichero>:<fila>:<huella>` (no ID inventado). Un posible aviso ya importado
mediante identidad de fila exige conciliación si llega en otra exportación.
La identidad existente nunca se actualiza/reabre por repetir la importación.

## Aplicación por el operador autorizado

Preparar **después** de otros cambios de contactos: se comprueba `updatedAt`,
clínica, membresías e identidad exacta. Cada paciente agrupa en una transacción
su cambio de adscripción/membresías y sus seguimientos; cualquier error revierte
ese grupo completo. El resto ya confirmado se conserva, no se revierte a ciegas.

```sh
node src/scripts/cliniccloud-import-primary-followups-apply.js \
  --mode apply --prepared /home/ubuntu/secure-imports/PREPARED.json \
  --approve-sha256 HUELLA_LOGICA_APROBADA \
  --actor-kind system_import \
  --backup-file /home/ubuntu/secure-imports/LOTE/database-before.sql.gz \
  --backup-sha256 SHA256_BACKUP \
  --journal /home/ubuntu/secure-imports/JOURNAL.jsonl \
  --confirm-hold yes
```

Actor técnico explícito: `created_by/updated_by/actor_id = NULL`, revisión
`imported`, journal `actor_kind=system_import`; no suplantar a un administrador.
También admite `--actor-kind existing_actor --actor-id ID` si está expresamente
autorizado y la cuenta existe/está activa. El HTTP normal no cambia.

Se comprueban worktree DEV, fuentes, backup privado y hash, índice de identidad
global, locks de paciente/membresías/campos fuente, grupo de clínicas y huella
antes de escribir. El bloqueo asesor por cuenta serializa este ejecutor, **no**
demuestra que otros escritores antiguos de identidad cooperen. Las guardas se
repiten en la transacción y no hay autorización para ejecutar importadores
concurrentes que reasignen identidades fuente.

## Journal y recuperación conservadora

JSONL privado 0600, raíz 0700, creación sin seguir symlinks, bloqueo exclusivo,
cadena SHA256 y fsync de fichero/directorio. `prepared_patient` se sincroniza
antes de escribir; `committed_patient` después del commit contiene estado final.
Las revisiones de seguimientos se guardan en la misma transacción del dominio.
No se escriben marcadores de auditoría en campos visibles del paciente.

Repetir con el **mismo journal** y huella conserva seguimientos existentes y
valida estado final de adscripciones ya confirmadas. Un journal truncado,
bloqueo abandonado o `prepared_patient` sin commit durable **detiene** el proceso:
requiere revisar base/backup/prepared, no borrar el lock/journal y reintentar sin
conciliar. Esta limitación es deliberada por no existir auditoría transaccional
de adscripciones. No atribuir a este ejecutor cambios de otro proceso.

Rollback de datos no es automático: comparar antes/después y revisiones actuales,
restaurar solo campos todavía propiedad del lote y revisar cualquier membresía
que ya dé acceso a actuaciones posteriores. No borrar seguimientos con trabajo
posterior ni restaurar la base compartida completa. Una reanudación no reabre
alertas cerradas, anuladas o enlazadas por el personal.

## Pruebas

`node --test src/scripts/tests/cliniccloud_primary_followups_apply.test.js`
usa el servicio real de seguimientos con dobles transaccionales offline; incluye
scope, NUM distinto de ID, manipulación de hash, estados históricos, doble
ejecución, actor nulo, bloqueo por drift, rollback y crash commit→journal.
No son pruebas de escritura InnoDB ni una importación real.
