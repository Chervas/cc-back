# Runbooks operativos del backend

## 13/09/2026 — Alta WhatsApp: candidata y recuperación preparadas

[Contrato del broker de alta](security/whatsapp-onboarding-broker.md): operaciones
privadas firmadas, registro antes del canje, Secrets Manager por versión/hash y
bloqueo durable del ámbito. No activa conexiones. Rutas/UI, configuración Meta,
aislamiento y corte del MFA público siguen pendientes. Sin nueva DDL clínica
ni instalación; no se modifica la cuarentena ni se usan credenciales reales.

## 13/09/2026 — WhatsApp primero; OPS no es dependencia

Aclaración del usuario: OPS solo consume datos para paneles y puede estar
apagado. La activación de ClinicaClick no depende de él. Prioridad: API WhatsApp
y login con código por correo; cuentas publicitarias después.

Refuerzo preparado: webhook con firma obligatoria y ámbito derivado del activo,
ACL de estado/listados, lecturas sin token ni sync automática y escrituras
WhatsApp cerradas antes de sus handlers. 38 pruebas aisladas pasan (18 nuevas).
No se ha desplegado. La revocación/retirada de tokens y parada de envíos son
reportadas por el usuario; no se usan credenciales para comprobarlas.

**Reconexión aún no validada**: broker y consumidores WhatsApp, control de
plantillas, cierre de workers y corte efectivo del MFA pendientes. Informe y
criterios concretos en `back-dev/docs/security/whatsapp-reconnection-readiness.md`.
Las referencias históricas a «OPS aplazado» no imponen esperar al producto OPS.

## 13/09/2026 — Primera etapa preparada: Meta y códigos por correo

Entrega de contención Meta y acceso con código por correo elegido por el usuario.
Código/QA locales: **505 pruebas Node** (441 backend, 53 auditoría, 11 front),
**83 comprobaciones en ocho MySQL privados**, todos cerrados con código 0;
18 escenarios/capturas Chromium escritorio/móvil y build Angular correcto.
Datos/proveedores ficticios: no equivalen a validación de servicios reales.

MFA obligatorio para sesiones ordinarias al activar `AUTH_EMAIL_MFA_MODE=enforce`;
sin JWT hasta validar el código, con caducidad, consumo único, límites y
recuperación auditada. Usuarios/Personal no pueden redirigir los códigos mediante
edición genérica. Cuarentena global Meta en los transportes inventariados,
OAuth/embedded signup/diagnósticos cerrados, histórico bajo ACL, bloqueos Meta
sin cascadas y comprobación de compartidos/primarios antes de cualquier baja.
El hotfix de `socialstats.controller.js` conserva sus bytes.

DDL `20260913130000` y `20260913140000` obligatorias antes del código, incluso
con MFA off; **no ejecutadas en BD compartida**. Sin despliegue, cambios PM2,
correo real, Meta ni AWS. OPS sigue aplazado. El alta general Ads queda para otra
capa; el siguiente corte de integraciones debe aislar credenciales Meta antes de
retirar la cuarentena. No declarar terminada la migración completa.

Contrato, inventario, recuperación, dependencias, coste y lote de activación:
`back-dev/docs/security/meta-email-stage1.md`. API fuente: `src/Documentacion/13-backend.md`.
La publicación de estos archivos a DEV no activa protecciones en servicios.

## 13/09/2026 — Fundamento de altas Ads y prioridad Meta/doble factor

Preparados ámbito/solicitudes independientes, autorización del conjunto original
y cliente interno de altas Ads. La barrera de credenciales Google consulta ambos
registros por ID/sujeto, incluso si desaparecen las asignaciones. Cancelación en
el broker antes de preparar, durable y sin secretos; una cuenta no verificada
no queda reservada ni revocada para otra clínica.

DDL `20260913120000` obligatoria antes del código **aunque el gate esté apagado**;
pendiente en BD compartida. QA: 574 tests Node (391 backend, 183 broker), 141 checks
en nueve MySQL propios, cierre 0 en todos. Sin cambios de UI, runtime ni OPS.
Faltan escritor, conciliador, conexión con bajas/API/Ajustes y auditoría humana.

Por indicación del usuario, se cierra este fundamento ya probado y se prioriza
una primera etapa de protecciones Meta y doble factor. El alta general Ads se
aplaza; ni esta entrega ni las pruebas ficticias acreditan esa etapa terminada.

[Contrato, dependencias y límites](security/google-ads-enrollment-application.md).
[Objetivo de la primera etapa y entregas](security/incremental-delivery-plan.md).

## 13/09/2026 — Alta de cuentas Ads: motor del broker preparado

El broker incorpora discover/prepare/activate/status sobre un ámbito explícito
independiente de las cuentas existentes. Preparación durable sin lecturas de
campañas; activación y recibo/auditoría atómicos. Consulta MCC fija, claves de
alta/lectura/baja/OAuth separadas, límites, historial de revocación y revalidación
bajo el lock de SQLite. Una baja prevalece sobre recibos anteriores y peticiones
en vuelo; retirar una cuenta no retira el ámbito de alta.

QA: 178 tests del broker, incluidos 15 nuevos, todos correctos; HTTPS local,
SQLite privados, reinicio, auditoría y proveedores/SDK ficticios. No se ha cargado
la BD clínica. Tabla e índice nuevos solo en el store SQLite del broker; no hay
nueva migración compartida, variables, jobs ni cambios de interfaz. Configuración
real intacta, OPS aplazado y cero cuentas reales incorporadas o despliegues.

Falta conectar este motor con la API/Ajustes: ámbito e intención persistentes,
permisos sobre el conjunto original y usos compartidos/primarios, conciliación de
activación y auditoría humana. El alta general y la primera identidad Google aún
no están completas. Siguen pendientes cambios de propietario, otros consumidores,
auditoría completa, costes/controles AWS y cifrado/corte BD.

[Contrato, límites y siguiente integración](security/google-ads-enrollment-migration.md).

## 13/09/2026 — Asignaciones Ads gestionadas

[Selección, consulta, baja, auditoría y preparación staged](security/google-ads-mapping-migration.md).
Guardado y bajas probados con ficticios; no hay alta general de grants, corte de
cuentas reales o despliegue. OPS aplazado.

## 13/09/2026 — Inventario y estado Ads por broker

Listado y estado Ads preparados sin tokens SQL para cuentas registradas.
Nueva google.ads.discovery.read.v1: resumen de una cuenta/gestor fijados, campos
cerrados y sin búsqueda libre. Comprueba aliases, grupos, revocaciones y permisos
antes/después; una cuenta de grupo conserva su tenant original. Hasta 20 cuentas,
cuatro inventarios simultáneos y 60 segundos cooperativos, sin resultados parciales.

Ambas rutas requieren ámbito explícito/write y sesión gestionada en modo broker.
El estado acredita solo registered_accounts_read. Legacy conserva los motivos del
selector con carga/refresh condicionados y cierre ante nuevas marcas gestionadas.
Sin nueva DDL, variables o jobs; catálogo 48. Gates/configuración reales intactos.
QA: 538 tests Node (367 backend, 163 broker, 8 modelo frontend) y 15 checks en
un MySQL propio con cierre 0; incluye TLS y HTTP reales con servicios ficticios.

Alta/remapeo y otros consumidores siguen pendientes. También auditoría completa,
costes/controles AWS y cifrado/corte BD; OPS aplazado, cero cuentas reales migradas.
[Contrato y evidencia](security/google-ads-discovery-migration.md).

## 13/09/2026 — OAuth Ads preparado en broker, API y Ajustes

Google Ads se incorpora como cuarto servicio (google_service=ads), con identidad
fijada, PKCE/staging/activación y principal OAuth independiente. Comprueba todos
los grupos, aliases y clínicas de la credencial antes y después del callback;
revocaciones, pérdida de permisos o cambios de consumidores impiden activarla.
Credenciales actualizadas no acreditan acceso ni eliminan bloqueos anteriores.

DDL 20260913100000 amplía los dos ENUM OAuth; conserva las otras tres cohortes
y rechaza down si queda cualquier binding o solicitud Ads. No aplicada a la BD
compartida. Auditoría v10 admite Ads; catálogo de jobs sigue en 48, sin activar.
QA: 565 tests Node, 19 checks en un MySQL propio con cierre 0, build Angular y
18 capturas Chromium desktop/móvil con datos ficticios. Sin llamadas reales.

Alta/remapeo, otros consumidores, auditoría completa, costes/controles AWS,
cifrado BD y cortes reales siguen pendientes. OPS aplazado; ninguna conexión
real migrada. [Contrato y evidencia](security/google-ads-oauth-migration.md).

## 13/09/2026 — Baja Ads durable y auditoría v11

Desconexión Ads preparada en la transacción de mappings/assignment: registra
intención, bloquea bindings y captura auditoría humana; fallos de otras
integraciones revierten todo. Revisa grupos, overrides, aliases e historial
borrado; usos fuera del ámbito devuelven 409 sin cambios parciales. Worker
independiente confirma con el mismo UUID y conserva el bloqueo si pierde el ACK.

DDL 20260913090000 previa al código aun con gates apagados. Auditoría v11,
status agregado por ámbito y exclusión legacy por ID/subject incluso sin bindings.
QA: 352 tests backend + 47 de auditoría; 116 checks en nueve MySQL propios,
todos con cierre 0. Catálogo preparado de 48 jobs; ninguno activado. Hotfix intacto.

