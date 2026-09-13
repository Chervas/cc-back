# Runbook: Migracion Segura De Integraciones Y Auditoria

## 13/09/2026 — Interfaz WhatsApp separada de la conexión general Meta

Ajustes abre el alta específica de WhatsApp sin MetaConnection general previa.
El SDK se ejecuta en un iframe nuevo de gateway, con origen/WindowProxy/nonce/UUID
comprobados y DTO estricto. Se retiran callback legacy y registro automático del
recorrido de alta. Recuperación por UUID tras cierre o respuesta perdida;
autorización guardada siempre pendiente de activación. DEV no inicia el flujo.

JWT renovado de la misma sesión MFA conserva estado y plazo originales. Sin
DDL nueva, configuración instalada, proveedor real ni despliegue. Quedan por
validar App/config/SDK y grants Meta separados de Ads/leads, aislamiento efectivo,
activación y consumidores/colas públicos. La modalidad y canales secundarios/
sin asignación requieren completar su contrato. Reconexión todavía no validada.

QA aislada correcta: 40 pruebas Node backend, 12 frontend, 16 grupos de
comprobaciones en MySQL propio con cierre 0, build Angular y Chromium desktop/
móvil con 18 capturas y cero llamadas externas. Meta/AWS/SDK son ficticios.

[Contrato, QA y rollback](security/whatsapp-onboarding-ui.md).

## 13/09/2026 — Gateway une MFA, estado y broker WhatsApp

Preparadas rutas POST begin/finish/status/cancel en
`/api/whatsapp/onboarding`, montadas antes del parser general: JSON 8 KiB sin
compresión/rawBody, Bearer verificado, Origin público exacto y cabecera propia.
Actor/sesión del middleware; hashes solo internos. El canje se reclama una vez.
Respuestas perdidas se consultan; pérdida de sesión/permisos suprime resultado
y solicita abort sin afirmar su confirmación si falla el transporte.

QA: 36 Node (35 regresión, 1 TLS) y 15 grupos MySQL reales propios, proveedores
ficticios, cierre 0. Sin nueva DDL compartida; las anteriores siguen pendientes.
Nueva configuración privada `WHATSAPP_ONBOARDING_BROKER_CONFIG_FILE`, no instalada.
UI/Embedded Signup, permisos reales Meta, activación/consumidores e aislamiento
siguen pendientes. Guard deshabilitado por defecto, cuarentena conservada.
[Contrato, costes y rollback](security/whatsapp-onboarding-gateway.md).

## 13/09/2026 — Alta WhatsApp durable y candidata en Secrets Manager

El runtime privado registra el canje antes de Meta, comprueba identidad/scopes/
WABA/número y guarda una versión candidata. Respuesta perdida: conciliación de
versión/hash sin repetir código ni Put. Baja de control conserva bloqueos del
grupo y clínicas originales, con recibo/auditoría en la misma transacción.
`staged` no significa conectado. No se abre la cuarentena ni se instala el runtime.

Slot placeholder previamente aprobado, app secret y versiones fijados; no crea
secretos ni promueve AWSCURRENT. Sin DDL clínica nueva. Falta puente gateway/MFA,
UI sin MetaConnection general, separación real de grants y corte de consumidores.
Verificar IAM exacto, capacidad de versiones, aislamiento de procesos/SQL/Redis,
ventana y rollback antes de operar. Las DDL anteriores siguen pendientes en
BD compartida. [Contrato y validación](security/whatsapp-onboarding-broker.md).

## 13/09/2026 — Transporte de canje WhatsApp y pertenencia del número

Preparado helper privado con app/URI fijadas, GET Meta sin variantes/reintentos,
token prestado solo al callback del broker, metadata cerrada, límites y borrado
de buffers. Comprobación WABA/número por edge fijo, nunca siguiendo paging.next.
294 tests broker pasan; 46 afectados se repiten tras el último refuerzo. Sin
nueva DDL, UI, AWS/Meta real, configuración o despliegue. El canje HTTPS lleva
código/app secret en query: excluirlo de logs/APM/errores y respuestas públicas.

No es una operación autenticada instalada: conectar estado durable/MFA, registro
previo al canje, candidata/versiones en Secrets Manager y conciliación antes de
rutas/consumidores. Independencia remota de grants todavía por acreditar.
[Contrato, fuentes y rollback](security/whatsapp-oauth-transport.md).

