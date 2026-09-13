# Seguridad: implementación y evidencias

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

[Contrato y dependencias](google-ads-read-broker.md).

## 13/09/2026 — Motor de lecturas Google Ads preparado en el broker

Cuatro lecturas Ads tipadas fijan cuenta/gestor, GAQL y campos; OAuth y developer
token permanecen en el broker. Paginación acotada en memoria y control de baja
con principal/clave separados. QA: 138 tests del broker, incluidos 15 nuevos Ads,
HTTPS local, 10.001 filas ficticias y bloqueo tras reinicio. Sin DDL, UI,
configuración instalada, AWS/proveedores reales o despliegue. Cero cuentas Ads
migradas: registro/adaptador backend, OAuth Ads, otros consumidores y corte real
siguen pendientes. OPS aplazado; IAM/retención/costes/Budget/BD pendientes.

[Contrato, QA y dependencias](google-ads-read-broker.md).

## 13/09/2026 — Cierre de credenciales antiguas en consumidores Google Ads

La carga/renovación Ads preparada consulta los marcadores durables de Google
antes de leer o guardar tokens. Sync/backfill revalida cada petición; Diagnostics
y Health comprueban sus cachés. Conserva selección clínica/grupo y grants ambiguos.
QA aislada: 238 tests Node, contrato de desconexión separado y 11 comprobaciones
MySQL con cierre 0. Hotfix conservado. Ads aún necesita su adaptador al broker;
los consumidores legacy sin marcador no están migrados. Sin nueva DDL, UI,
despliegue o proveedor real. Esquema Google previo obligatorio incluso apagado.
OPS sigue aplazado; costes/retención/IAM/Budget y corte de BD pendientes.

[Contrato, evidencia y límites](google-ads-legacy-boundary.md).

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

[Contrato, QA y corte pendiente](google-oauth-services-migration.md).

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

[Contrato, QA y pendientes](google-property-oauth-broker.md).

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

[Contrato, QA y requisitos del corte](google-property-disconnect-migration.md).

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

[Contrato y próximos pasos](google-property-revocation-control.md).

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

[Contrato, QA y lote pendiente](google-shared-property-migration.md).

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

[Contrato, límites y lote pendiente](google-property-discovery-migration.md).

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

[Contrato, QA, costes y lote pendiente](google-analytics-read-migration.md).

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

[Contrato, límites, costes y lote pendiente](google-search-console-read-migration.md).

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

[Contrato, alcance y lote pendiente](google-web-credentials-boundary.md).

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
[Contrato, pruebas, costes y lote pendiente](google-oauth-broker-migration.md).


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
[Contrato, costes, límites y lote pendiente](google-business-profile-revocation-migration.md).

## Duodécimo bloque: auditoría de lecturas de pacientes (13/09/2026)

Siete GET de pacientes preparan captura v6 apagada: actor/sesión/ámbito,
IDs y contadores, sin contenido clínico. Revalida permisos y pertenencias
antes y después de persistir; las partes del resultado comparten transacción.
El visor distingue respuesta preparada y descartada, con IDs desplegables.
Corrige escritura de public_id antes de autorizar detalle, vínculos de
contactos y nombre de clínica en mensajes de duplicados; errores de lectura
cerrados. El resto de escrituras y lecturas clínicas mantiene su corte pendiente.

QA ficticia: 75 tests, 58 comprobaciones MySQL propias con cierre 0, contrato
previo de scope, Angular y ocho capturas Chromium desktop/móvil. Nueva
migración `20260913003000` solo ensayada: previa al nuevo modelo incluso con
gate apagado; writer/reader v6 antes de activar. Sin despliegue ni BD compartida.
OPS sigue aplazado y EC2 con apagado anunciado, no verificado. AWS, retención,
Budget/CloudFormation, cohortes reales y cifrado/corte BD siguen pendientes.
[Contrato, coste, cobertura y lote](patient-read-audit-migration.md).

## Undécimo bloque: listado GBP por grants (13/09/2026)

[Contrato de API, límites y corte](google-business-profile-discovery-migration.md): séptima lectura cerrada,
resolver de conexión sin columnas de tokens y listado solo de fichas registradas.
Revalida sesión/scope/mappings, devuelve DTO completo o error y cierra el
remapeo y descubrimiento legacy globalmente tras el primer registro. Este
impacto debe aceptarse en el canary; no hay nueva migración. QA offline:
61 tests y diez checks MySQL propios, sin UI cambiada ni despliegue.
OPS queda aplazado por indicación del usuario, sin modificar sus procesos.
El usuario anuncia apagado de la instancia AWS; estado efectivo no consultado.
Continúan las demás cohortes, OAuth completo, auditoría/retención y corte BD.