Cero cuentas migradas, AWS/proveedores reales, DDL compartido o despliegue.
OAuth Ads, otros consumidores, auditoría completa, costes y cifrado/corte BD
siguen pendientes; OPS aplazado. Contrato: `docs/security/google-ads-revocation-migration.md`.

## 13/09/2026 — Registro durable y consumidores de lecturas Ads

Sync/backfill conectados en código a las ocho lecturas Ads, con contexto opaco,
permisos de grupos/compartidos y revalidación SQL dentro de las escrituras.
Registro independiente por customer/mapping y exclusión legacy por ID/subject.
QA: 344 tests Node y 106 checks en ocho MySQL propios, todos con cierre 0;
hotfix conservado. DDL 20260913080000 obligatoria antes del código aun apagado,
pendiente en BD compartida. Sin AWS/proveedor real, despliegue, claves o flags.

Baja Ads y OAuth pendientes: desconexión gestionada rechazada con 503 antes de
cambios parciales. Cero cuentas migradas. OPS aplazado; continúan otras cohortes,
auditoría completa, IAM/retención/costes/Budget y cifrado/corte BD.

[Contrato y dependencias](security/google-ads-backend-migration.md).

## 13/09/2026 — Lecturas de sincronización Ads y colectores tipados

El broker incorpora cuatro lecturas más: estados de publicación, destinos,
inventario de anuncios y métricas diarias. Los colectores aceptan llamadas tipadas;
el lector descarta respuestas incompletas, cambios de recursos y revocaciones
concurrentes. QA: 193 tests (145 broker y 48 backend), HTTPS local, ambos
colectores y 100.001 anuncios ficticios paginados sin pérdida de filas. Sin DDL, UI, AWS/proveedor real, configuración instalada o despliegue.

Registro persistente, autorización clínica/grupo/compartidos y baja Ads todavía
pendientes; sync/backfill aún no inyecta el lector. Cero cuentas migradas.
OPS aplazado; continúan los pendientes de otras cohortes, auditoría completa,
IAM/retención/costes/Budget y cifrado/corte BD.

[Contrato y dependencias](security/google-ads-read-broker.md).

## 13/09/2026 — Motor de lecturas Google Ads preparado en el broker

Cuatro lecturas Ads tipadas fijan cuenta/gestor, GAQL y campos; OAuth y developer
token permanecen en el broker. Paginación acotada en memoria y control de baja
con principal/clave separados. QA: 138 tests del broker, incluidos 15 nuevos Ads,
HTTPS local, 10.001 filas ficticias y bloqueo tras reinicio. Sin DDL, UI,
configuración instalada, AWS/proveedores reales o despliegue. Cero cuentas Ads
migradas: registro/adaptador backend, OAuth Ads, otros consumidores y corte real
siguen pendientes. OPS aplazado; IAM/retención/costes/Budget/BD pendientes.

[Contrato, QA y dependencias](security/google-ads-read-broker.md).

## 13/09/2026 — Cierre de credenciales antiguas en consumidores Google Ads

La carga/renovación Ads preparada consulta los marcadores durables de Google
antes de leer o guardar tokens. Sync/backfill revalida cada petición; Diagnostics
y Health comprueban sus cachés. Conserva selección clínica/grupo y grants ambiguos.
QA aislada: 238 tests Node, contrato de desconexión separado y 11 comprobaciones
MySQL con cierre 0. Hotfix conservado. Ads aún necesita su adaptador al broker;
los consumidores legacy sin marcador no están migrados. Sin nueva DDL, UI,
despliegue o proveedor real. Esquema Google previo obligatorio incluso apagado.
OPS sigue aplazado; costes/retención/IAM/Budget y corte de BD pendientes.

[Contrato, evidencia y límites](security/google-ads-legacy-boundary.md).

## 13/09/2026 — Reautorización Google por servicio en API y Ajustes

La reautorización preparada separa Business Profile, Search Console y Analytics
por cuenta/conexión, con sesiones gestionadas y permiso sobre todos los consumidores,
compartidos y primarios. Conserva solicitudes GBP antiguas, bloqueos y control de
identidad. API/worker capturan servicio y ámbito en SQL; callback y estado no
mezclan referencias. Ajustes ofrece estados y reautorización por servicio.

Auditoría v10 para la política nueva, con actor, ámbito, proveedor y compromiso
del conjunto de clínicas; v8 histórico conservado. QA ficticia: 180 tests Node
(133 backend, 41 auditoría, seis frontend), 92 checks MySQL en siete bases propias
con cierre 0, build Angular y 24 capturas Chromium desktop/móvil. Cuatro contratos
correctos, scheduler 47. Hotfix conservado. DDL 20260913070000 y dependencias antes
del código incluso con gates apagados; writer/reader v10 antes de emitir.

Cero migraciones compartidas, despliegues, configuración instalada o llamadas
AWS/proveedores reales. OPS aplazado; apagado EC2 anunciado sin verificar. Altas/remapeo generales, otras integraciones, auditoría completa, retención/IAM/costes/
Budget y cifrado/restauración/corte BD siguen pendientes. El push no activa flujos.

[Contrato, QA y corte pendiente](security/google-oauth-services-migration.md).

## 13/09/2026 — Motor OAuth SC/GA preparado en el broker

El broker prepara begin/finish/activate/status/abort OAuth separados para SC y
GA, con identidad y propiedad fijadas, permisos readonly por vertical y tercer
principal/clave independiente. V3 previo incompleto exige nuevo refresh; staging,
activación y conciliación sobreviven a ACK perdido/reinicio. Nuevas credenciales
conservan bloqueos y descartan respuestas de la versión anterior.

QA ficticia: 255 tests Node (123 broker, 132 backend), incluidos los flujos GBP,
SC y GA por HTTPS local. Hotfix conservado. Sin nueva DDL/QA MySQL/UI, despliegue,
configuración instalada, cambios de pausas ni llamadas AWS/proveedor reales.
OPS aplazado; apagado EC2 anunciado sin verificar.

API/UI de reautorización aún GBP: faltan selección por cohorte y autorización
sobre todos sus consumidores, intenciones SQL/captura humana, callback/estado e
interfaz SC/GA. La baja durable del bloque anterior permanece preparada. No
activar por tener el motor interno. Otras cohortes, auditoría completa,
retención/IAM/Cost Explorer/Budget y cifrado/restauración/corte BD siguen pendientes.

[Contrato, QA y pendientes](security/google-property-oauth-broker.md).

## 13/09/2026 — Baja durable SC/GA conectada a la API

Preparada la baja SC/GA desde API con intención SQL, bloqueo local y auditoría
v9 atómicos junto a los mappings/assignment. Comprueba compartidos y primarios,
preserva overrides y revierte todo si afecta fuera del ámbito. Worker con
lease/CAS y replay confirma el broker; el estado agrega GBP/SC/GA. Los marcadores
sobreviven a borrados/recreaciones y cierran legacy por ID/subject.

QA ficticia: 265 tests Node (132 backend, 93 broker, 40 auditoría), 79 checks
MySQL en seis bases propias con shutdown 0 y cuatro contratos, incluido scheduler
47 jobs. Hotfix getAssetStats conservado. Nueva DDL 20260913060000 y dependencias
antes del código incluso apagado; writer/reader v9 antes de emitir. Ninguna
migración compartida, despliegue, clave/grant instalado ni cambio de pausas/UI.

OPS aplazado y apagado EC2 anunciado sin verificar. Sin AWS/proveedores reales.
Altas/remapeo, OAuth/estado/UI generales SC/GA, otras cohortes, auditoría completa,
retención/IAM/Budget/Cost Explorer y cifrado/restauración/corte BD siguen pendientes.
Este bloque actualiza el estado de los apartados históricos siguientes.

[Contrato, QA y requisitos del corte](security/google-property-disconnect-migration.md).

## 13/09/2026 — Controles de revocación SC/GA preparados en el broker

El broker admite bloqueo durable de Search Console y GA4 por clínica/conexión/
propiedad, con grants y claves de control separados de lectura. Persiste bloqueo,
auditoría v2 y resultado juntos; replay tras reinicio y descarte de respuestas
posteriores a la revocación. No consulta secretos ni llama a Google para bloquear.

QA aislada: 202 tests Node (93 broker, 109 backend), incluido HTTPS local firmado,
reinicios, SQLite y hotfix getAssetStats. Sin nueva DDL ni QA MySQL/UI en este
bloque. DELETE Google, cola/worker, estado y auditoría humana SC/GA aún pendientes:
la desconexión durable conectada a la API sigue cubriendo GBP. Todas las
migraciones compartidas y despliegues siguen pendientes. OPS aplazado; sin AWS,
proveedores reales, cambios de pausas ni verificación del apagado EC2.

[Contrato y próximos pasos](security/google-property-revocation-control.md).

## 13/09/2026 — Propiedades Google con varios mappings y acceso compartido

SC conserva varios vínculos legítimos por propiedad mediante registro compuesto
site_hash/mapping_id, estados independientes y cierre de recreaciones/fallback.
Discovery SC/GA incorpora mappings compartidos/primarios vigentes del mismo
grupo con permiso de la clínica destinataria y grant del origen. Revalida el
inventario tras cada lectura y al terminar; no carga configuración de otros
proveedores ni altera assignments, publicidad o UI.

QA ficticia: 188 tests Node (109 backend, 79 broker), 59 checks MySQL propios
(20 GA, 20 SC, ocho legacy, once OAuth) con cierre 0 y tres contratos, incluido
scheduler 46 jobs. TLS local de ambas cohortes y hotfix getAssetStats conservados.
Nueva DDL 20260913050000 y dependencias: **pendiente en BD compartida**, previa
al código aun desactivado. Ningún despliegue, llamada AWS/proveedor o cambio de
pausas/OPS; OPS aplazado y apagado EC2 anunciado sin verificar. Ciclo de vida/UI
completos, otras cohortes, auditoría completa, retención/IAM/Budget/Cost Explorer
y cifrado/restauración/corte BD siguen abiertos.