## 13/09/2026 — Estado durable de alta WhatsApp

Preparado componente interno que exige sesión con correo MFA y ámbito completo,
fija clínicas/grupos y reclama cada intento una vez, con cancelación y auditoría
v15 en la misma transacción. No conecta rutas ni canje Meta. La separación real
de grants WhatsApp frente a Ads/leads continúa siendo requisito de cierre.

3 tests de contrato, 55 de auditoría y 12 comprobaciones MySQL propio correctos;
mysqld ficticio cerrado con código 0. DDL 20260913150000 y dependencias de sesiones,
MFA, bloqueos y auditoría antes de instalar el nuevo modelo; writer/reader v15
antes de captura. Pendiente en BD compartida. Estado, errores, variables,
interrupción y rollback en [contrato de alta](security/whatsapp-authorization-state.md).
Sin UI, configuración instalada, proveedor real, despliegue o apertura Meta.

## 13/09/2026 — Inspección obligatoria de credenciales WhatsApp

El motor contrasta `debug_token` del proveedor antes de cada uso con App ID,
sujeto, scopes exactos, único WABA previsto y expiraciones. Falta de evidencia
o alcance adicional impiden POST; token inválido bloquea duraderamente la conexión.
263 pruebas broker pasan (80 WhatsApp), exclusivamente con Meta/AWS ficticios.
Sin DDL/UI/configuración/despliegue ni tokens reales; alta Meta aún pendiente.

Antes del lote real: verificar que la modalidad/token reporta granularidad y
campos exigidos, medir cuota/latencia de diagnóstico además de la de mensajes,
y comprobar que no hay trazas/APM de URL/cabeceras sensibles. Meta exige
`input_token` en la query HTTPS de su endpoint diagnóstico; no se expone esa URL
a API/frontend ni se registra en el transporte. Sin fallback ante fallo, sin
suprimir comprobaciones para conseguir un canary verde. Contrato y límites:
[WhatsApp broker](security/whatsapp-broker-messaging.md).

## 13/09/2026 — Motor WhatsApp probado; integración pública pendiente

Preparados runtime privado `whatsapp-main.js` y cliente staging: texto/plantilla
textual registrada, secretos separados con versiones fijadas, comprobación de
bloqueo tras awaits y recibo durable sin repetir POST ante incertidumbre.
Regresión: 232 broker + 59 backend correctos, TLS/SQLite propios y AWS/Meta
ficticios. Sin nueva DDL clínica, UI, configuración instalada o despliegue.

No se ha conectado a registro, `whatsapp.service.js`, workers ni recepción real.
El lote incluye reemplazar el requisito de conexión Meta general por alta
específica WhatsApp/Embedded Signup, con MFA, estado/código de un uso, permiso
de ámbito y canje en broker. Su configuración/permisos, incluida coexistencia,
deben verificarse; no asumir que el token de alta cumple el contrato de envío.
Siguiente corte: bindings/aprobaciones, salida y recepción durable gateway → cola
→ staging, revalidación/deduplicación y conciliación de resultados desconocidos.
Después, acreditar separación de identidades/claves/IAM/SQL/Redis y correo MFA,
presentar versiones/DDL/backlog/ventana/canary/rollback concretos antes de activar.

Conservar estado SQLite/recibos/bloqueos/auditoría y cuarentena. No recuperar
tokens de BD, cambiar IDs Message para repetir, reutilizar credenciales revocadas
ni reactivar DEV. El guard de entorno no constituye aislamiento frente al mismo
UID. Medios/botones/flujos y gestión de plantillas quedan fuera del motor inicial.
[Contrato, coste técnico y límites](security/whatsapp-broker-messaging.md).

## 13/09/2026 — WhatsApp primero; OPS no es dependencia

Destino confirmado: **ClinicaClick público en staging/gateway; DEV fuera**.
La revisión observa el mismo UID de sistema en los tres procesos y prefijos
Redis distintos. El consumidor actual `webhook_whatsapp` reside también en
gateway; trasladarlo exige una cola de recepción y propietario de consumo
explícitos. Variables/pausas no sustituyen aislamiento de claves y grants SQL.
Valoración, procesos afectados, interrupción y rollback en el contrato de
reconexión; todavía no es un lote autorizado ni listo para ejecutar.

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