## Décimo bloque: lecturas de Perfil de Empresa (13/09/2026)

[Contrato y lote](google-business-profile-read-migration.md): seis operaciones,
dos jobs/contexto sin tokens, referencias persistentes aditivas y arranque Google
explícito con secretos/renovación y auditoría de integraciones v2. QA ficticia:
34 tests broker, cinco adaptador, once hotfix y ocho checks MySQL. Registro
independiente impide fallback al borrar/recrear mappings. Sin cambios
de UI, AWS, OAuth real, BD compartida, PM2 o despliegue. Ninguna ubicación real
migrada; OAuth/OPS/lifecycle y otras verticales siguen pendientes para el corte.
El nuevo incidente WABA y revocación son reportados por el usuario, quien
autorizó reanudar; no se probaron tokens ni se acredita contención total.
Las matrices AWS/BD inferiores mantienen sus pendientes y fuentes históricas.


## Noveno bloque: acceso en tiempo real preparado (12/09/2026)

[Contrato y corte](realtime-access-migration.md): permisos del recurso
reevaluados para cada destinatario, suscripciones actuales, proyección cerrada
y captura v5 apagada. Sesión/permisos se repiten tras persistir auditoría y
antes de enviar. Bus interno y pausas conservados. QA ficticia, sin despliegue,
AWS ni migración compartida. Writer/reader v5 antes de activar captura;
medir carga SQL y volumen por pestaña. El registro prueba preparación, no
recepción del paquete. REST, escritores de membresía y cohortes reales siguen
pendientes. Las notas anteriores sobre sockets describen el bloque anterior.

## Actualización: políticas de acceso preparadas (12/09/2026)

Cuatro endpoints incorporan captura v4 apagada, PUT/outbox atómicos y una
corrección del acceso parcial a grupos. El editor exige `can_manage_scope`
para su ámbito actual y descarta respuestas antiguas. Snapshot versionado de
43 capacidades/nueve roles, defaults conservados. Probado solo con datos
ficticios; sin despliegue, escritura real de permisos ni migración compartida.
[Contrato, inventario y lote pendiente](permission-audit-migration.md).

Inventario estático: 60 archivos/874 declaraciones; añade cuatro rutas de
políticas preparadas, no cobertura operativa. No completa membresías,
asignaciones de Director/gestoría, SQL/OPS ni refresco de permisos en sockets.
AWS/SSO/retención y las cohortes reales mantienen su estado pendiente.

## Actualización: lector, visor y conciliación preparados (12/09/2026)

[Contrato de lectura](audit-reader-view-migration.md): reader TLS separado,
identidad origen distinta del writer, dos firmas/permisos, journal local y
consulta técnica por versiones S3. Outbox v3 audita consultas y denegaciones;
job de conciliación solo obtiene recibos. Preparado/apagado; ningún GET AWS,
rol asignado, instancia añadida, despliegue ni migración compartida ejecutados.

Diferencia adicional verificada **en la plantilla**, no en AWS: reader tiene
Decrypt/DescribeKey pero no GenerateDataKey; la referencia oficial GetObject
pide este último para SSE-KMS. Ver fuente y revisión acotada pendiente en el
contrato. No se han ampliado permisos. Hosting/aislamiento efectivo, SSO,
retención y respaldo externo del journal requieren resolución antes del corte.
Inventario estático actualizado: 60 archivos, 874 declaraciones, 3 accesos,
4 éxitos de sesión y 1 consulta preparados/apagados; no cobertura runtime.

## Actualización: sesiones persistentes preparadas (12/09/2026)

Se añade el control común de sesiones y su auditoría v2, sin activar el modo
enforce, sin aplicar AuthSessions en BD compartida ni desplegar runtimes/front.
Contrato y lote concreto en [access-session-migration.md](access-session-migration.md).
El inventario JWT separado incluye tokens clínicos públicos que requieren su
propio corte. Ningún consumidor real de proveedor se ha migrado por este bloque.
Los pendientes AWS de la matriz inferior conservan su estado reportado.


Estado inicial: 12/09/2026. Implementación en curso; ninguna cohorte migrada,
ningún despliegue, secreto real movido ni llamada a proveedor autorizada.

El usuario confirmó que la tarea concurrente ha terminado. Fetch de ambos
repositorios: backend `a681e49758b5336d34df9b6cc2e69db5585ce23c`, frontend
`5478ac10c8c145b030c71401c44fbb730eb69dcb`, limpios y 0/0 respecto de
`origin/dev`. Revalidar antes de cualquier commit/push. No modificar PM2,
pausas, staging/gateway ni la BD compartida por publicar código.