[Contrato, QA y lote pendiente](security/google-shared-property-migration.md).

## 13/09/2026 — Listado SC/GA de propiedades registradas por broker

Preparados listados SC/GA y estado GA sin tokens SQL para registros gestionados.
Dos operaciones GET cerradas, sesión vigente y revalidación de todo el ámbito.
GA conserva grants por clínica de una propiedad compartida; muestra identificador
de cuenta. La API genérica de estado Google cierra legacy antes de hidratar
credenciales. La incorporación/remapeo y ciclo OAuth/UI completos siguen pendientes;
SC conserva su restricción de mapping original. No se activa Ajustes todavía.

QA ficticia: 174 tests Node (79 broker, 95 backend), 49 comprobaciones MySQL propias
(16 GA, 14 SC, ocho legacy, once OAuth) y tres contratos, incluido scheduler de
46 jobs. HTTPS local firmado en ambas cohortes, bloqueo tras reinicio y hotfix
getAssetStats conservado. Sin nueva migración: requisitos GBP/OAuth/SC/GA y
sesiones previos al código aun con gates apagados. Cero despliegues/migraciones
reales. OPS aplazado, apagado EC2 anunciado sin verificar; sin AWS/proveedores
reales ni cambios de pausas. Coste/cuotas reales, auditoría completa, retención,
IAM/Budget/Cost Explorer y cifrado/restauración/corte BD continúan pendientes.

[Contrato, límites y lote pendiente](security/google-property-discovery-migration.md).

## 13/09/2026 — Lecturas GA4 por broker preparadas

Nueve familias GA4 en analyticsSync y backfills usan referencias y tokens
confinados al broker para propiedades registradas. Registro independiente por
propiedad/mapping conserva varios vínculos legítimos de clínicas y bloquea
recreaciones/fallback. Amplía el cierre global OAuth/legacy por ID o subject.
KeyEvents mantiene la columna histórica conversions; el job informa límites,
muestreo, umbrales, moneda y zona mediante dataQuality. No envía conversiones.

QA ficticia: 147 tests Node (75 broker, 72 backend), 44 checks MySQL propios
(13 GA, 12 SC, ocho frontera legacy, once OAuth) con cierre 0 en cuatro bases,
y tres contratos (scheduler 46 jobs, caducidad GBP, multigrant). TLS GA repetido
tras la última revisión del adaptador. Hotfix getAssetStats conservado.

Esquema nuevo 20260913040000 y dependencias previo al código **aun con gates
apagados**. Cero migraciones reales o despliegues. OPS aplazado; apagado EC2
anunciado sin verificar. Sin AWS, proveedores reales, cambios de pausas o UI.
GA/SC discovery y ciclo OAuth completos, otras cohortes, auditoría de usuarios,
retención/IAM/Budget/Cost Explorer y cifrado/restauración/corte BD pendientes.

[Contrato, QA, costes y lote pendiente](security/google-analytics-read-migration.md).

## 13/09/2026 — Lecturas Search Console por broker preparadas

Cuatro lecturas cerradas de Search Console, referencias por propiedad/identidad,
renovación confinada al broker y adaptadores de rutas web/sync/backfills.
Registro independiente impide fallback y también cierra OAuth/credenciales
legacy por ID o subject. HTTP revalida sesión gestionada, permiso e inventario
antes/después de leer; status distingue metadata de disponibilidad real.

QA ficticia: 126 tests Node, 31 checks MySQL en tres bases propias con cierre 0
y tres contratos (scheduler 46 jobs, caducidad GBP, multigrant). Migración nueva
`20260913030000` y dependencias, **antes del código aun con gates apagados**;
solo ensayada localmente. Cero conexiones migradas, sin despliegue ni cambios
UI. Amplía el bloqueo SC/GA del bloque anterior; GA y OAuth/discovery SC completos
siguen pendientes.

OPS aplazado; apagado EC2 anunciado, no verificado. Sin AWS, proveedores reales,
BD compartida ni cambios de pausas. Persisten cohortes restantes, auditoría
completa/retención, IAM, conciliación Budget/CloudFormation, Cost Explorer/tags
y cifrado/restauración/corte BD. Paginación de 500 filas, hasta 50 llamadas por
intervalo: coste/latencia reales pendientes de medir, sin gasto inventado.

[Contrato, límites, costes y lote pendiente](security/google-search-console-read-migration.md).

## 13/09/2026 — Cierre de credenciales legacy para Search Console y GA4

Preparada una frontera SQL por ID e identidad Google: un registro OAuth del
broker impide cargar/renovar credenciales desde las rutas web y los jobs SC/GA,
incluso con gates apagados. Revalida cachés y respuestas; Analytics informa fallo
si no se procesa ninguna propiedad. SC/GA aún no tienen adaptadores de lectura
al broker: sus conexiones sin marcador siguen legacy.

QA ficticia: 47 tests, ocho comprobaciones MySQL propias y tres contratos
adicionales (scheduler de 46 jobs, caducidad GBP y multigrant). Sin nueva
migración: requiere `20260913020000` antes del código. Sin despliegue, BD
compartida, llamadas AWS/proveedores ni cambios de UI. OPS aplazado; apagado
EC2 anunciado, no verificado. Cohortes reales, auditoría completa, retención,
permisos/Budget, costes verificados y cifrado/corte BD siguen pendientes.

[Contrato, alcance y lote pendiente](security/google-web-credentials-boundary.md).

## Decimocuarto bloque: reautorización Google preparada (13/09/2026)

La reautorización de una identidad Google previamente vinculada intercambia y
versiona credenciales dentro del broker. La API conserva referencias y una cola
SQL: sesión/ámbito revalidados, state de un uso, activación posterior al commit,
conciliación de respuestas perdidas y auditoría v8 del usuario/worker. Ajustes
distingue pendiente/cancelada/confirmada, con actualización manual. Se conservan
bloqueos anteriores y no se reutiliza un refresh que consta revocado.

QA ficticia: 139 tests, 11 comprobaciones MySQL propias con cierre 0, contrato del
catálogo de 46 jobs, Angular exit 0 y 20 capturas Chromium desktop/móvil.
Migración `20260913020000` solo ensayada; previa al código incluso con gates
apagados. El primer vínculo cierra OAuth legacy globalmente: corte/drenaje,
traslado de secretos, consumidores, sesiones, grants y permisos AWS pendientes.
Se admite una assignment exacta por conexión; alta de identidades nuevas y
cohortes restantes siguen pendientes. No hay despliegue ni validación real.

OPS aplazado; apagado EC2 anunciado, sin verificar. No se han cambiado AWS,
pausas, BD compartida ni proveedores. Auditoría completa, retención DPD,
permisos/Budget CloudFormation, Cost Explorer y cifrado/corte BD siguen pendientes.
[Contrato, pruebas, costes y lote pendiente](security/google-oauth-broker-migration.md).


## Decimotercer bloque: desconexión durable de activos GBP (13/09/2026)

Desconectar Google por ámbito registra intención/usuario/auditoría v7 junto al
cambio SQL. Devuelve 202 mientras falta confirmación del broker; un job apagado
por defecto reintenta con el mismo UUID. Bloqueos independientes sobreviven a
borrar/recrear mappings. Separa claves/grants de lectura y control y añade
estado pendiente/confirmado en Ajustes y referencias en el visor de auditoría.
Es revocación de acceso por el broker; el token OAuth Google no se revoca.

QA ficticia: 114 tests, contratos de desconexión/orquestación, 17 comprobaciones
MySQL en dos bases propias con cierre 0, Angular exit 0 y 16 capturas Chromium
desktop/móvil. Migración `20260913010000` solo ensayada; previa al nuevo código
incluso con gates apagados. Writer/reader v7 y grants de control antes de activar.
Sin despliegue, BD compartida, llamadas AWS ni proveedores. OPS aplazado; apagado
EC2 anunciado, no verificado. OAuth completo, demás cohortes, retención,
permisos/Budget CloudFormation, Cost Explorer y cifrado/corte BD pendientes.
[Contrato, costes, límites y lote pendiente](security/google-business-profile-revocation-migration.md).

## Undécimo bloque: listado GBP por grants (13/09/2026)

[Contrato de API, límites y corte](security/google-business-profile-discovery-migration.md): séptima lectura cerrada,
resolver de conexión sin columnas de tokens y listado solo de fichas registradas.
Revalida sesión/scope/mappings, devuelve DTO completo o error y cierra el
remapeo y descubrimiento legacy globalmente tras el primer registro. Este
impacto debe aceptarse en el canary; no hay nueva migración. QA offline:
61 tests y diez checks MySQL propios, sin UI cambiada ni despliegue.
OPS queda aplazado por indicación del usuario, sin modificar sus procesos.
El usuario anuncia apagado de la instancia AWS; estado efectivo no consultado.
Continúan las demás cohortes, OAuth completo, auditoría/retención y corte BD.

## Lecturas de Perfil de Empresa preparadas (13/09/2026)

[Operaciones, referencias, OAuth interno, QA y corte pendiente](security/google-business-profile-read-migration.md).
Dos jobs usan seis operaciones del broker para ubicaciones marcadas, sin cargar
tokens legacy. Arranque explícito separado; no desplegado ni activado. Migración
`20260913000000` solo probada en MySQL propio. OAuth/OPS/lifecycle y retirada de
credenciales Google compartidas siguen pendientes antes del corte real.