## 13/09/2026 — Selección y baja de asignaciones Ads gestionadas

Guardado gestionado preparado: selección original revalidada bajo lock, estado
staged explícito, activación y auditoría v12 atómicas. Sustituir cuentas conserva
las seleccionadas y revoca solo las retiradas. Consulta de mappings heredados y
baja individual usan metadata; la baja conserva filas e historial y no llama a
Google. Sesión gestionada, permisos sobre el ámbito completo y errores cerrados.

DDL 20260913110000 añade staged sin cambiar el defecto blocked y rechaza down
con preparaciones. Gate nuevo GOOGLE_ADS_MAPPING_ENABLED apagado por defecto;
catálogo 48 jobs, pausas y configuración real intactos. Ajustes envía solo IDs y
su visor muestra activación/propiedad anterior y clínicas afectadas. QA: 444 tests
Node (382 backend, 50 auditoría, 12 frontend), 27 checks en un MySQL propio con
cierre 0, build Angular y 8 capturas Chromium desktop/móvil; todo ficticio.

Alta general de cuentas sin preparación, cambios de propietario/grants, otros
consumidores, auditoría completa, costes/controles AWS y cifrado/corte BD siguen
pendientes. OPS aplazado; cero cuentas reales migradas o despliegues.
[Contrato, límites y lote pendiente](security/google-ads-mapping-migration.md).

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
[Contrato, coste, cobertura y lote](security/patient-read-audit-migration.md).

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

## Décimo bloque: lecturas de Perfil de Empresa preparadas (13/09/2026)

[Contrato, límites y lote pendiente](security/google-business-profile-read-migration.md):
seis operaciones Google cerradas, contexto sin tokens en dos jobs, referencias
aditivas por ubicación y arranque separado del broker con IMDSv2/STS/Secrets/S3.
QA ficticia con TLS y MySQL propios; sin AWS, OAuth real, migración compartida
ni despliegue. La revocación de tokens WhatsApp y autorización para reanudar
son información comunicada por el usuario; no se han probado credenciales.
Antes del corte faltan OAuth/OPS/lifecycle compatibles o pausados, IAM/red,
conciliación/monitor del broker, backups y aprobación de los recursos/consumidores.
No retirar tokens Google compartidos hasta completar sus demás verticales.


## Noveno bloque: acceso en tiempo real preparado (12/09/2026)

[Contrato y corte](security/realtime-access-migration.md): permisos del recurso
reevaluados para cada destinatario, suscripciones actuales, proyección cerrada
y captura v5 apagada. Sesión/permisos se repiten tras persistir auditoría y
antes de enviar. Bus interno y pausas conservados. QA ficticia, sin despliegue,
AWS ni migración compartida. Writer/reader v5 antes de activar captura;
medir carga SQL y volumen por pestaña. El registro prueba preparación, no
recepción del paquete. REST, escritores de membresía y cohortes reales siguen
pendientes. Las notas anteriores sobre sockets describen el bloque anterior.

## Octavo bloque preparado: políticas de acceso (12/09/2026)

[Contrato y lote](security/permission-audit-migration.md): corrige lectura de
asignaciones/escritura con acceso parcial al grupo, prepara auditoría v4 en
cuatro endpoints y confirma PUT/outbox en una transacción. Editor espera el
permiso del backend para el ámbito actual. Los controles de ámbito permanecen
con captura apagada; no revertir al controlador vulnerable al hacer rollback.
Sin migración nueva ni cambios de permisos reales. Writer/reader v4 y backend
antes del frontend/gate; conservar datos/snapshots y puertas de aprobación.
Membresías, otras asignaciones y propagación a sockets siguen pendientes.

## Séptimo bloque preparado: lector, visor y conciliación (12/09/2026)

[Contrato y lote pendiente](security/audit-reader-view-migration.md): consulta
restringida con sesión persistente, verificación externa por VersionId, eventos
v3 de lectura y conciliación de ACK perdido que solo devuelve recibos. Gates
apagados; índice `20260912230000` únicamente en MySQL ficticio. Reader Node 24
con origen IAM distinto del writer; topología y confianza reales sin asignar.
Revisar permiso KMS de GetObject señalado en el contrato antes de habilitarlo.
No desplegar ni añadir roles/recursos/red/retención por este avance. Conserva
outbox/journal/sesiones al volver atrás; la consulta no prueba totalidad del
índice ni inmutabilidad. Publicar código no ejecuta el lote aprobado pendiente.