## Matriz de aceptación AWS

Los tres originales saneados están en `provisioning/received-2026-09-12/`, con
hashes de recepción en `sha256.json`. Las afirmaciones de esos documentos son
**reportadas**. La lectura de una plantilla verifica su contenido, no su estado
efectivo en AWS. `manifest.final.json` aún declara identificadores no capturados.

| Área | Reportado | Verificado localmente | Pendiente / responsable |
|---|---|---|---|
| Cuenta/región/stack | 137819318729, eu-west-3, UPDATE_ROLLBACK_COMPLETE | Coherencia de los artefactos | Identidad, eventos, outputs y template vivo; operador SSO + seguridad |
| Estado operativo EC2 | Usuario anuncia apagado el 13/09/2026 | No se ha consultado ni ejecutado desde esta tarea | Verificar estado con sesión asignada y acordar reanudación/despliegue antes de un corte real |
| EC2/red | t3.small AL2023, 20 GiB cifrados, IMDSv2, EIP fija | Plantilla sin ingress ni UserData de instalación | IDs/AMI/parches, TLS y canal de acceso del consumidor; cambio de red con aprobación |
| Runtime | Instance role lee prefijo Secrets y dos KMS | No concede asumir writer ni cost-reader; no escribe secretos | Trusts operativos y permisos efectivos; lote IAM separado |
| Despliegue | Rol dedicado | Permisos CF/inventario; sin SendCommand/StartSession ni canal de artefactos | Definir instalación aprobada sin entregar administración al backend |
| KMS | Secrets/payload/auditoría separadas | Rotación deshabilitada en las tres; políticas habilitan delegación IAM de cuenta | ARN payload exacto, políticas efectivas y aislamiento de principales anteriores |
| Auditoría | Bucket privado/versionado/KMS; smoke test ficticio | Writer/reader/retention-admin confían solo en OperatorPrincipalArn | Trusts de servicio; permisos de S3/KMS y entrega efectiva |
| Retención | 183 días actuales y no actuales en plantilla; Object Lock apagado | Retention-admin puede PutLifecycleConfiguration y PutBucketPolicy | DPD define cómputo, excepciones, eliminación y Governance; no acreditar inmutabilidad ni límite efectivo de borrado con esta separación nominal |
| CloudTrail | Regional, gestión read/write, validación | Sin eventos globales ni selectores de datos S3 en plantilla | Cobertura efectiva y coste de ampliarla, con aprobación |
| Budget | 60 USD, avisos 80%/100% real y 100% forecast | Filtro solo application; default de plantilla 45 USD (valor desplegado reportado 60) | Confirmar parámetros, filtro incremental y conciliación del aviso fuera de CF; sin recrear |
| Costes | Cost-reader creado | Trust solo SSO aprovisionador; tags application/component/environment/cost-center en recursos compatibles | Activación CE/tags y cobertura de gastos no etiquetados; sin tratar ausencia como cero |
| SSO | Propuesto impl-readonly-temp 1 h | No se ha asignado acceso a esta sesión | Usuario/aprovisionador aprueba y habilita relevo mínimo; no reutilizar AdministratorAccess |
| BD | Cifrado global no acreditado | Diez consultas reales de metadata, seis verificadas y cuatro denegadas; redo/undo/binlog nativos OFF, TLS no exigido | Tablespaces, componente de claves, sesiones/réplicas, volumen y backups; DBA/operador temporal. TLS/corte/rotación con aprobación |

Revisar además la política propuesta de lectura antes de solicitar su aprobación:
para inspeccionar controles hacen falta las acciones IAM correctas (por ejemplo
`s3:GetLifecycleConfiguration`, `s3:GetEncryptionConfiguration`), lectura de
versiones de políticas administradas y `kms:GetKeyPolicy`; Object Lock y SSM
status requieren metadata adicional. No ampliar permisos desde esta sesión.

## Orden de trabajo y cobertura

1. Inventario estático de consumidores y clasificación manual por cohorte.
2. Broker autocontenido, política de autoridad local, almacenamiento durable,
   controles de peticiones, secretos y entrega de auditoría, probado sin AWS.
3. Adaptadores y referencias aditivas; compatibilidad de todos los consumidores
   antes de cortar cada cohorte, sin fallback a credenciales legacy.
