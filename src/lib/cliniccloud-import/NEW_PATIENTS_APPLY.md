# ClinicCloud: altas nuevas revisadas, sin mensajes ni citas

Ejecutor independiente de `app.js`, modelos, hooks, Redis y workers. No es un
importador general: consume únicamente las altas inequívocas de la auditoría
privada `cliniccloud-new-patients-audit/1`, más una decisión explícita para cada
candidato. Las exclusiones **no prueban duplicidad** y nunca autorizan fusionar.

El corte revisado contiene 70 candidatos iniciales, 58 retenidos y 12 diferidos:
11 por ambigüedad de identidad y uno adicional por nacimiento posterior al alta.
Otra fecha inconsistente ya pertenece a los 11 diferidos. No se reinterpretan
fechas para hacer pasar una fila.

## Preparación solo lectura

Desde `/home/ubuntu/wt/back-dev`, rama `dev`:

```sh
node src/scripts/cliniccloud-import-new-patients-apply.js \
  --mode prepare \
  --audit /home/ubuntu/secure-imports/cliniccloud-new-patients-audit-20260907-v1.json \
  --review /home/ubuntu/secure-imports/cliniccloud-new-patients-identity-review-20260907-v2.json \
  --global-snapshot /home/ubuntu/secure-imports/cliniccloud-new-patients-global-snapshot-20260907-v1.json \
  --source-dir /home/ubuntu/frontend_clinicaclick/temp \
  --historical-dir /home/ubuntu/secure-imports/clinic-real-20260722/review/backup_data \
  --private-output /home/ubuntu/secure-imports/cliniccloud-new-patients-package-NUEVO.json
```

Verifica los hashes de los cuatro CSV, auditoría, revisión y evidencias privadas;
relee todas las identidades del grupo en una transacción consistente READ ONLY.
No sobrescribe artefactos. La salida pública solo contiene agregados y SHA.

## Aplicación exclusivamente tras revisión operativa

Usar el mismo comando con `--mode apply`, sin `--global-snapshot` ni
`--private-output`, añadiendo `--package`, `--approval`, `--backup-manifest` y
`--private-journal` con rutas explícitas bajo `secure-imports`. No ejecutar por el
mero hecho de generar un paquete. Se exige una aprobación privada que incluya:

```json
{
  "package_sha256": "SHA_LOGICO_DEL_PAQUETE_REVISADO",
  "reviewed_by": "OPERADOR_QUE_REVISA",
  "automation_policy": "hold",
  "acknowledge_native_create_race": true,
  "backup_manifest_sha256": "SHA256_DE_LOS_BYTES_DEL_MANIFIESTO",
  "expires_at": "FECHA_ISO_UTC_FUTURA_CON_Z"
}
```

La CLI comprueba físicamente tamaño/SHA del `database-before.sql.gz` y la
antigüedad máxima de 12 horas del manifiesto, reutilizando el validador de
contactos. La validación gzip/restaurabilidad operativa del backup sigue siendo
responsabilidad del operador. No se importan consentimientos, imágenes, notas
clínicas, economía, citas ni campos WhatsApp/RGPD/publicidad.

## Atomicidad y límite de concurrencia

- Un `GET_LOCK` por cuenta serializa estos ejecutores; otros bloqueos por
  paquete y ruta canónica del diario impiden compartir un diario concurrente.
- Antes de la primera inserción, el hash global actual debe ser exactamente el
  aprobado en preparación; cualquier cambio requiere nueva preparación/revisión.
- Una sola transacción READ COMMITTED crea pacientes, enlaces fuente y
  membresías. Cada fila se relee y se compara con su allowlist exacta.
- Antes de commit se relee el grupo y se exige el mismo hash, excluyendo solo
  las altas creadas por esta transacción. Se revisan ID fuente, NUM e identidades.
- Tras commit se comprueban otra vez las identidades. Una colisión obliga a
  detener los siguientes lotes y revisar; **no** se borran pacientes ni se
  pretende deshacer un commit ya efectuado.

Los escritores nativos antiguos no utilizan este bloqueo y no existe un índice
único global de identidad (los teléfonos pueden ser familiares). Por tanto,
una alta nativa entre la última comprobación y el commit todavía puede competir;
la comprobación posterior reduce el riesgo, pero **no garantiza unicidad global**.
El operador debe revisar actividad nativa y posponer la aplicación si procede.
No se bloquean tablas completas ni se presupone que los escritores estén parados.

Un replay con todos los ID fuente presentes conserva a los existentes sin tocar
campos ni membresías, incluso tras ediciones posteriores. Un replay parcial
se rechaza: no es la recuperación normal de un lote atómico y necesita revisión.
La ausencia de resultado tras fallo de red/disco **no demuestra rollback**.
Reconciliar el diario privado y los enlaces durables antes de continuar.

El diario usa cadena SHA, append/fsync de archivo y fsync del directorio antes
de escribir en base. Registra preparación, validación precommit, commit y auditoría
posterior. No elimina evidencia ni historiales.

## Identidad durable y comparación posterior

Cada nueva alta guarda dos `PatientCustomFields` con `source=cliniccloud`:

- `cliniccloud_source_contact_id`, `source_column=idContacto`.
- `cliniccloud_contact_snapshot`, `source_column=cliniccloud_contact_snapshot`.

El segundo contiene versión/cuenta, `contact.idContacto`, `contact.num`, ALTA
original, procedencia/hashes y regla de clínica. No finge ser `contacto_1.csv`.
`fields` conserva únicamente los seis campos fuente normalizados por el
adaptador; `stored_fields` conserva esos mismos seis valores tal como se han
almacenado (formato de nombre/teléfono/email). El lector expone
`last_imported_fields` y `last_imported_local_fields` para distinguir una
corrección auténtica de una mera diferencia de formato. NUM e IDCONTACTO
mantienen significados distintos.

`fecha_alta` se conserva desde `DD-MM-YYYY HH:mm:ss` de ClinicCloud interpretado
en Europe/Madrid y persistido en UTC. `createdAt` registra la importación actual.
La clínica principal y las membresías solo proceden de evidencia revisada;
no se presupone acceso a todas las clínicas del grupo.

## Pruebas offline

```sh
node --test src/scripts/tests/cliniccloud_import_new_patients.test.js \
  src/scripts/tests/cliniccloud_import_snapshot_baseline.test.js
```

Dobles de transacción/SQL, sin base real: integridad, fechas, exclusiones,
colisiones, rollback del lote, replay, expiración, diario, allowlists y
reimportación de la misma exportación sin parches espurios.