## Sexto bloque preparado: sesiones persistentes (12/09/2026)

[Contrato, QA y lote de sesiones](security/access-session-migration.md): emisión
atómica con outbox, revocación propia, validación común REST/sockets y front sin
identidad ficticia. No activado ni desplegado. Migración AuthSessions separada,
modo enforce y duraciones/límites requieren el corte aprobado en todos los
runtimes. Preparar backend/writer v2 antes del frontend y preservar middleware
seguro/revocaciones al volver atrás. Las restantes fases y puertas de este
runbook continúan pendientes; el push no ejecuta el corte.


Fecha: 2026-09-12. **Procedimiento pendiente de ejecucion**, no acta de migracion terminada.

Contrato e inventario AWS canonicamente documentados en el repositorio frontend:
`src/Documentacion/39-seguridad-integraciones-cifrado-auditoria.md`.
En este servidor: `/home/ubuntu/wt/front-dev/src/Documentacion/39-seguridad-integraciones-cifrado-auditoria.md`.
Este runbook concreta orden, pruebas, publicacion y rollback; no duplica el manifiesto de recursos.

Prompt versionado: [instrucciones para el Codex delegado](./security-integrations-migration-codex-prompt.md).
Los recuentos de commits pendientes del apartado 5 son la foto previa al corte
completo a DEV autorizado despues por el usuario el 12/09. Recalcularlos al
retomar; esa autorizacion puntual no permite publicar nuevo trabajo ajeno.

## Estado de implementación inicial (12/09/2026)

Recibidos propuesta, plantilla y manifiesto final en
`docs/security/provisioning/received-2026-09-12`, con hashes; son evidencia
reportada, no verificación AWS. Matriz actual y diferencias de IAM/red/Budget
en `docs/security/implementation-status.md`. Inventario y cohortes en ese
directorio. El manifiesto final todavía declara varios IDs no capturados.

Existe el paquete `services/integrations-broker` y el transporte backend
`src/lib/integrationsBrokerClient.js`, probados offline. Solo hay proveedor
ficticio ejecutable. Colector de costes separado, caché, job diario con gate
apagado y UI implementados con QA ficticia; su
[contrato y lote de activación](../services/aws-cost-collector/README.md)
mantienen pendientes verificación AWS, migración compartida y despliegue.
Ninguna cohorte real ni auditoría completa
de plataforma, cifrado de BD o despliegue se consideran terminados.

BD: [diagnóstico y remediación preparada](./security/database-encryption-remediation.md).
Diez consultas reales de metadata por UNIX, sin filas clínicas: redo/undo/binlog
nativos apagados, transporte seguro no exigido y cuatro consultas denegadas.
Volumen/tablespaces/backups siguen sin acreditarse. TLS de clientes preparado
sin activar; restauración física cifrada solo con datos y claves ficticios.
Credencial incrustada retirada del código legacy; rotación real pendiente.

Auditoría: [primer bloque de autenticación durable](../services/platform-audit/README.md),
con tres rutas preparadas/apagadas y matriz explícita de pendientes. Writer y monitor de panel ya preparados, sin worker
instalado, lector/visor, captura real ni migración compartida. Requiere completar el
lote antes de pedir activación; seis meses de retención no están acreditados.

## 1. Entrada Y Limites

Leer `00-handoff-operativo`, `19-estado-actual`, `39`, `25-operacion-worktrees-entornos`, `30-despliegues-y-entornos` y `31-roadmap-arquitectura-entornos-gateway` en `front-dev/src/Documentacion`. Completar con `02`, `03`, `04`, `05`, `07`, `11`, `14.1`, `20.13` y `32` segun la fase. `25-desarrollo-paralelo` es un alias historico, no otro workflow.

Leer los handoffs de incidente de `/home/ubuntu/incident-handoff/`, en particular `meta-2026-09-11-prompt.md`, `meta-2026-09-12-asset-stats-remediation.md` y `meta-2026-09-12-token-lifecycle-audit.md`. Conservar originales y evidencia. No convertir esta tarea en otra investigacion activa sobre Meta.