4. Auditoría de plataforma, colector/cache de costes e integración en Ajustes.
5. Diagnóstico de cifrado y restauración aislada, QA de contratos y UI.
6. Publicación selectiva y lotes concretos de despliegue/migración para aprobar.

El código nuevo no convierte el estado reportado en verificado. Las fases sin
SSO avanzan con ficticios; AWS, cohortes reales, retención y BD real permanecen
pendientes hasta la evidencia y autorización específicas.

## Primer bloque implementado (sin despliegue)

`services/integrations-broker`: Node 24 aislado, TLS/Ed25519, grants exactos,
schemas cerrados, nonce y cuota durables, bloqueo persistente, idempotencia y
resultado incierto, outbox SQLite con leases/reintentos, adaptadores SDK de
Secrets Manager y S3 probados con dobles. Solo operación ficticia ejecutable.
`src/lib/integrationsBrokerClient.js`: transporte para Node 18 del backend,
sin bootstrap/modelos/credenciales AWS; sin conexión a consumidores legacy.
El núcleo de costes inicialmente incluido en el broker se ha trasladado al
paquete separado `services/aws-cost-collector`; ver el segundo bloque debajo.

El inventario y las cohortes están en `consumer-inventory.json` y
`consumer-cohorts.md`. SSO continúa pendiente: cero verificaciones AWS propias.
El destino Node 24 tampoco está instalado ni aprobado en la instancia entregada.

El espejo API frontend ya divergía de la fuente backend antes de esta tarea
(1.212 inserciones/467 eliminaciones al sustituirlo entero). Se sincroniza solo
el bloque nuevo de seguridad para conservar documentación ajena; la conciliación
histórica completa queda al integrador, fuera de este corte selectivo.

QA completada: 23 pruebas del paquete nuevo con red externa bloqueada; 11
casos HTTP existentes del hotfix y 7 comprobaciones MySQL 8.0.42 en socket
privado/BD ficticia. Mysqld de QA terminó con exit 0. Controlador conserva
SHA-256 `0d14de2cb70b183e35e88f4561a48e190fc164c8bcb0628021e727f48770b8c5`.
`npm audit --omit=dev` del paquete nuevo: cero vulnerabilidades reportadas.
Evidencia saneada fuera de rutas públicas:
`/home/ubuntu/qa-evidence/security-migration-20260912/initial-offline-qa.json`.

## Segundo bloque: costes integrados, sin activar

Colector Node 24 separado, rol fijo/IMDS/STS, validación de tags, uso paginado
y forecast/Budget; caché persistente nueva, leases CAS, errores cerrados,
endpoint protegido por JWT/admin técnico y cron durable `03:40 Europe/Madrid`
apagado por defecto. UI Costes AWS con mes actual/anterior, estados y moneda,
presupuesto vigente diferenciado del histórico y de gasto/estimación de IA.
Contrato, permisos pendientes, coste y rollback en
`services/aws-cost-collector/README.md`.

QA: 12 casos del paquete de costes, 8 servicio, 2 HTTP del endpoint y los
11 HTTP del hotfix. Suite existente de orquestación pasa con preload que
bloquea red y carga de .env. MySQL 8.0.42: 6 comprobaciones de migración,
concurrencia, persistencia, lease vencido, rollback y reaplicación, con
datadir/socket temporal y cierre 0. Build Angular development
`a27e86a5f068637e`; aviso CommonJS existente de socket.io-parser/debug.
Chromium: seis capturas reales del componente con datos ficticios, desktop
1440 y móvil 390, navegación/tabla desplazables y sin overflow de página,
mes anterior, error/recuperación, escape de HTML y ninguna llamada externa.
Sin sesión de aplicación real; ACL probada con JWT ficticios por HTTP.

Migración `20260912180000` aplicada solo a MySQL ficticio. Gate de costes
no configurado en PM2. No se ha creado la tabla compartida, instalado Node
en hosts utilizados ni desplegado la UI. SSO/IAM/tags/CE/Budget siguen
reportados o pendientes. El resto de consumidores, auditoría de plataforma
y diagnóstico/corte de BD continúan en las siguientes fases.
Evidencia: `/home/ubuntu/qa-evidence/security-migration-20260912/costs-offline-qa.json`.

## Tercer bloque: BD diagnosticada parcialmente y corte preparado

`security-database-metadata.js` recoge exclusivamente metadata, con proyección
cerrada y errores categorizados. Ejecutado por UNIX con la identidad ya
configurada, sin modelos ni filas clínicas. MySQL 8.0.42 local, datadir
`/var/lib/mysql/`; cuatro denegaciones conservadas, sin recurrir a otro
usuario ni elevar privilegios. El volumen ext4 puede estar cifrado por el
proveedor: el estado de su cifrado/backups no queda probado por la inspección.
Resultados y lotes en `database-encryption-remediation.md`.