## Noveno bloque: acceso en tiempo real preparado (12/09/2026)

[Contrato y corte](security/realtime-access-migration.md): permisos del recurso
reevaluados para cada destinatario, suscripciones actuales, proyección cerrada
y captura v5 apagada. Sesión/permisos se repiten tras persistir auditoría y
antes de enviar. Bus interno y pausas conservados. QA ficticia, sin despliegue,
AWS ni migración compartida. Writer/reader v5 antes de activar captura;
medir carga SQL y volumen por pestaña. El registro prueba preparación, no
recepción del paquete. REST, escritores de membresía y cohortes reales siguen
pendientes. Las notas anteriores sobre sockets describen el bloque anterior.

## Políticas de acceso y auditoría (preparadas, 12/09/2026)

[Contrato de esta cohorte](security/permission-audit-migration.md): cuatro rutas,
propiedad completa del grupo, cambios y auditoría atómicos, editor con
confirmación del backend y snapshot del catálogo. Gate apagado; no desplegado.
No completa cambios de membresía, asignaciones ni permisos de sockets.

## Lector y visor de auditoría (preparados, 12/09/2026)

[Contrato, QA y lote de lectura/conciliación](security/audit-reader-view-migration.md).
Consulta por versiones S3, auditoría v3 de consultas y conciliador de recibos.
Gates apagados; identidad/TLS/retención/BD compartida/despliegue pendientes.
El journal propio es local y el índice no demuestra cobertura exhaustiva.

## Sesiones persistentes (preparadas, 12/09/2026)

Ver [contrato y migración de sesiones](security/access-session-migration.md).
Incluye API de logout/me, auditoría transaccional, REST/sockets, QA ficticia y
orden del corte. No hay migración compartida ni activación por publicar código.


Este índice separa la arquitectura general de los procedimientos que deben usarse para operar o verificar Marketing. La fuente canónica de arquitectura es `src/Documentacion/13-backend.md`; su copia en el repositorio frontend es un espejo completo para conservar enlaces internos y debe sincronizarse después de cada cambio.

## Seguridad: AWS, Integraciones Y Auditoria (2026-09-12)

[Runbook de migracion](./security-integrations-audit-migration.md): fases,
consumidores, pruebas, push selectivo, despliegue y rollback. Complementa el
contrato frontend `src/Documentacion/39-seguridad-integraciones-cifrado-auditoria.md`.
El [prompt de ejecucion](./security-integrations-migration-codex-prompt.md)
queda versionado para la tarea delegada; no requiere copiar incidentes privados.
Infraestructura comunicada por el aprovisionador, no migracion ejecutada.
Mantener el hotfix de `getAssetStats`, Meta bloqueado y el trabajo concurrente
de campanas; no promover todo DEV ni aplicar todas las migraciones pendientes.

Costes: [colector, caché, API, QA y lote pendiente de activación](../services/aws-cost-collector/README.md).
Estado y evidencias: [matriz de implementación](./security/implementation-status.md).

BD: [diagnóstico real de metadata, TLS preparado y restauración ficticia](./security/database-encryption-remediation.md).
No activar cifrado/rotación ni cambiar la BD compartida fuera de su lote aprobado.

Auditoría: [autenticación durable preparada, cobertura y límites](../services/platform-audit/README.md).
Captura, writer por lotes y monitor de panel preparados/apagados; instalación,
lector/visor, AWS y demás dominios pendientes.

## Cierre funcional Marketing Web W1-W5 (2026-07-19)

La referencia vigente del candidato es backend `7bd254e` (staging
`d99c3a6`) y frontend `379a9570` (staging `a1ae678f`). Cierra el editor
**Guiado/Avanzado** con ACL y reordenación
contextual, el listado/editor CMS y los ajustes General/SEO/Social, las cinco
plantillas builtin `version=1`/`builtin_revision=2`, y el renderer WordPress
`1.7.0` con globales y galería real. La migración
`20260719174500-harden-web-builtin-templates-v1.js` solo reconcilia hashes
conocidos, usa CAS, verifica el resultado y falla cerrada; no pisa contenido de
usuario y su rollback es no-op.

Evidencia automatizada: **361/361** Marketing Web backend, **40/40**
WordPress/PHP, **3/3** interoperabilidad, **263/263** Marketing Web frontend,
**88/88** focales de editor/CMS y TypeScript verde. Los recuentos inferiores
que aparecen en cortes posteriores de este documento son históricos.
El frontend estático acreditado es el build `a8170ed3c0c644ef`, con 482
ficheros e `index.html` SHA-256
`b39aaed67329ead594d53fe5738afda0e3d725320ef70861c2419c3d42dcd570`.

La evidencia pública final usó publicación
`77d0f7a9-b42e-4844-83d6-cc71d46d14fb`, revisión
`b841dead-f9a7-4d6b-937c-bf7117521559`, deployment
`262d7091-0ff4-441c-979b-0db4cb3aead6`, artefacto
`f2e6f7f7-e08f-408c-9b80-d10d910bc08f` y hash
`f922298aeb6e1e7a5ca25fc3640c38b1d3874f0987427cee6274d97c24e6cdda`.
La ruta `/cita/qa-globales-galeria-20260719/` pasó renderer 1.7, aserciones
públicas y Chromium desktop/móvil; Schema 1 objeto/0 errores/0 avisos;
Lighthouse 88/100/100/69, con SEO deliberadamente reducido por `noindex`, FCP
1,0 s, LCP 3,9 s, CLS 0 y TBT 0. Después se archivó el proyecto y se retiró la
publicación: la retirada se acreditó primero con **410 Gone** y, tras liberar
el tombstone, el readback actual devuelve **404**, sin contenido público. El QA admin
autenticado contra `https://crm.clinicaclick.com` recorrió Proyectos y
Contenidos a `1440` y `390`: cuatro HTTP 200, sin overflow, page errors,
requests fallidas ni errores HTTP. Evidencia en
`/home/ubuntu/qa-evidence/marketing-web-editor/staging-admin-overflow/`.

Límites vigentes: `connect_only` = **Mide y entiende**,
`guided_improvement` = **Mejora**, `managed_service` = **Piloto** y
`managed_self` queda solo como legado de lectura: la UI no ofrece edición ni
transiciones y el backend rechaza cualquier actualización con
`409 legacy_mode_read_only` ante edición, creación o transición de estado.
Propdental sigue en `connect_only`;
flags hosted/custom y de mutación de proveedor apagados. La migración `1520`
continúa cancelada/no-op. La protección de propietarios en
`personal.controller.js` tampoco pertenece a este cambio: personal operativo
usa `team.manage`, pero `owner_membership_manage_forbidden` y
`owner_unlink_forbidden` deben permanecer fail-closed.

## Marketing, intake y Google Ads

| Documento | Cuándo usarlo |
|---|---|
| [Google Data Manager: conversiones server-side](./google-data-manager-conversions.md) | Contrato de transporte, Conversiones mejoradas, Consent, evidencia controlada, estados asíncronos, reconciliadores y runbook de atribución real. |
| [Política de goals Google Ads v4](./google-ads-goal-policy-v4.md) | Custom goals, cohortes, lifecycle, aprobaciones, executor y límites entre `connect_only` y `managed_service`. |
| [Google Ads Standard Access](./google-ads-standard-access.md) | Límites de acceso/proveedor y resumen externo del diseño actual. |
| [Diagnóstico de medición por campaña](./google-ads-campaign-measurement.md) | Diferencia conversiones principales, todas las conversiones y leads CRM; comprueba destinos/cobertura sin modificar campañas. |
| [E2E controlado de intake y limpieza](./intake-e2e-cleanup.md) | Formulario/chat/teléfono, routing estricto, datos sintéticos y limpieza segura. |
| [Activos compartidos de grupo y asignaciones clínicas](./group-asset-mapping.md) | Contrato de conexión única por scope, activo efectivo propio/heredado/asignado, consumo común entre módulos y excepción de alias de ficha solo para reseñas. |
| [Caché persistente de Informes Marketing](./marketing-reports-cache.md) | Snapshots backend de `Mi clínica`, job nocturno, TTL, stale-while-refresh y excepción semanal/on-demand del mapa local. |
| [Visibilidad local en ChatGPT y Gemini](./marketing-ai-visibility.md) | Consultas locales canónicas, autoejecución desde Informes, caché/deduplicación, estados sin secretos y contrato server-side de OpenAI/Gemini. |
| [Adaptador offline ModSuite](./modsuite-offline-adapter.md) | Migración allowlisted de exports legacy a WebDocument v1, informe de revisión, límites y ejecución local sin runtime legacy. |

Meta no tiene paridad de entrega con Google Data Manager en este corte. CAPI
envía eventos web compatibles como best-effort inline cuando el activo/pixel
está configurado; faltan outbox durable, reintentos, idempotencia, diagnóstico
de entrega y los hitos CRM offline `qualified_lead`/`schedule` para Meta.

## Marketing Web: editor y publicación

Fuente canónica de arquitectura: `src/Documentacion/13-backend.md`, secciones
**Marketing Web W0-W5**. Producto/roadmap: repositorio frontend,
`src/Documentacion/20.14-marketing-web-editor-cms-seo-publicacion.md`.
Operación WordPress: `wordpress/clinicaclick-web/README.md`. Origen alojado:
`ops/nginx/README-marketing-web.md`.

Estado 2026-07-19:

- backend/plugin `2.0.0-alpha.8` promovido en staging e instalado en el
  WordPress de Propdental: registro firmado
  schema 2 para hasta 20 rutas por WordPress, `/cita/` estable más
  `/cita/<slug>/`, tombstones con ACK antes de liberar capacidad, token staged,
  artefactos autenticados por lookup dirigido y reconciliación transaccional
  del runtime de intake. Una instalación `pending` ya no reserva el dominio:
  debe demostrar control con un challenge independiente servido por HTTPS antes
  de recibir desired-state o artefactos. Runtime, registro y manifests se ligan
  a la clave Ed25519 exacta aceptada para impedir replay con una retirada. El
  corte base backend/plugin es `1cdfaa1`, merge de staging `aa8bc4c`; el
  frontend staging asociado llega por `c51537dd`. Después se promovieron los
  fixes de preservación del source HMAC `aacd01b`/staging `4769283`, contrato
  de medición WordPress `29e0179`/staging `93c45f4` y ETag
  `5d11cf8`/staging `e562936`;

- validación del corte: **320/320** contratos Node de Marketing Web,
  **40/40** contratos PHP/WordPress y los tres contratos de interoperabilidad,
  compilador real y ZIP provisionado pasan. La auditoría P0/P1/HIGH termina con
  cero abiertos. La migración de claim pasó además un preflight sobre MySQL real
  en una tabla desechable del esquema de staging y se limpió al terminar. El
  preflight de sobres runtime pasó también sobre MySQL 8.0.42: espera frente a
  un writer previo, fence INSERT/UPDATE/DELETE, caída DDL, rerun, descifrado y
  limpieza final sin tabla/trigger residual;
- ZIP genérico `alpha.8`: 17 entradas, incluida
  `class-ccw-site-claim.php`, SHA-256
  `126e0fb6f77ad08e1c2ed53b673ed094dd25de8ebd99e28d0f167e8439409bc7`.
  El provisionado final contiene 18 entradas y tiene SHA-256
  `86792a2ebf69cd9c36f529f98b1528e2ed5b08c9fe5d33216ea33b348695479f`;

- corte vigente: backend `3f0c0e0`, staging `a22b773`; incluye el cierre E2E de
  intake/snapshot sobre el hardening `8c4fdeb`/`55a34d7`, destinos
  `6fdd153`/`f9c3049` y el fix de consentimiento
  `88b16c6`/`d8b8938` y parte del corte base renderer/herencia
  `b17acf4`/`db348ef`. Frontend fuente `dd138101`, rama staging `cf9805cc`,
  sobre `7435a827`/`522b1fc1`; `front-dev`/ng-serve está actualizado y
  TypeScript pasa. La compilación ng-serve de desarrollo terminó con hash
  `fa3f6c6dfda1977c`; no es un build estático publicado. Las referencias
  anteriores son hitos históricos;
- último frontend estático acreditado: build `2ad4b1b987a9fde2`, principal
  `main.5e80d0ee5d4c9ec5.js` y Marketing
  `3584.9ae0ef3a69fb0819.js`; el copy `dd138101` no tiene aún bundle estático
  nuevo publicado;
- migraciones `19000..25000` aplicadas tras backup, más la aditiva
  `20260718225000-add-campaign-destination-drift-event.js`; 17 tablas y cinco
  plantillas. La migración no sembró policies ni bindings. El E2E posterior sí
  creó el binding auditable de Hospitalet descrito debajo, sin aplicar ningún
  cambio al proveedor;
- las siete migraciones alpha8 —`20260718230000`, `20260718233000`,
  `20260719090000`, `20260719091500`, `20260719093000`, `20260719094500` y
  `20260719100000`— están aplicadas en staging;
- las aditivas `20260719103000` (ejecuciones gestionadas) y `20260719113000`
  (generaciones de contenido), junto con `20260719170000` (identidad de
  snapshot clínico), están aplicadas en staging. `clinic_snapshot_hash` es
  `VARCHAR(64) NOT NULL`, forma parte del índice único y el índice legacy fue
  retirado. Aplicadas no equivale a habilitar mutaciones: los flags gestionados
  siguen apagados;
- gates de staging: editor para scopes Propdental y publicación acotada a
  `group:5,clinic:59` mediante `MARKETING_WEB_PUBLISHING_SCOPES`;
- plugin WordPress `2.0.0-alpha.8` instalado/activo en Propdental junto al
  legado `1.1.7`, con un único loader/bootstrap. WP-CLI y DB están alineados;
  la instalación permanece `connected`. El handshake schema 2, el claim de
  propiedad y la promoción del token staged terminaron correctamente. Antes
  del E2E de rutas, desired/reported coincidían en secuencia de registro 8;
- la caché gestionada queda fuera del document root y tanto sus rutas privadas
  como las antiguas rutas públicas de caché responden `404`;
- instalación `524c2f73-6b69-42f2-8cb0-c8d171575d94` conectada en el origen
  canónico `https://www.propdental.es`; el alta `apex` se normalizó solo durante
  el primer handshake virgen y las comprobaciones posteriores son estrictas;
- `/cita/` está publicada con renderer `clinicaclick-web-renderer/1.7.0`. La
  republicación inicial fue deployment `18fa50be…`, secuencia `11`, artefacto
  `aa05cb59-b27f-4d83-b8fb-f6ef0d4d5cb9`, hash `648cf766…` y HTML
  `153275eb…`; GET `200`, condicional `304`, `warnings=[]`, dirección/horario
  Schema presentes y ninguna imagen de clínica insegura. 1.6 y sus secuencias
  8–10 quedan como evidencia histórica;
- intake E2E pasó dos veces y `LeadIntake #7261` terminó atribuido a clínica
  `59`/grupo `5` antes de su limpieza completa; rollback real publicó la
  revisión temporal 3 y volvió por secuencia 6/job `31699` a revisión 2/LKG;
- el E2E posterior de `alpha.6` confirmó atribución
  `clinicaclick_web_publication` a través del relay first-party y terminó con
  cero leads/eventos/filas WhatsApp sintéticos y cero intentos Google;
- el E2E público multi-route de `alpha.8` quedó cerrado sobre el proyecto
  desechable `f758cce8…` y la publicación `69f06cf0…`: ruta A
  `e2de500c…`/artefacto `831177bc…` y ruta B
  `4c1f3005…`/artefacto `0b9a41a2…` verificadas, con rollback de A acreditado.
  Un formulario terminó en `303` y creó `LeadIntake #7269` con clínica
  `59`/grupo `5` y proyecto/revisión/publicación/artefacto/formulario exactos,
  además de `FormSubmissionEvent #24` y `WebEvent #38157`; no llevaba click IDs
  ni generó intentos Ads;
- la limpieza `dry-run -> simulate -> apply` dejó cero filas en las 11
  categorías auditadas. El proyecto quedó archivado, la publicación/ruta
  retirada, el tombstone alcanzó desired=reported sequence `12` y la ruta
  respondió `410` mientras estuvo activo. Tras liberarlo, el readback live
  final devuelve `404` y solo permanece activa la ruta piloto. `/cita/` conserva el
  mismo body, SHA abreviado `f3ddf142…`, y el mismo artefacto;
- después del E2E multi-route se recompiló deliberadamente la misma
  revisión/proyecto piloto de renderer `1.2.1` a `1.5.0`, con
  `document_hash=ba60…` y `content_snapshot_hash=5f447…` inalterados. Conservó
  contenido, SEO y Schema; añadió `web_artifact_input_hash` antifraude y el CSS
  de `divider`/`spacer`/`gallery`. El artefacto público vigente tiene hash
  `d875201…`, body SHA `e851688…` y ETag validado;
- Chromium real a `390px` obtuvo `scrollWidth=390`; el único overflow es el
  honeypot deliberadamente fuera de pantalla. El consentimiento es responsive,
  **Aceptar todo** ocupa todo el ancho, desaparece al aceptar y persiste
  `cc_consent_v2`. El formulario conserva 11 campos; no hubo excepciones ni
  fallos de red;
- el ciclo real `1.6 -> rollback 1.5 -> 1.6` quedó acreditado en secuencias
  `8`, `9` y `10`; el rollback histórico citado arriba se conserva como
  evidencia, no como versión live;
- la generación IA E2E `b2f25c1b-9258-4228-bebc-ec636dcf141f` terminó en
  `JobRequest #32302`, proveedor `openai`, modelo `gpt-5.6-sol`,
  `store:false` y Structured Outputs. La propuesta quedó persistida pero no
  aceptada (`accepted_content_entry_id=null`), por lo que no creó entrada CMS
  ni publicación;
- la comprobación **Guardar** de Consent se hizo únicamente en harness: un
  diagnóstico saneado acreditó persistencia del handler, retirada del banner,
  inicialización del runtime y cero `pageerror`. No se presenta como prueba
  pública;
- el monitor horario se ejecutó de forma controlada sobre una publicación:
  `1 healthy`, `0 degraded` a `2026-07-18T13:01:04.689Z`;
- `drift_detected` queda persistido por `CampaignDestinationBindingEvent`; la
  auditoría de destino usa el orquestador común una vez al día (`5 3 * * *`),
  sin autoreparación. La suite de Campañas pasa 34 contratos/46 pruebas;
- hosted/custom domain no están disponibles. La forma hosted canónica
  planificada es `https://sites.clinicaclick.com/<slug>/`; el modelo por
  subdominio/wildcard no está validado. Siguen pendientes DNS/TLS/alta E2E y
  el retiro/deprovisión de ambos canales, incluida la eliminación de Custom
  Hostname/WebDomain;