No reutilizar autorizaciones de sesiones anteriores para probar proveedores. No usar ni renovar el token Meta invalidado, OAuth, credenciales alternativas, CAPI, WhatsApp o escrituras de publicidad para QA. No modificar campanas, presupuestos, anuncios, conversiones, SES, pagos ni planes. Nuevas operaciones externas necesitan alcance concreto aprobado.

Se permite desarrollar y verificar con datos ficticios. Antes de mover secretos reales, modificar IAM/red/retencion, ejecutar migraciones en BD compartida o desplegar sobre runtimes usados, presentar lote exacto, impacto, pruebas y rollback para aprobarlo. No pedir permiso rutinariamente para cada archivo o test offline.

## 2. Inventario Local Y Puntos De Integracion

| Area | Puntos de entrada verificados en el repositorio; ampliar con busqueda local |
|---|---|
| Meta HTTP y salud | `src/lib/metaClient.js`, `metaBatch.js`, `oauthConnectionHealth.js` |
| Google HTTP | `src/lib/googleAdsClient.js`; localizar todos los clientes Google adicionales |
| OAuth y WhatsApp | `src/routes/oauth.routes.js`, `whatsapp-embedded.routes.js` |
| Modelos de credenciales | `models/MetaConecction.js` (nombre real), `ClinicMetaAsset.js`, `googleconnection.js`, `googleconnectionassignment.js` |
| Hotfix que se debe conservar | `src/controllers/socialstats.controller.js` |
| Jobs | `src/config/scheduledJobCatalog.js`, `src/jobs/sync.jobs.js`, `src/services/jobExecutor.service.js` |
| Descubrimiento externo | `src/scripts/push_ops_global_discovery.js`; encontrar una URL de OPS no autoriza acceder a ese sistema |
| Costes existentes | `src/routes/metasync.routes.js`, `src/controllers/metasync.jobs.controller.js`, `src/services/aiRuntimeMonitoring.service.js` |
| UI de costes | Frontend `src/app/modules/admin/pages/settings/jobs-monitoring/` y `settings.component.*` |
| Contrato de campanas a preservar | `docs/campaign-workspace-implementation.md`; no desarrollar el plan gestionado |

Mapear tambien helpers legacy, SDK, batch, callbacks, webhooks, publicacion social, Lead Ads, formularios, CAPI, Google enhanced conversions, llamadas de plugins/CMS, diagnosticos, cron/colas, CI y copias operativas expresamente autorizadas. No basta con cambiar `metaClient` y `googleAdsClient`.

Inventario de cada consumidor: archivo/runtime/entorno, tipo y referencia de credencial, proveedor/App ID, operaciones, activo/scope, entrada/salida y plan de corte. Metadatos o huellas privadas solo si son necesarias; nunca imprimir secretos. No iniciar la app ni importar su bootstrap para leer la DB.

## 3. Fases Y Puertas De Salida

### A. Aceptar La Entrega Y Preparar El Cambio

1. Verificar rutas, ramas, cambios locales y procesos sin volcar `.env`, `pm2 jlist` completo ni `/proc/*/environ`. Preservar flags de pausa y hotfix antes de tocar despliegues.
2. Recibir plantilla y manifiesto final del aprovisionador. Con acceso AWS asignado, validar identidad y metadata de los recursos del contrato `39`, no de toda la cuenta indiscriminadamente. No recrear el stack por su `UPDATE_ROLLBACK_COMPLETE`.
3. Documentar lo que falta: runtime/deployer/cost role, red, dos KMS de integraciones, Cost Explorer/tags, retencion, drift del Budget y acceso SSO de relevo. Sin permisos AWS se puede avanzar en codigo offline; marcar bloqueado solo el corte dependiente.
4. Definir una politica operativa versionada: catalogo de operaciones, permisos por consumidor, secreto/activo permitido, quotas, estados bloqueados y matriz de auditoria. No desplegar una funcion generica de proxy.
5. Decidir alojamiento del codigo del broker. Preferir paquete/directorio autocontenido con artefacto y dependencias propios, sin importar el arranque ni modelos clinicos del backend. No crear otro repo/remoto por iniciativa propia. Separar identidad de despliegue de identidad de la API antigua.

