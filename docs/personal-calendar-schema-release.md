# Publicación del esquema de Personal y confirmación de atención heredada

> **Tipo:** runbook.
> **Fuente de verdad:** operación acotada de las tres DDL de Personal y Piedad; no concede permisos ni publica código.
> **Última revisión:** 2026-10-08.
> **Relacionado con:** [despliegues](https://github.com/Chervas/cc-front/blob/dev/src/Documentacion/30-despliegues-y-entornos.md), [seguridad y migraciones](security-integrations-audit-migration.md#esquema-de-seguridad-y-publicación-entre-entornos).

`src/scripts/personal-calendar-schema-release.js` admite `prepare`, `check`,
`apply` y `verify`, con destino explícito `dev` o `crm`. Se ejecuta desde
`/home/ubuntu/wt/back-dev`, rama canónica `dev`, limpia y comprometida. No crear
otra rama de publicación ni ejecutar el historial completo de migraciones.
El operador no carga la aplicación, cambia configuración, reinicia procesos,
activa proveedores, crea citas ni envía comunicaciones.

Solo acepta estos archivos y sus hashes revisados:

| Migración | Efecto | SHA256 |
|---|---|---|
| `20261008123000-personal-calendar-undo-receipts.js` | Dos tablas inicialmente vacías de versiones y recibos | `a08ebd6f64d1f9e522fedef103526bf2be2a14b9ded8c350f47d264519ad40d6` |
| `20261008123100-add-personal-block-recurrence-until.js` | `DoctorBloqueos.recurrente_hasta DATE NULL` | `8caaf30631fa440f5988d3225017b8b13b2e646607bd56807141bedfca19d62b` |
| `20261008133000-add-legacy-attention-confirmation.js` | `DoctorClinicas.allow_legacy_attention_confirmation`, inicialmente falso | `a812082bf08ba49aab4985c4dd4c7f90174857f0fc7ea478fc4335c533f63aed` |

Ambos `ADD COLUMN` exigen `ALGORITHM=INSTANT`; un servidor incompatible produce
un fallo y no se intenta copiar o reconstruir la tabla. Las nuevas tablas se
crean con InnoDB. Antes de registrar las tres migraciones en una sola transacción
se verifican tipos, precisión, índices, columnas anteriores, disponibilidad y
metadata exacta. Los límites nuevos siguen NULL, los permisos nuevos falsos y
las tablas nuevas vacías. La DDL MySQL confirma implícitamente: esa transacción
solo hace atómico el registro de nombres, no revierte la DDL.
`SequelizeMeta` debe usar InnoDB y no tener triggers; el operador conserva también
sus columnas e índices anteriores y rechaza estas condiciones antes de DDL.

`prepare` guarda hashes de filas de `DoctorBloqueos` y `DoctorClinicas`, metadata,
identidad de destino, configuración SQL y commit. No exporta las filas ni las
credenciales. `apply` exige ese plan y su hash canónico emitido por `prepare`,
más un respaldo completo verificado del mismo servidor/destino y un diario nuevo
con fsync. Plan y respaldo deben tener menos de dos horas. Cualquier deriva o
estado existente/parcial impide la aplicación; no reutilizar un plan ni un diario
para otro destino.

## Secuencia

Mantener un único propietario de los artefactos privados bajo
`/home/ubuntu/secure-imports`. Ejecutar el operador con ese usuario y el acceso
SQL específico del destino que ya resuelve `connectOperatorDatabase`; no copiar
credenciales entre entornos. Las paradas y la publicación systemd se realizan
con su autorización y privilegios habituales, por separado.

1. Terminar la integración y QA en DEV; comprometer la fuente limpia. Revisar
   los tres hashes y conservar las versiones anteriores. Verificar las unidades
   API y worker de seguridad sin volcar sus entornos, sesiones o secretos.
2. Crear un directorio privado nuevo y preparar el plan para **un** destino.
   El ejemplo CRM exige cambiar expresamente `cc_target` para la operación DEV:

   ```bash
   cd /home/ubuntu/wt/back-dev
   cc_target=crm
   cc_cut_dir=/home/ubuntu/secure-imports/personal-calendar-crm-YYYYMMDD-HHMM
   mkdir -m 700 "$cc_cut_dir"
   node src/scripts/personal-calendar-schema-release.js --mode prepare --target "$cc_target" --private-output "$cc_cut_dir/plan.json"
   ```

3. Revisar el plan privado y guardar su `plan_sha256` de la salida. Crear un
   directorio de respaldo vacío y usar el respaldo normal del mismo destino:

   ```bash
   mkdir -m 700 "$cc_cut_dir/backup"
   node src/scripts/cliniccloud-operator-backup.js --target "$cc_target" --private-directory "$cc_cut_dir/backup"
   ```

4. DEV exige detener previamente `clinicaclick-back-dev.service` y
   `clinicaclick-dev-security.service`; conservar cuáles estaban activos para
   restaurarlos después del corte. En CRM coordinar una ventana sin escrituras
   de disponibilidad: cualquier cambio concurrente hace fallar la comprobación
   de conservación. El operador no detiene procesos ni abre o modifica gates.
5. Aplicar solo el plan aprobado con un diario nuevo:

   ```bash
   node src/scripts/personal-calendar-schema-release.js --mode apply --target "$cc_target" --plan "$cc_cut_dir/plan.json" --approved-plan-sha256 SHA256_EMITIDO_POR_PREPARE --backup-manifest "$cc_cut_dir/backup/backup-manifest.json" --private-journal "$cc_cut_dir/journal.jsonl"
   node src/scripts/personal-calendar-schema-release.js --mode verify --target "$cc_target" --plan "$cc_cut_dir/plan.json" --private-output "$cc_cut_dir/verified.json"
   ```

6. Ejecutar también el preflight normal de seguridad y este preflight específico
   antes de publicar cada runtime. El contrato SQL de seguridad no certifica
   por sí solo estas tres DDL:

   ```bash
   node src/scripts/personal-calendar-schema-release.js --mode check --target "$cc_target" --private-output "$cc_cut_dir/preflight.json"
   ```

7. Publicar DEV con el publicador aislado habitual; promocionar staging únicamente
   por fast-forward desde la release completa de DEV. Preservar MFA, identidad,
   Redis, pausas, flags y permisos de cada entorno. Construir y publicar el
   frontend conforme al runbook, conservar bundles anteriores y cambiar el
   índice al final. Comprobar el runtime/build servido, `/api/auth/me` sin sesión
   con 401 y la aceptación autenticada mediante MFA normal del titular.

`verify` acredita la conservación contra el plan original **antes** de habilitar
permisos o permitir nuevas ediciones. Después de nuevas operaciones, `check`
acredita únicamente el esquema y los tres registros, sin exigir tablas vacías
o permisos falsos. No presentar `check` como prueba de conservación de datos.

## Permiso acotado y recuperación

La DDL no concede permiso a Piedad. Cualquier habilitación posterior requiere
otro instrumento de operación, identidad revisada y compare-and-swap del enlace
exacto. El destino CRM autorizado es profesional 221, clínica 72, después de
verificar identidad, enlace activo, `recibe_citas` y `agenda_flexible`. No aplicar
ese número a fixtures DEV por semejanza ni concederlo por lotes. La publicación
de este operador no autoriza ampliar la excepción a otros profesionales.

Ante error de DDL o verificación, conservar plan, respaldo y diario privado e
inspeccionar el último paso antes de decidir una reparación explícita. El
operador rechaza el reintento sobre DDL parcial. No ejecutar `down`, repetir a
ciegas ni restaurar globalmente una BD sobre escrituras nuevas. El rollback de
código conserva el esquema aditivo y restaura una versión compatible. Guardar
la evidencia del corte y su estado en los documentos canónicos; este runbook no
declara ninguna publicación o migración ejecutada.

Pruebas focales sin IPC del runner:

```bash
node src/scripts/tests/personal_calendar_schema_release.test.js
```

Ese comando ejecuta los casos `node:test` individuales. Un resultado de un
único archivo del runner `--test` no sustituye el recuento de casos ni las pruebas
MySQL efímeras del adaptador y las DDL reales.