- staging permite que una clínica resuelva la instalación WordPress activa
  de su propio grupo con `inherited_from_group=true` y `source_scope`. No
  permite cross-group ni que el grupo herede una instalación propiedad de una
  clínica. La publicación mantiene scope de clínica y el grupo administra
  plugin/token/instalación. El E2E Hospitalet acredita campaña -> landing ->
  intake y cleanup sin escrituras externas. Al crearla desde un proyecto
  de grupo, la clínica de `configuration.clinic_id` se bloquea con `UPDATE` y
  se revalida activa y miembro del grupo en la misma transacción; los focos de
  servicios+guards pasan 26/26. La autorización se revalida
  contra membresía activa; cambiar grupo o desactivar la clínica exige retirar
  y confirmar/tombstonear antes sus rutas heredadas —incluidas publicaciones
  `scope=group` materializadas para ella por `configuration.clinic_id`—, y
  reconciliar cualquier runtime/HMAC heredado. Los preflights fallan cerrado
  dentro de la misma
  transacción del cambio de clínica. El editor bulk de grupos tampoco puede
  saltarse estos gates: `groupAssets.updateGroupConfig` centraliza
  `applyClinicMembershipSelection`, bloquea las `Clinica` en orden estable y
  valida retire+ACK y reconciliación antes de cada transición; el controller
  devuelve `409` con su código de dominio. Está desplegado y cubierto por
  `web_group_membership_transition_guard` 4/4 y una focal ampliada 76/76. El
  registry, ACK y artefacto revalidan las publicaciones `scope=group` por
  `configuration.clinic_id`; clínica ausente/inactiva/movida excluye la ruta.
  Los locks clinic/group se ordenan por `effectiveClinicId`. La
  revocación separa el tope de 20 rutas activas del inventario histórico de
  hasta 200: revisa todas y exige retiro+tombstone ACK. Con 21 tombstones, un
  ACK ausente bloquea y los 21 confirmados permiten revocar;
- Hospitalet `59` descubrió durante el E2E una precedencia inválida: su
  `IntakeConfig #81`, útil para integraciones locales pero sin consentimiento
  web completo, ocultaba el consentimiento válido del grupo `#24`. El fix
  `88b16c6`/staging `d8b8938` conserva intake/chat/teléfono/integraciones de la
  clínica y solo hereda el consentimiento del grupo si la clínica pertenece
  realmente al grupo, figura explícitamente en `group.config.locations`, el
  consentimiento local no está listo y el grupal sí. Expone
  `consent_source_scope`, `consent_source_scope_id` y
  `consent_source_intake_config_id`; no existe fallback cross-group. La suite
  Marketing Web completa pasó tras el cambio;
- proyecto E2E `4df293bd-98b9-4dd7-a601-3c557048925c`: intake local `81`,
  consentimiento de grupo `24` listo e instalación WordPress disponible. La
  publicación `fe4dece6-36a8-47f2-86a0-70235f8e11d6`, deployment
  `e5156f84-7977-4c4d-b626-42acd33f7bff` y artefacto
  `dafc020d-03a0-4c6a-9c7f-e4d93fe18376` están verificados para
  `https://www.propdental.es/cita/primera-visita-hospitalet/`;
- renderer 1.7 y la migración
  `20260719170000-add-web-artifact-clinic-snapshot-identity.js` están en
  staging y el piloto público; su tanda focal pasa 43/43. Añaden
  `clinic_snapshot_hash` a DB/marker/manifest/caché para impedir reutilización
  cross-clinic y recompilar al cambiar dirección/horario efectivo. 1.7 puede
  usar dirección/horario de una ubicación verificada, pero no elige la ficha
  por fecha: usa la primaria del grupo o una única asignación explícita; sin
  selección exige una sola ficha directa activa, verificada y no suspendida.
  Ante dos candidatas no completa datos de Google. Esos casos pasan 21/21
  focales. Nunca toma fotos GBP/`googleUrl`: OG/Schema solo acepta la imagen
  canónica pública y no-tiny de Clinicaclick. La primera publicación/readback
  1.7, el target final post-rotación y campaña->ruta Hospitalet están
  acreditados. El lead/intake de Hospitalet también quedó verificado y limpio
  con la evidencia controlada descrita debajo;
- el corte promovido pasa Marketing Web **354/354** Node, WordPress **40/40**,
  Campañas **81/81**, reviewer 96/96 con GO sin high/medium, frontend Marketing 302/302,
  TypeScript app/spec exit `0` y diff-check limpio. Esa validación de código no
  sustituye por sí sola las evidencias públicas posteriores; el readback
  post-rotación y el E2E campaña->ruta ya se acreditaron por separado;
- tras aparecer un HMAC vigente en una salida diagnóstica se rotó sin
  reproducirlo: reconciliación `889cc3a4-7d09-4cb0-accb-65acbdbfbb61`,
  generación 2, `completed`; deployment target `ae350f06…`, artefacto
  `2a2abd9a-9249-44a2-926c-92656084725b`, verificados; accepted keys 2→1 y
  envelopes source/target eliminados. El readback final `/cita/` acredita hash
  `cd4119d…`, HTML `a34a993…`, `304`, renderer 1.7, WebSite/Dentist/WebPage,
  dirección, diez horarios, sin imagen Schema y CSP correcto;
- `6fdd153`/`f9c3049` exporta explícitamente `stableHttpsDestination` para el
  bridge. Job `32462` completó tras retry natural 4/8 y creó binding
  `8a056617-7072-4e2a-9a84-e6438a303175` para estrategia `10` y la landing
  Hospitalet. Como el modo es `connect_only`, quedó bloqueado con
  `measure_mode_never_changes_destinations`; siete cuentas bloqueadas, job
  `32468` completado y cero `marketing_campaign.destination_apply.v1` desde
  las 18:25: **cero mutaciones de proveedor**;
- la landing Hospitalet devuelve `200/304`, hash `3a8aff…`, renderer 1.7,
  formulario, JSON-LD, dirección/horarios, sin warnings/código ejecutable.
  Chromium `1440/390` confirma overflow 0, campos/consentimiento/chat correctos
  y cero errores. Evidencia `campaign-landing17-live/` y
  `campaign-landing17-e2e-evidence.json`;
- el E2E de intake posterior creó temporalmente `LeadIntake #7272`, clínica
  `59`/grupo `5`, `google_ads/clinicaclick_web_landing`, publicación
  `fe4dece6-36a8-47f2-86a0-70235f8e11d6`, binding
  `8a056617-7072-4e2a-9a84-e6438a303175` con `targetKind=general`, assignment
  `28`, customer `1851215478`, campaña `21313059516` y resolución Ads a
  estrategia `10`/request `24`/`target_kind=generic`. Revisión
  `fc244f6e-b0b5-46cf-af72-05041a70c3a3`, deployment `e5156f84…`, artefacto
  `dafc020d…` y hash `3a8aff298c…`. El snapshot inmutable `web_landing` schema `1` validó toda la
  identidad editorial, de scope, Ads y estrategia. La conversión se omitió con
  `no_permitted_identifiers`, `provider_request_id=null` y cero escrituras
  externas. La limpieza dejó lead/form/audit/attempt/eventos en cero y eliminó
  ocho eventos preflight. Evidencia saneada:
  `campaign-landing17-lead-e2e-evidence.json`;
- el hardening `8c4fdeb`/`55a34d7` congela modo/estado/scope/mandato/cohorte y
  destino/operación mediante digests, exige estrategia activa y revalida en
  request y worker antes/después de mutate y readback. Cambio de estrategia,
  revocación managed o cuenta fuera del target bloquea antes del proveedor; un
  binding legacy sin digest exige refresh. Los jobs hermanos no se invalidan
  por `binding.version`. Tras un downgrade, el único cambio permitido es un
  rollback automático/manual al `beforeState` capturado por la operación antes
  autorizada, nunca una URL libre ni un destino nuevo. La atribución legacy
  recupera `general`/`generic` solo ante una pareja cuenta/campaña única del
  target exacto. Auditor independiente GO, focales 29/29 y Campañas 81/81;
- el router live corrige el magic-quotes que WordPress aplica a
  `HTTP_IF_NONE_MATCH`. Cloudflare y origen devuelven `304` con el
  `If-None-Match` exacto. HMAC y ETag quedan cerrados; hosted/custom conservan
  sus gates externos.

La migración `20260715152000-purge-google-places-competition-content.js` está
cancelada y sus `up`/`down` son no-op. No es una migración pendiente ni debe
reactivarse.

Evolución del contrato, incluida aquí como contexto histórico del corte live:

- renderer `clinicaclick-web-renderer/1.3.0` introdujo cabecera y pie globales
  por página y formulario global con contrato por página;
- `1.4.0` añadió las primitivas cerradas `divider` y `spacer`; `divider` emite un `<hr>` semántico con
  `line_style=solid|dashed|dotted` y `tone=muted|brand|accent`; `spacer` emite un
  elemento presentacional `aria-hidden` con `size=xs|sm|md|lg|xl|2xl`. Ambos
  exigen `children=[]`, carecen de bindings y solo producen clases/CSS
  allowlisted por el compilador;
- el renderer `clinicaclick-web-renderer/1.5.0` añadió
  `gallery` como décimo nodo seguro: 2–12 assets únicos, columnas 2/3/4,
  `cover|contain`, ratios allowlisted, alt/decorativa, foco y pie por item. El
  resolver congela cada recurso exacto y el compilador genera
  `figure/img/figcaption`, lazy loading y layout responsive;