Salida: inventario, diagrama textual de confianza, matriz de pruebas y plan por cohortes. Indicar riesgos residuales de una instancia y de un backend comprometido que conserve permisos para operar.

### B. Implementar Y Probar Sin Credenciales Reales

1. Broker con esquema de peticiones cerrado, autenticacion entre servicios, autorizacion de activos, timeout, rate limit, idempotencia, trazas saneadas y estados bloqueados persistentes. Separar rutas de lectura y mutacion por permisos independientes.
2. Adaptador de almacen de secretos/referencias, cache limitada y borrado de cache al bloquear/rotar; cifrado envelope solo con SDK/primitivas mantenidos y politica independiente. El broker no devuelve el token, ni siquiera en errores.
3. Adaptadores del backend preservando los contratos actuales. Migraciones de referencias aditivas y reversibles a nivel de esquema, primero solo contra BD de prueba aislada. No borrar columnas ni importar datos reales todavia.
4. OAuth/webhooks: definir el recorrido de intercambio, firma y almacenamiento dentro del limite de confianza. No dejar app secrets en el gateway por olvido; conservar validacion de firma con bytes originales y anticlonado de entregas. Probar con fixtures, no OAuth real.
5. Emisor de auditoria durable, consumidor externo y lector paginado con ACL. Instrumentar auth/permisos y matriz priorizada de actividad; declarar explicitamente endpoints pendientes. No atribuir retrospectivamente identidades que los logs antiguos no guardaron.
6. Colector de costes con cache persistente, tags/metricas/currency explicitos y refresco diario del catalogo existente con `Europe/Madrid`. Una peticion de UI no lanza una consulta AWS. No despausar el cron global para probar un nuevo job.

Salida: tests locales sin red de proveedores, migraciones en BD ficticia, builds y evidencias de UX. La ausencia de Meta real se muestra como bloqueo real, nunca como conexion saludable simulada.

### C. Desplegar El Broker Con Ficticios

Tras aprobar destino y despliegue, construir un artefacto versionado, desplegar por la identidad dedicada y verificar unicamente operaciones ficticias permitidas. No transferir credenciales de SSO al runtime. No ejecutar `set -x`, registrar secretos en UserData ni usar parametros CLI que expongan su contenido.

Verificar TLS, identidades, acceso cruzado denegado, permisos AWS efectivos, stdout/errors saneados y recuperacion tras reinicio. Comparar flags antes/despues. Probar escritura y lectura de auditoria ficticia, entrega durable, duplicate/retry, fallo de destino y alerta de backlog. Cualquier prueba de borrado se limita a recursos de prueba identificados y autorizados; no tocar evidencias del incidente.

Salida: manifiesto de version/roles/configuracion no secreta, pruebas efectivas diferenciadas de simulaciones, sin proveedor real activado.

### D. Migracion Aprobada Por Cohortes

1. Presentar lista de conexiones/consumidores, referencias objetivo, respaldo restringido, cambios de esquema, tiempos, corte de writers y rollback. No incluir Meta bloqueado como candidato activo. No llevar tokens bajo investigacion al almacen operativo; preservar evidencia aparte si corresponde.
2. Compatibilizar todos los runtimes con BD compartida: DEV, staging, gateway, cron, colas y scripts autorizados. No retirar campos antiguos mientras un consumidor dependa de ellos.
3. Copiar solo secretos expresamente autorizados mediante proceso protegido y trazable, sin stdout/argumentos visibles; no renombrar el fichero ficticio para usarlo con tokens reales. Validar integridad local y mapeos sin exponer valores.
4. Migrar lectura primero y sin mutaciones del proveedor; documentar las consultas reales permitidas. Activaciones, escrituras, recepcion y renovacion tienen su propia aprobacion y tests. Un GET que revoca o cambia estado sigue siendo mutacion.
5. Cambiar una fuente activa por cohorte; no doble publicacion, dobles conversiones ni fallback a valores de DB. Gestionar comandos en vuelo y reintentos con idempotencia y receipt del proveedor cuando exista.
6. Verificar cohortes y despues retirar la capacidad de lectura/uso de secretos del runtime antiguo, segun plan aprobado. Limpiar almacenamiento/cache/backups operativos de forma compatible con preservacion forense y retencion; no afirmar que desaparecieron copias ajenas.

