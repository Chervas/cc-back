# Publicación del esquema de Personal y confirmación de atención heredada

> **Tipo:** runbook.
> **Fuente de verdad:** operación acotada de las tres migraciones de Personal y Piedad; no concede permisos ni publica código.
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

La DDL no concede permiso a Piedad. La habilitación del corte anterior utilizó
otro instrumento de operación, identidad revisada y compare-and-swap del enlace
exacto: profesional 221, clínica 72, vínculo 119, con enlace activo,
`recibe_citas` y `agenda_flexible` verificados. Ese alcance es histórico, no
autoriza reactivar o ampliar la excepción. No aplicar esos números a fixtures
DEV por semejanza. La publicación de este operador no concede permisos.

Ante error de DDL o verificación del corte de esquema, conservar plan, respaldo
y diario privado e inspeccionar el último paso antes de decidir una reparación
explícita. El operador rechaza el reintento sobre DDL parcial. No ejecutar `down`,
repetir a ciegas ni restaurar globalmente una BD sobre escrituras nuevas. El
rollback de código conserva el esquema aditivo y restaura una versión compatible.
Guardar la evidencia del corte y su estado en los documentos canónicos. Este
procedimiento de esquema no acredita por sí solo una publicación o migración;
los resultados reales de otros cortes se identifican explícitamente más abajo.

Pruebas focales sin IPC del runner:

```bash
node src/scripts/tests/personal_calendar_schema_release.test.js
```

Ese comando ejecuta los casos `node:test` individuales. Un resultado de un
único archivo del runner `--test` no sustituye el recuento de casos ni las pruebas
MySQL efímeras del adaptador y las DDL reales.

### Retirada preparada de las excepciones por profesional · 09/10/2026

**Aplicada y verificada en CRM el 09/10/2026, a las 18:39 UTC, sin DDL.** La
decisión del titular retira las excepciones de agenda anteriores en los vínculos
siguientes y utiliza la confirmación explícita de cada reserva (`409` y recibo
revalidado). El instrumento acotado confirmó la transacción y la lectura final
de las cinco identidades; no se cambió ninguna reserva ni su horario.

| Vínculo `DoctorClinicas.id` | Profesional | `doctor_id` | Clínica | `clinica_id` | Valores finales verificados |
| --- | --- | --- | --- | --- | --- |
| 20 | Ainhoa | 50 | BS Capilar | 66 | `agenda_flexible=false`, `allow_legacy_attention_confirmation=false` |
| 122 | Ainhoa | 50 | BS Medical | 72 | `agenda_flexible=false`, `allow_legacy_attention_confirmation=false` |
| 113 | Lidia | 142 | BS Medical | 72 | `agenda_flexible=false`, `allow_legacy_attention_confirmation=false` |
| 115 | Lidia | 142 | BS Capilar | 66 | `agenda_flexible=false`, `allow_legacy_attention_confirmation=false` |
| 119 | Piedad | 221 | BS Medical | 72 | `agenda_flexible=false`, `allow_legacy_attention_confirmation=false` |

La operación resolvió las cinco parejas exactas, conservó la imagen privada de
las filas antes del commit y aplicó compare-and-swap bajo transacción. Se
verificaron los valores finales y todos los demás campos sin cambios.
`allow_legacy_attention_confirmation` sólo pasó de verdadero a falso en Piedad;
en los otros cuatro vínculos ya era falso. La invalidación normal de Undo
incrementó `PersonalCalendarRevisions` para los profesionales 50 (`0→1`),
142 (`0→1`) y 221 (`1→2`). No se ejecutó DDL, `down`, actualización global ni el
publicador de esquema para retirar estos campos.

La evidencia privada de operación es
`/home/ubuntu/secure-imports/booking-native-20261009-W7mUcV/apply-verified.json`
(`committed=true`, `verified=true`, cinco vínculos). La imagen anterior permanece
privada; no copiarla a la documentación ni restaurarla globalmente.

No modificar roles o permisos clínicos, `activo`, `recibe_citas`, adscripción,
horarios, ausencias, bloqueos ni citas. `allow_overlap_confirmation`, capacidad
y políticas físicas de sala quedan fuera de este corte. No activar mensajes,
consentimientos, programas, jobs ni flags del runtime. Un rollback de código no
debe reactivar automáticamente los permisos retirados. Una eventual reversión de
datos requiere una nueva autorización, alcance exacto y CAS sobre el estado
vigente, sin sobrescribir escrituras posteriores ni reducir las revisiones de
Personal. Nunca restaurar globalmente la BD. Cerrar el resultado y las evidencias
en 19/99.

Validar la preparación y reserva ordinaria con los campos retirados: falta de
horario, solape, personal de apoyo y grupo vinculado deben seguir mostrando los
motivos y requerir el nuevo recibo, sin una excepción silenciosa. No usar el
`agendable` legacy como veto local cuando una clínica única autorizada permite
preparar el borrador con núcleo de reservas activo y pertenencia activa que
recibe citas. Mantener los límites de atención registrada, máquinas inactivas/en
mantenimiento, recursos ajenos, equipos ALL y contrato adquirido de programa/bono.

La comprobación del transporte de errores usa el router real de citas con
`nativeFinalHandler=true` en el fixture HTTP/SQL aislado, sin su fallback JSON.
La validación aislada pasa 34 solicitudes autenticadas en MySQL efímero:
rechazos de `no_asistio` futuro con el núcleo de perfiles activado/desactivado,
protección de atención/recursos, cancelación histórica y replay. Se comprueba
`Content-Type: application/json`, código de dominio y estado/ocupación intactos
en los rechazos; cuatro pruebas directas verifican que errores desconocidos
siguen delegándose. Cero mensajes, consentimientos, jobs o conexiones externas.
Evidencia privada: `/tmp/cc-campaign-opt-mysql-oHO47n/result.json`.

El ajuste `care_*` está **publicado en DEV y CRM** con backend
`1c30663324c81ef3d60520352cc742f6785cd900`. La promoción staging fue fast-forward;
el preflight acreditó 56 tablas, cero problemas y cero migraciones pendientes
necesarias para esta release, conservando el entorno del servicio. Se reinició
la API, no el gateway.

Después de publicar se probó el PATCH nativo autenticado en DEV sobre una
reserva ficticia futura ya cancelada: `409`,
`Content-Type: application/json; charset=utf-8` y
`care_no_show_too_early`, conservando estado, `updated_at` y metadata. Evidencia
privada: `dev-future-json-after-publish.json` en el directorio de operación anterior.
La limpieza visual autenticada canceló las pruebas con comunicaciones suprimidas;
se verificó ausencia de mensajes, jobs, paquetes y documentos de consentimiento
generados por esas pruebas (`dev-cleanup.json`). CRM comprueba con sesión real
las cinco pertenencias sin agenda flexible, activas y recibiendo citas, ambas
orientaciones de agenda y la apertura/cierre de un borrador vacío. Cero
escrituras clínicas o comunicaciones durante esa navegación. Evidencia
`crm-native-readonly-after-retirement.json` en la misma carpeta; no se confunde
esa revisión con las escrituras ficticias DEV o SQL aisladas.