- una única canonical efectiva alimenta `rel=canonical`, `og:url` y las
  URL/`@id` de WebPage/FAQ; el sitemap solo incluye canónicas indexables del
  mismo origen y excluye canónicas externas;
- el paquete live `clinicaclick-web` `2.0.0-alpha.8` conserva los contratos de
  rutas/formulario global de alpha7 y añade el runtime multi-route acreditado;
  la versión live posterior es `1.6.0`. El runbook
  histórico alpha7 y su rollback alpha6 están documentados; después de schema
  2 el rollback operativo mantiene alpha8 + LKG. La API
  bloquea fail-closed un deployment WordPress con formulario global si el
  plugin es anterior (`409 web_wordpress_global_intake_plugin_outdated`);
  documentos legacy y header/footer globales sin formulario no quedan
  bloqueados por ese mínimo;
- CMS y medios proyectan capabilities del actor y de cada fila, herencia de
  solo lectura, autoría/revisión, flujo `draft -> review -> published` e
  historial inmutable. Los bindings semánticos, incluida FAQ
  `question/answer`, no reutilizan el nombre interno de la entrada;
- la hidratación de medios acepta lotes explícitos de hasta 100 UUID. El
  editor consume esa API para recuperar imágenes de nodos y assets sociales o
  globales sin persistir URLs como autoridad.
- la API revalida `campaign_context`, plantilla, scope y compatibilidad antes
  de crear un proyecto desde campaña; el filtro frontend nunca basta para
  autorizar una combinación.
- el catálogo `GET /marketing/web-templates` pagina en base de datos y expone
  `source_scope`, `source_scope_id`, `managed_by_scope`, visibilidad, estado y
  timestamps sin devolver el documento salvo preview explícita. Solo el scope
  propietario puede editar/archivar; globales/heredadas son de lectura;
- los resolvers `treatment`, `professional` e `intake_config` están
  implementados con allowlists seguras. `intake_config` conserva solo
  `id/scope/inherited`; nunca configuración privada ni HMAC.

Tanda promovida y desplegada:

- `clinicaclick-web` `2.0.0-alpha.7` conserva identidad Web/relay atribuible y
  añade contratos globales por página; `alpha.6` queda como rollback operativo;
- la API separa rollout de disponibilidad real y proyecta capabilities
  fail-closed para WordPress, hosted y custom domain;
- hosted valida pareja Ed25519, firma, bundle exacto, hashes, symlinks, punteros
  y solapamiento de rutas. El preflight ya tiene directorio de hosting y
  challenge ACME, y los rangos Cloudflare coinciden con el snippet, pero sigue
  bloqueado: no hay control DNS/vhost/certificado/flag y HTTP/HTTPS continúan
  `302` DonDominio/`521`;
- `marketing_web_publication_health_monitor` opera cada hora, lote 25,
  sin autoreparación ni APIs publicitarias;
- la suite completa, promoción y E2E público con limpieza están cerrados.
  Esta es evidencia histórica de `alpha.7`: multi-route y rotación Ed25519 no
  estaban en ese runtime. `alpha.8` ya fue migrado/desplegado y los implementa;
  el E2E desechable de dos rutas quedó cerrado con cleanup/tombstone; la
  rotación HMAC y el readback ETag `304` también quedaron cerrados después.
  Hosted/custom siguen bloqueados por
  DNS/TLS/origen/proveedor.

La auditoría Figma se materializó en un onboarding de tres pasos y un selector
de plantillas compatible con la campaña, sin fallback arbitrario. El frontend
recorre todas las páginas del catálogo, deduplica y permite buscar localmente;
el backend solo entrega `preview_document` después de ACL/paginación,
validación canónica y comprobación de hash. La opción libre se llama
**Estructura inicial editable** y explica que crea título, texto, botón y
formulario totalmente editables/eliminables; en contexto de campaña, la
ausencia de una plantilla compatible bloquea el alta en vez de fabricar una
landing vacía. SEO, Social y Schema, el inspector de CTA, el panel de diseño,
el flujo editorial/historial, los globales y la hidratación de medios ya
existen en la implementación. La galería semántica y la autoría
Página/Cabecera/Pie, archivo/restauración de proyectos y la ruta frontend real
`/marketing/web/plantillas` están promovidos. Un archivado no puede
publicarse y restaurar siempre vuelve a borrador. **En aquel corte** quedaban
pendientes la aceptación funcional Figma, los modos/reordenación y el E2E
público; el cierre W1-W5 de la cabecera ya los completa. Se reutiliza la UX, no
el runtime ModSuite. Véase `20.14`/`20.15` en frontend.

Evidencia base: 223/223 contratos Node, 26/26 PHP/WordPress, 3/3 de
interoperabilidad y frontend Marketing Web 153/153. El build staging
limpio `5a08e6a108414a76` está desplegado. Chromium final de solo lectura
cubrió onboarding, editor, CTA, Medios, SEO/Social/Schema, revisiones y CMS en
`1440`/`360`: 13 capturas, todas las aserciones verdes y cero errores de
consola/página/request/HTTP, mutaciones Marketing Web u overflow. El fix
`305d4eae` estabiliza por identidad las opciones CTA y cierra el bucle de CPU
reproducido en Chromium. Backend y
plugin también están live. El readback, relay/atribución, limpieza, rollback y
monitor acreditaron primero el artefacto público renderer `1.2.1`; la misma
revisión/proyecto se recompiló después y aquel corte llegó a renderer `1.6.0`.
El estado vigente es renderer `1.7.0` y sus identificadores/hashes figuran en
la cabecera. El QA
  adicional del diálogo IA y control gestionado en desktop/móvil tiene cero
  overflow, errores y solapamiento; evidencia SHA-256
  `c1f4a16feea37dd8c42917642f9f2a95820f4721781259a0696ed8d91d25f35c`.
  El QA público WordPress separado desktop/móvil confirmó HTTP `200`, mismo
  artefacto, consentimiento aceptado, banner oculto, widget visible y overflow
  `0`; evidencia SHA-256
  `2b7e024f3fb586faf593732a54c40868e5b4d03c87ccda98f7852297ffc0701d`.
  Solo queda el warning benigno de `frame-ancestors` en meta; el header CSP
  real sí lo aplica.
Evidencia incremental: galería backend 3/3, migración drift 3/3, Campañas 34
contratos/46 pruebas, autoría global frontend 92/92 antes de su unión y QA
staging Galería `1440`/`390` con index SHA
`4451d0ba00320451acb788b48ed939d4de30e649fa259e2d383caf3e441cca6c`.

## Orden de verificación

1. Para una incidencia de entrada o sede incorrecta: `intake-e2e-cleanup.md` y la sección de routing autoritativo en `src/Documentacion/13-backend.md`.
2. Para una conversión que no aparece: `google-data-manager-conversions.md`; distinguir intake, intento local, aceptación, Diagnostics terminal y reporting atribuido.
3. Para objetivos o pujas: `google-ads-goal-policy-v4.md`; readiness de conversiones no autoriza una mutación de campaña.
4. Para una fuente que aparece `Pendiente` en un módulo y conectada en otro: `group-asset-mapping.md`; comparar conexión efectiva, mapping, sync y datos por separado, y revisar que el lector incluya el fallback de grupo.

No se deben interpretar un HTTP 200, una acción secundaria creada o un snapshot `activation_readiness` verde como Piloto activo. Propdental continúa en `connect_only` hasta que exista y se apruebe una orden gestionada separada.

En el contrato integrado de tres niveles, `connect_only` se llama **Mide y
entiende**: conecta cuentas existentes, importa/unifica leads, atribuye su
ciclo, envía conversiones consentidas mejoradas/offline y muestra
diagnósticos/recomendaciones. No cambia campañas, custom goals, URLs, pujas,
presupuesto ni estados. Las referencias posteriores a **Conecta y mejora** son
el nombre visible del corte histórico de julio previo a esta integración.

Estado de arquitectura del runtime vigente (actualizado 2026-08-29): registra
**34 tareas periódicas**, **14 integraciones dirigidas/background**, **48 tipos
background** en total y **64 handlers**. `marketing_reports_cache_refresh`
materializa cada noche snapshots persistentes de `Mi clínica` y no refresca el
mapa local. Los tipos dirigidos
`web_content_generation`, `managed_campaign.google_search_create.v1`,
`managed_campaign.google_search_activate.v1` y
`managed_campaign.google_search_rollback.v1` pertenecen al mismo carril durable
`JobRequest`; no crean timers laterales. `web_intake_runtime_reconcile` continúa
registrado como handler del mismo orquestador. La
publicación, los destinos y el monitor Web continúan dentro del mismo
`JobRequest`, nunca en un cron paralelo. El detalle histórico siguiente sobre
outbox/retención se conserva: también son durables `marketing_competition_heatmap_refresh`, `automation_whatsapp_quiet_send`, `whatsapp_template_sync_delayed` e `intake_quickchat_summary_materialize`. Este último es un outbox de prioridad alta compartido por `source_detail=chatbot` y `chatbot_quickchat`: cada payload aceptado conserva en una transacción su audit exacto y job, tanto para un lead nuevo como para uno deduplicado. El JobRequest solo guarda `lead_id + audit_id` más el namespace técnico añadido por la cola; la sede validada queda en `audit.attribution_steps.resolved_clinic_id`. El handler exige esa sede y un mismatch con el lead termina `409` sin Message/socket; solo audits legacy sin marcador caen de forma segura en la clínica del lead. `Messages.metadata.intake_audit_id` impone orden durable: bajo lock del lead, el audit mayor gana y cualquier job antiguo completa como `skipped/stale` sin cambiar contenido, socket ni `last_message_at`; el watermark avanza aunque hash/contenido sean idénticos y un mensaje legacy idéntico adopta el primer marcador. El fast path admite el `result_summary` envuelto por `JobExecutor` y el formato directo compatible de callers/tests, devuelve `saved=true` solo si terminó, `202 + queued` si queda reintentable y preserva `4xx` seguros como el `409` de sede. Si falla el disparo, relee `JobRequest`; si tampoco puede releerlo responde `202 unknown_durable`, no inventa `pending`. Un `chatbot` deduplicado termina con ese outcome antes de Meta/Google para no duplicar conversiones, mientras los demás dedupes conservan `409`. Teléfonos fuera de 9–15 dígitos y emails presentes inválidos devuelven `422` antes de confirmar el lead. `pm2-back-staging` opera con cron leader + worker; las cinco líneas OPS se retiraron del crontab. `#23664-#23670` validaron los bridges y `payloadDefaults`; `#23672` completó la retención real. `SyncLogs` (auditoría funcional BD) y ficheros PM2 (stdout/stderr, 60 días) son retenciones independientes.

