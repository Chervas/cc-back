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
