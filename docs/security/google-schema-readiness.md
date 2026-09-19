# Google: requisitos de esquema antes del despliegue

> **Tipo:** runbook de requisitos SQL y recuperación.
> **Fuente de verdad:** compatibilidad de esquema Google; no certifica migración de credenciales ni acceso al proveedor.
> **Última revisión:** 2026-09-19.
> **Relacionado con:** [contrato backend](../../src/Documentacion/13-backend.md#esquema-google-completo-y-publicación-por-entorno), [estado central](https://github.com/Chervas/cc-front/blob/dev/src/Documentacion/19-estado-actual.md#seguridad-de-acceso-e-integraciones).

## Estado vigente — 19/09/2026, 18:04 UTC

Las aplicaciones SQL descritas aquí no deben repetirse. DEV recibió sus seis DDL
restantes a las 17:06 UTC y los [consumidores DEV](google-dev-consumers.md) a las
17:38–17:39. Las **19 DDL clínicas ya se aplicaron a las 18:04 UTC**, conservando
434 filas, 520 jobs pendientes y pausas existentes; [acta y recuperación](google-clinical-cut.md).

El contrato completo del código preparado exige **49 tablas y 43 migraciones**;
Google aporta 22 tablas y 22 migraciones (tres históricas de julio y diecinueve
posteriores). Las cinco tablas nuevas son `GoogleConversionSubmissions`,
`GoogleAdsActionPlans`, `GoogleAdsActionCommands`, `GoogleDestinationAuthorizations`
y `GoogleDestinationCommands`. El historial de intentos ya existía y se conserva.

La inspección de solo metadata encontró seis migraciones pendientes en DEV y
19 en staging. **Las seis de DEV ya se aplicaron** con fuente `dea531ac`; no repetir
el plan. DEV pasa ahora las 49 tablas del código preparado y las 43 exigidas por
la release anterior `d07e9c85`. DEV ejecuta ahora `aeb87ce4`, compatible con 49.
El esquema clínico también pasa 49 y conserva compatibilidad con las 27 tablas de
las releases públicas `48d69879`/`fdb2636a`, que se mantienen. Los consumidores
Google nuevos aún no se han publicado ni activado en CRM/gateway. La incompatibilidad
anterior era con el código futuro, no un fallo de las API operativas.

## Secuencia completa probada

`google_broker_schema_mysql.integration.js` ejecuta las diecinueve migraciones
reales desde el esquema anterior en un MySQL propio, sin acceso a BD, Redis ni
proveedores del host. Parte de las tres migraciones de julio y conserva 16 filas
ficticias: credenciales, mappings activos/inactivos, asignaciones de clínica/grupo
y conversiones pendientes/aceptadas/parciales. Los dieciséis registros y diarios
nuevos quedan vacíos antes de probar su comportamiento. El cargador legacy sigue
operativo hasta que aparece un marcador; una identidad compartida marcada se
cierra antes de leer tokens, incluso bajo otro ID.

Verificados los 22 contratos Google, hashes de las 22 migraciones, pares completos
de referencias y rechazo del mismo plan reaplicado. Se desactivan CHECK y retiran
índices en la BD ficticia para demostrar que el preflight detecta ese drift.
Los recibos de conversión incierta, aplicación intentada y retirada pendiente
sobreviven a los intentos de `down`; borrar sus padres no puede borrarlos en
cascada. Siete grupos de comprobaciones pasan y el MySQL temporal termina en 0.

```sh
CAMPAIGN_OPTIMIZATION_MYSQL_TEST=1 node src/scripts/tests/google_broker_schema_mysql.integration.js
```

No acredita cardinalidad clínica, proveedor Google, MFA público ni aceptación
visual de las nuevas pantallas. [Acta estructurada](google-schema-readiness.json).

## Aplicación DEV y recuperación

Con plan de fuente/contrato/metadata fijados, se comprobaron siete tablas Google
vacías y cero jobs, correos o flujos en curso. Se detuvieron solo API y worker de
seguridad DEV; el aplicador versionado ejecutó exclusivamente estas seis DDL:

1. `20260918110000-create-google-conversion-submissions.js`.
2. `20260918190000-create-google-ads-action-journal.js`.
3. `20260918203000-google-action-recovery-ownership.js`.
4. `20260918220000-create-google-destination-journal.js`.
5. `20260918224500-index-google-destination-recovery.js`.
6. `20260918235000-index-google-receipt-review.js`.

Las cinco tablas siguen vacías. La misma release DEV arrancó con ambos archivos
de configuración intactos, MFA/sesiones enforce, jobs/crons clínicos OFF y cero
reinicios automáticos. No se activaron consumidores, tokens ni conexiones nuevas.
CRM, gateway y los dos consumidores WhatsApp conservaron PID/inicio/entorno;
los archivos públicos y el esquema clínico conservaron sus huellas.

Plan y diario root bajo
`/var/lib/clinicaclick-schema-recovery/google-dev-20260919-dea531ac/`.
Solo crea/ajusta tablas nuevas vacías; no se modificaron filas ni tablas históricas.
No se necesitó exportar datos clínicos para este corte de la BD ficticia. La
recuperación mantiene el esquema aditivo y la misma release compatible: no usar
`down`, borrar journals ni volver a aplicar un plan ya consumido. Ante DDL parcial,
conservar diario y examinar antes de cualquier acción; no hay rollback transaccional
MySQL. El operador genérico sigue prohibiendo escrituras fuera de DEV.

Login anónimo real CRM/DEV verificado después en 1440/390px: cuatro capturas,
API sin mocks, auth/me401 y formulario vacío sin POST, errores JS/5xx ni overflow.
Se revisaron CRM escritorio y DEV móvil. No equivale a login autenticado por MFA.
Evidencia privada en `qa-evidence/security-resume-20260917/google-clinical-preflight-20260919/`.

## Pendiente

Los consumidores selectivos ya están publicados en DEV con activación pendiente;
el esquema clínico también está aplicado. Preparar la composición pública y su
publicación; no repetir el operador Google ni reutilizar el limitado a Meta.
Faltan primera identidad Google y ámbitos de todas sus verticales, configuración
AWS, aceptación del titular/proveedor y recorridos autenticados/carga real. Una
identidad compartida no puede migrarse por partes sin considerar sus consumidores.
El cambio DEV no abre campañas, leads, conversiones ni envíos históricos.
Sin AWS, instancias o consulta Cost Explorer en este corte; coste incremental
facturado `null`, no cero. Las copias generales siguen al final del objetivo.

## Antecedente del 18/09 — no reutilizar sus planes ni recuentos


Actualización de conversiones, 18/09/2026: el contrato del nuevo código exige
36 tablas y 29 hashes de migración. Añade `GoogleConversionSubmissions` y fija la
definición de `GoogleAdsConversionUploadAttempts` ya existente. Solo se crea una
tabla nueva mediante `20260918110000-create-google-conversion-submissions.js`;
esta migración aún no se ha aplicado a DEV ni staging. Las 34 tablas del corte
inferior describen la release operativa anterior. Hace falta preflight y plan
nuevos antes de publicar este código; no repetir las trece migraciones ya
ejecutadas en DEV. [Contrato y pruebas del registro](google-data-manager-broker.md#reserva-sql-y-recuperación-en-crm-18092026).

El preflight DEV de solo lectura del mismo día comprobó las 36 tablas: la única
incidencia es la ausencia de `GoogleConversionSubmissions`, y la única migración
pendiente es la anterior. La tabla histórica de intentos sí coincide con el
contrato. Resultado esperado `incompatible`: impide publicar este código hasta
preparar y aplicar un plan nuevo. No se ejecutó DDL durante esa comprobación.

Estado comprobado el 18/09/2026. La preparación del esquema no migra tokens,
no añade permisos y no activa consumidores. La conexión compartida observada en
staging sirve 14 mappings de Business Profile, 6 de Search Console, 5 de
Analytics y 6 de Ads, con 14 asignaciones de clínica y 3 de grupo activas.
Se consultaron presencia de credenciales y metadata; no se extrajeron tokens.
Meta no WhatsApp mantiene la cuarentena; no se comprobó su token con Meta.

El código nuevo de `googleLegacyCredentials.service` consulta ocho registros
duraderos antes de seleccionar credenciales, aunque los flags del broker estén
apagados. Las tablas ausentes producen `google_credentials_unavailable`.
Un marcador por ID o identidad Google cierra el acceso legacy de la identidad
compartida: mover solo un servicio podría cortar los otros. Preparar las tablas
vacías no crea ese marcador ni permite retirar las credenciales existentes.

El contrato de despliegue incorpora ahora 16 tablas de Google: once registros
nuevos, las referencias de cuatro mappings y la nulabilidad de
`GoogleConnections.accessToken`. Fija las trece migraciones de Google del
13/09, sus hashes, columnas, índices, estados y restricciones. El comprobador
también verifica la expresión y activación de los cuatro CHECK que exigen
referencias completas. El publicador DEV existente usa este contrato antes de
detener servicios o cambiar la versión. No debe omitirse ese control.

Prueba reproducible, exclusivamente en un MySQL temporal propio con red externa
bloqueada:

```sh
CAMPAIGN_OPTIMIZATION_MYSQL_TEST=1 node src/scripts/tests/google_broker_schema_mysql.integration.js
node --test src/scripts/tests/security_schema_release.test.js
CAMPAIGN_OPTIMIZATION_MYSQL_TEST=1 node --test src/scripts/tests/security_schema_release_mysql.test.js
```

La secuencia completa ejecuta las trece migraciones reales mediante el mismo
aplicador de despliegue. Conserva tokens ficticios, mappings activos/inactivos y
asignaciones de clínica/grupo/desconectadas. Comprueba rechazo de referencias
incompletas, detección de un CHECK desactivado, reaplicación de plan antiguo,
cierre de la identidad compartida sin hidratar tokens y conservación del
historial al intentar `down`. La regresión existente verifica exclusión mutua,
DDL parcial sin reintento automático y preservación de datos. No acredita
operaciones reales de Google ni interfaz autenticada.

La primera ejecución detectó la ausencia de estas tablas en el contrato de
despliegue; la ejecución final pasa con el contrato ampliado. Antes de la publicación,
los dos esquemas carecían de las tablas de broker Google y `accessToken` seguía
siendo NOT NULL. La prueba parte también de esa definición anterior.
No ejecutar `db:migrate` global ni reintentar automáticamente DDL parcial.

El corte de staging exige completar consumidores de la identidad compartida,
operaciones tipadas, inventario de pausas, drenaje y recuperación. La creación
de solicitudes/reconciliación de altas Ads y las operaciones de escritura aún
no están completas; este documento no autoriza dar esos recorridos por probados.


## DEV aplicado y publicado, 18/09/2026 08:25 UTC

Plan fijado a `68808b82047567e3f1b223ed4e24c16aaff61eb6`, contrato SHA256
`4fcde15737813913fc7ae30cde0877db1de1a9638ac45c748bcf0291c494408f` y metadata previa.
Se verificaron tablas Google, citas y pacientes vacías, y cero trabajos, flujos o
correos en curso. Se detuvo la API DEV, se aplicaron exactamente trece migraciones
con journal y se publicó mediante el publicador original. No hubo DDL parcial
ni reintentos. Las 34 tablas pasan el contrato; los once registros nuevos siguen
vacíos, sin grants ni credenciales añadidas. El campo de token ya admite NULL.

Release `/opt/clinicaclick-dev/release-68808b82047567e3f1b223ed4e24c16aaff61eb6`,
2.220 archivos comparados con Git. API UID998/PID1766048 y worker de seguridad
UID996/PID1766060 activos, sin reinicios adicionales. Los dos archivos privados
de configuración conservan sus hashes, MFA/sesiones enforce y jobs clínicos OFF.
Los flags IA/Google/SES no se activaron. Auth/me devuelve401 en3000/3001/3004.

Staging conserva exactamente el digest de metadata previo
`cd74a9d7543b171d4a74eb15b11732e8ea57500ba5bf057ddabde6da408e5c73`:
continúa incompatible con este contrato Google (24 incidencias/13 migraciones
pendientes), por lo que no puede publicarse allí este conjunto todavía. Conserva
una conexión, 17 asignaciones, los 31 mappings y dos bloqueos Meta. Sus procesos,
gateway, fresh-inbound e importador conservaron los PIDs observados. Frontend
no se reconstruyó: los cambios de esta continuación son pruebas y documentación.

Recuperación DEV: puede restaurarse la release anterior `4fbf4bda` conservada,
con su configuración aislada, manteniendo el esquema aditivo. No ejecutar down
ni borrar registros/historial para recuperar código. El plan aplicado queda
invalidado por el nuevo digest y el historial; no volver a ejecutarlo.
Evidencia privada: `google-meta/dev-google-plan.json`, `dev-google-apply.jsonl`,
`dev-release-{before,after}.json`, `installed-files.json` y `staging-after-dev.json`.
Esto habilita los requisitos SQL de DEV; no acredita acceso real a Google,
OAuth, altas Ads ni recorridos visuales autenticados.