### Ejecución gestionada Google Search desplegada y cerrada por flags

Estado a 2026-07-19: el código desplegado permite crear una Google Search nueva en
`PAUSED`, activar después `PAUSED -> ENABLED` y retirar únicamente los recursos
propios. La migración
`20260719103000-create-managed-campaign-provider-executions.js` está aplicada
en staging, pero ambos flags permanecen apagados y no se ha realizado una
llamada ni mutación Google real. Propdental sigue en `connect_only`; este corte no
autoriza convertirlo en Piloto ni tocar sus campañas.

- Registry real único: `google_ads:google_search:create_new`. PMax, Meta,
  `update_existing` y cualquier provider/family/operation no registrado fallan
  antes de red; el dry-run para esas familias continúa siendo solo simulación.
- Flags fail-closed:
  `MANAGED_CAMPAIGN_PROVIDER_EXECUTION_ENABLED=false` por defecto y
  `MANAGED_CAMPAIGN_PROVIDER_ACTIVATION_ENABLED=false` por defecto. Activación
  necesita ambos; apagar un flag no genera un falso éxito.
- Jobs del orquestador común:
  `managed_campaign.google_search_create.v1` (`high`, cinco intentos),
  `managed_campaign.google_search_activate.v1` (`critical`, cinco) y
  `managed_campaign.google_search_rollback.v1` (`critical`, tres). No existe
  timer/worker lateral.
- Persistencia: `ManagedCampaignProviderExecutions` congela plan/hash, versión,
  autorización, reserva, refs, propiedad, snapshots de goal/activación/rollback,
  jobs e idempotencias distintas por fase. Sus estados son `queued`,
  `executing`, `succeeded` —Google `PAUSED` verificado—,
  `activation_queued`, `activating`, `active` —QL + `ENABLED` verificados—,
  `activation_failed`, `failed`, `cancelled`, `manual_recovery_required`,
  `rollback_queued`, `rolling_back` y `rolled_back`.
- Fencing: locks SQL, índice único por campaña/idempotencia, una sola ejecución
  viva, lease owner/version/expiry de 30 minutos, versión de campaña, refs,
  asignación Google, aprobación, moneda y reserva se revalidan en enqueue,
  claim, antes de cada mutación y al finalizar. Las llamadas son
  `singleAttempt`, timeout dos minutos, `validateOnly` previo, mutate atómico y
  readback exacto.
- Activar es siempre otra aprobación: idempotencia y referencia nuevas, seis
  confirmaciones, vigencia 24 h y policy `qualified_lead` aplicada/releída antes
  de `ENABLED`. No usar la transición genérica de lifecycle.
- Rollback solo acepta `succeeded|active|activation_failed`, marca/ref propia y
  confirmación explícita. Elimina esa jerarquía, comprueba su ausencia y solo
  entonces libera la reserva. Ambigüedad, drift, revocación tras posible llamada
  o pérdida del fence conserva fondos/refs y exige recuperación manual.

Runbook de rollout:

1. Confirmar código y migración `20260719103000` ya desplegados con ambos flags
   apagados; comprobar esquema, handlers, listado/capability y cero llamadas Google. No
   ejecutar la migración `20260715152000`: continúa cancelada y no-op.
2. Para un piloto autorizado, usar una campaña Search controlada con spec
   `autopilot + managed`, `approved_to_launch`, cuenta activa, prepago verificado
   y dry-run nuevo persistido. Abrir primero únicamente el flag de ejecución.
3. Confirmar `succeeded`, árbol completo `PAUSED`, refs/marker y reserva. Si el
   resultado es ambiguo, detener; no repetir ni liberar fondos.
4. Solo tras ese readback abrir activación, confirmar policy QL, moneda/zona y
   `ENABLED` exacto. Mantener apagada para el resto la capacidad no acreditada.
5. Para deshacer, usar el rollback de esa misma ejecución; cerrar únicamente
   con `rolled_back` y ausencia verificada. Volver a apagar flags al terminar el
   piloto controlado.

El contrato completo de rutas, gates, estados, UI y recuperación está en
`src/Documentacion/13-backend.md`, apartado **Ejecución gestionada Google
Search: desplegada y cerrada por flags**.

Fix Enhanced verificado: el normalize/merge conserva flags y autorización en top/event/destino. La prueba controlada `#22` acreditó formato/transporte; después, siete intentos naturales `#25/#26/#27/#28/#30/#32/#33` de `1851215478` terminaron `succeeded/SUCCESS` con consentimiento, `user_data_sent=true` y `[email, phone]`. `5992356722` mantiene acciones/readiness y `validateOnly` verdes, pero todavía no un terminal natural posterior a la migración. Las ocho acciones canónicas siguen secundarias, fuera de `Conversions` y con default Google `0`: Mide y entiende enriquece atribución, pero no gobierna la puja.

Auditoría Google live 2026-07-16: las campañas heredadas continúan optimizando acciones legacy; Badalona Search presenta fuerza `POOR`, hay bolsas de keywords con score `<=4`, los ocho asset groups PMax revisados están `AVERAGE`/varios limitados, y las cuatro Smart de `599...` mantienen `TARGET_SPEND` y goals antiguos. La auditoría durable diaria incorpora ahora calidad de campaña read-only: 3 targets Conecta y mejora, 0 goal-policy; el grupo Propdental quedó con medición saludable, `runtime_ready=true` y 8/8 destinos válidos. El primer corte observó 30/30 campañas del snapshot de estrategia; al unir estrategia y campañas autorizadas por medición, el segundo corte observó **35/35** referencias únicas —17 en `185...` y 18 en `599...`—, incluyó las cuatro Smart y devolvió 0 críticos + 92 recomendaciones consultivas. Ambos cortes declararon cero mutaciones y `ChangeEvent=0`. Francia quedó en 4/10 y Eixample en 0/4 por cuentas no asignadas a esos scopes. La calidad no bloquea por sí sola el runtime de medición. `call_reporting_enabled=false` en ambas cuentas sin borrar teléfonos, assets ni histórico. Cualquier corrección de objetivos/campañas pertenece a un Piloto aprobado, no a `connect_only`.

ACL operativa: agencia es marketing-only y solo recibe atribución/pacientes/leads seudonimizados dentro de scopes explícitos. No abre PII, Chat/Registro, QuickChat, Agenda/citas, consentimientos, Personal/equipo, settings, instalaciones, nutrición, dashboard operativo o fusiones. `reception`/`admin_staff` conservan `clinic.settings.edit` + `team.manage` local, pero nunca gestionan owners; backend preserva `owner_membership_manage_forbidden` y `owner_unlink_forbidden`.

Release funcional histórica previa a Web: backend staging `9b82958`, frontend
`3c4593ae`, build `8ca8e450c563e9ee`. El corte Web de aquel snapshot quedó en
backend staging `5e57431`, frontend staging `5f8f8858` y build
`5a08e6a108414a76`; el corte vigente 1.6 está documentado al inicio. Consent v5 sigue vigente. Propdental continúa en
`connect_only`; no se activa Mejora/Piloto ni se cambian goals, URLs, pujas o
presupuesto. Meta Francia no tiene todavía cuenta publicitaria/píxel
configurados. `Conseguir más reseñas` está cerrado/listo.

QA público postdeploy: un chat móvil controlado con Marketing rechazado y sin click IDs seleccionó Sant Martí `56`; `chatbot` respondió `201`, `chatbot_quickchat` deduplicó con `200`, y los outbox `#23818/#23819` completaron al primer intento sobre los audits `#7400/#7401`, una conversación y un único mensaje con watermark `7401`. Hubo cero intentos Google. El lead sintético `#7213` pasó después por `dry-run -> simulate -> apply`; el postcheck comprometido dejó cero restos. Los chats reales huérfanos `#7185/#7195/#7196` se recuperaron exclusivamente mediante los jobs estándar `#23820-#23822`: una conversación/resumen por lead, sede Sants `19`, un intento por job y la cuenta de intentos publicitarios permaneció `3 -> 3`.

Feedback de calidad: pasar un lead a `descartado` requiere `motivo_descarte` y deja auditoría. `tratamiento_no_ofrecido` y `consulta_no_asistencial` son dos opciones visibles, no un enum backend cerrado: primero se comprueba catálogo/derivación o circuito interno. El motivo sirve para diagnóstico y recomendaciones; nunca se adjunta a Google/Meta como texto del paciente.