`databaseTlsConfig.js` prepara CA/nombre verificados y TLS >=1.2 para la
config canónica, conexiones secundarias y scripts inventariados. Sin activar
`DB_TLS_REQUIRED`, sin PM2 ni consultas de los scripts de mantenimiento.
Credencial incrustada retirada de `src/config/db.js`, que ahora exige config
canónica sin fallback de identidad; rotación y exposición en historia/copias
siguen pendientes. No se probó la credencial encontrada.

QA: nueve casos unitarios; cuatro comprobaciones de metadata sobre MySQL
temporal; ocho comprobaciones de cifrado/TLS/backup/restauración con dos
tablas sintéticas. CA/nombre ajenos y TCP sin TLS rechazados; backup cifrado
dañado/identidad GPG ajena denegados; MySQL sin keyring correcto falla;
restauración con claves conserva datos/relación/unicidad/cifrado. Tres
procesos propios terminaron (0/1 esperado/0), ninguno forzado. No prueba
RPO/RTO clínico ni recuperación con KMS o backups reales.

Inventario SQL estático en `database-client-inventory.json`. Evidencia
privada: `/home/ubuntu/qa-evidence/security-migration-20260912/database-offline-qa.json`
y `database-local-metadata-20260912.json`. Corte de BD, TLS real, claves,
SSO, auditoría completa y consumidores de proveedores siguen pendientes.

## Cuarto bloque: auditoría semántica inicial, apagada

Tres accesos de autenticación preparan evento de intento/resultado y actor
verificado, JTI no secreto y DTO sin hash de contraseña. Cola MySQL aditiva,
lease/idempotencia/recibo/health, writer S3 condicional y conciliador separado,
probados solo con ficticios. No se ha creado la tabla compartida ni asignado
identidad AWS. Faltan bootstrap/worker/alarma, visor, auth restante,
permisos y actividad clínica. Matriz completa, fallos/retención y lotes en
`../../services/platform-audit/README.md`.

Inventario heurístico: 60 archivos, 869 declaraciones de ruta, 3 preparadas y
apagadas; no acredita cobertura runtime. QA: 5 casos contrato/S3, 6 auth
(incluye HTTP real sobre servidor propio), 11 hotfix y 28 correo. MySQL
ficticio: 8 comprobaciones, cierre limpio, sin conexiones externas. SDK del
paquete nuevo auditado: cero vulnerabilidades reportadas. Evidencia privada
`/home/ubuntu/qa-evidence/security-migration-20260912/platform-audit-offline-qa.json`.
Sin despliegue, migraciones compartidas, secretos, proveedores ni PM2.

## Quinto bloque: worker de entrega y monitor de panel preparados

Dos jobs nuevos apagados en el catálogo durable, cada minuto/cinco minutos
Madrid. Proceso Node 24 solo writer, IMDSv2/STS con identidades comprobadas en
código antes de S3, endpoints fijos y entorno/archivos AWS aislados. Lotes de
50, paralelismo 4, sin credenciales en payload/logs/resultado. Lease global
270 s y por evento 120 s; ACK dudoso permanece sin confirmar.

Estado y alertas de panel durables, dedupe/recuperación y transacción de todos
los destinatarios técnicos. No dispatch email/WhatsApp. Endpoint privado de
salud por JWT/admin técnico, solo contadores/fechas, sin consultas AWS ni
acceso a eventos. No es el visor, ni su propia consulta está auditada todavía.
Watchdog externo pendiente; se declara incluso en la respuesta.

QA: 10 pruebas paquete, 5 entrega/monitor y 10 regresiones costes, 1 HTTP salud, 6 auth y 11 hotfix;
suite de orquestación de 42 definiciones/executores, 9 comprobaciones MySQL
ficticias y SDK npm audit 0. Ambas migraciones de auditoría solo ensayadas en
instancias temporales. Inventario actual: 870 declaraciones/60 archivos,
solo 3 capturas semánticas preparadas; ninguna cobertura operativa acreditada.

Evidencia `platform-audit-delivery-offline-qa.json` y publicación verificada
`platform-audit-delivery-publication.json` bajo el directorio privado de QA.
Siguen pendientes instalación, identidad/trust AWS asignados, lector operativo,
visor, cobertura clínica/permisos/auth restante y DPD. No se activa ninguna
captura ni se despliega con este push.