Salida: tabla por consumidor `migrado / bloqueado / pendiente`, campos legacy retirados o pendientes justificados, sin ampliar permisos del producto. Reiniciar no debe reactivar ningun proveedor bloqueado.

### E. Auditoria Completa Y Cifrado De BD

Completar las categorias de auditoria de `39`, pruebas end-to-end y visor de acceso restringido. Implementar politica de retencion confirmada por DPD/usuario; mantener una lista explicita de decisiones pendientes. No afirmar cobertura completa con solo logins y llamadas AWS.

El cifrado requiere antes un diagnostico de topologia/metadata. Preparar remediacion con restauracion ensayada y costes. La migracion de datos reales, adquisicion de recursos y cambios irreversibles de retencion requieren aprobacion separada; no incorporarlos ocultamente al despliegue de un adaptador.

## 4. Matriz Minima De QA

| Prueba | Evidencia exigida |
|---|---|
| Fuga original | `getAssetStats`: anonimo denegado, scope ajeno denegado, autorizado sin secretos; preservar sus pruebas existentes |
| Serializacion | Sentinel ficticio ausente de respuestas, errores, trazas, URLs, cache y bundles |
| Aislamiento | Consumidor sin permisos de leer/descifrar secretos, administrar el broker o usar otra conexion/activo; separar simulador de prueba efectiva |
| Broker | Operacion/host/redireccion/payload no permitidos denegados; identidad falsa, replay y scope cruzado denegados |
| Ciclo de vida | Renovacion concurrente controlada con mocks, bloqueo durable tras reinicio, no fallback a token invalidado |
| Contratos | Lecturas y errores compatibles; webhooks firmados ficticios; idempotencia de formularios/conversiones sin envios reales |
| Jobs | Pausas/gates previos preservados, unico leader y timezone Madrid, ningun resume accidental |
| Auditoria | Login exitoso/fallido, lectura, cambio, permiso y exportacion sinteticos trazables hasta almacen externo; actor correcto y campos sensibles ausentes |
| Fallos de auditoria | Caida, reintento, backlog y duplicado verificables; politica de bloqueo/degradacion documentada |
| Retencion | Roles diferenciados, integridad, fechas/zonas y recuperacion; datos ficticios para pruebas activas, no evidencia real |
| Costes | ACL, paginacion, cache sobre reload, dato atrasado/no disponible distinto de cero, moneda y no doble conteo de IA |
| UX | Chromium desktop y movil: login QA autorizado, costes/auditoria legibles, sin datos clinicos en capturas; no usar perfil personal del PC |
| BD | Metadata y TLS, migracion aislada, restauracion y dependencias de KMS documentadas; datos reales solo con aprobacion |
| Rollback | Reversion de version/configuracion sin reaparecer tokens en API, ni activar Meta o jobs pausados |

Hay tests `src/scripts/tests/social_asset_stats_security.test.js` y `social_asset_stats_mysql.integration.js`. Leer fixtures y variables antes de ejecutarlos; MySQL de integracion debe ser efimero y ficticio, nunca la BD compartida. No usar suites que arranquen workers o accedan a proveedores por efectos de importacion. No desactivar guards de red para poner pruebas en verde.

## 5. Commits Y Push Sin Arrastrar Publicidad

Estado observado al preparar este handoff: backend `dev` 46 commits por delante de `origin/dev`; frontend `dev` 35 por delante. Ambos tienen cambios sin commit de campanas, seguridad y documentacion. Es una foto local de refs, no del remoto actualizado; repetir comprobacion al iniciar.

**Un `git push origin dev` publicaria todos sus ancestros pendientes. Seleccionar archivos al hacer commit no evita eso.** No ejecutar `git add .`, `git add -A`, `commit -am`, force push, `reset --hard`, limpieza ni restauraciones de cambios ajenos.

1. Inventariar `git status --short --branch`, HEAD, upstream y diff propio con datos sensibles saneados. Coordinar la propiedad de archivos compartidos antes de editar clientes, controladores, jobs, entornos y documentos que otro Codex este tocando.
2. Trabajar y commitear primero en DEV, como establece el runbook de worktrees. Preparar commits pequenos por fase con archivos/hunks propios revisados. Si un archivo contiene trabajo ajeno, no incluirlo completo; no tocar un indice ya preparado por otra tarea sin coordinarlo.
3. Con acceso Git autorizado: `git fetch origin`, revisar `git rev-list --left-right --count origin/dev...HEAD` y `git log --oneline origin/dev..HEAD` por repositorio. No hacer `pull` ciego. No mostrar remotos con credenciales embebidas.
4. Antes del push, el rango completo a publicar debe contener solo cambios de esta tarea y dependencias explicitamente aprobadas. Si aparecen commits ajenos, NO publicar la rama DEV completa.
5. Para un corte aislado, coordinar un worktree temporal limpio basado en `origin/dev`, con una rama temporal solo de transporte. Aplicar los commits propios y dependencias aprobadas, resolver sin alterar DEV ajeno y repetir QA sobre ese candidato. No usarlo para mantener otra linea de desarrollo permanente. Si necesita campanas no publicadas, pedir coordinacion; no quitar dependencias para forzar el push.
6. Solo con rango revisado, pruebas correctas y contrato de API compatible: publicar por fast-forward a `dev` (`git push origin HEAD:dev` desde el candidato correcto). Si se rechaza por cambios remotos, actualizar el candidato y repetir revision/pruebas, nunca forzar. No crear remotos ni publicar a `main`.
7. Verificar SHA remoto y comunicar commits exactos, repositorios, pruebas y si realmente se hizo push. Mantener los worktrees canonicos y cambios ajenos intactos; la reconciliacion de sus ramas se coordina con su responsable, no con un reset automatico.

Si no existe un candidato aislable o falta permiso de push, entregar commits/patch acotados y dependencia pendiente. No declarar publicado algo que solo esta local. El prompt/handoff bajo `/home/ubuntu/incident-handoff` no esta dentro del repo: no hacer `git add` de toda esa carpeta; los contratos versionables viven en los repositorios.

## 6. Despliegue Y Rollback

Push a DEV no es despliegue ni permiso para promover todo a staging. Antes de desplegar, acordar commits exactos, migraciones concretas, respaldo, canary, flags y servicios a reiniciar. No copiar recetas generales de `merge origin/dev`, `npm install` o `db:migrate` que ejecuten todos los cambios pendientes.

- DEV backend: `/home/ubuntu/wt/back-dev`, `pm2-back-dev`, puerto `3004`.
- Staging backend: `/home/ubuntu/wt/back-staging`, `pm2-back-staging`, puerto `3001`.
- Gateway: `/home/ubuntu/wt/gateway`, `pm2-gateway`, puerto `3000`; entradas externas OAuth/webhooks y sin jobs de negocio propios.
- Preview frontend: `cc-front-preview-4203` sirve `/home/ubuntu/www/front-dev-preview`; fuente `/home/ubuntu/wt/front-dev`. Seguir `30` para build y `/home/ubuntu/scripts/cc-front-preview-sync.sh`, no arrancar otro ng serve que sustituya el preview.

Los overrides PM2 de DEV mantienen JobRequests, cron, resume y gates de campanas pausados; staging/WhatsApp no estan globalmente pausados. Leer valores permitidos actuales, preservarlos en reinicios y no equiparar pausa de desarrollo a contencion total. No ejecutar reparaciones de Propdental ya realizadas.

Hotfix `socialstats.controller.js` de 12/09/2026 ya aplicado localmente a DEV/staging/gateway. Preservarlo e integrarlo en el corte aprobado; una promocion que lo pierda reabre la brecha. Su SHA historico esta en el acta de seguridad, no usarlo para deshacer mejoras posteriores legitimas.

Rollback: volver al artefacto seguro anterior del broker/adaptador, o detener solo la cohorte afectada y conservar lecturas de cache con estado obsoleto explicito. Nunca reabrir el endpoint vulnerable, restaurar tokens revocados, devolver tokens al front o recuperar escrituras desde DB como fallback. Preservar auditoria, comandos pendientes e idempotencia.

Cerrar actualizando contrato `39`, docs afectados, `19` y `99`; API primero en `src/Documentacion/13-backend.md`, despues espejo frontend. Entregar al Codex de publicidad solo cambios de contrato necesarios, errores/flags nuevos, rutas y estado de proveedores, sin secretos.
