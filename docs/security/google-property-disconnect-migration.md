# Desconexión durable de Search Console y GA4

Preparada el 13/09/2026 sobre backend 6d19de1d y frontend 9e077f9d.
Código y QA ficticia: cero consumidores migrados en runtime. Sin despliegue,
BD compartida, AWS o proveedor real. OPS aplazado; apagado EC2 anunciado por
el usuario, sin verificar. Este contrato actualiza el estado histórico del
[control del broker](google-property-revocation-control.md).

## Intención, autorización y transacción

DELETE /oauth/google/disconnect con ámbito conserva su autorización write,
sesión vigente y revalidación de actor/conjunto de clínicas antes y después.
La conexión se resuelve con metadata. El assignment se bloquea y se verifica
que no haya cambiado. Para grupos se bloquean los overrides activos o con
reauthorization_required y se excluyen sus clínicas de la baja heredada.

La transacción captura ahora SC/GA y GBP, sus intentos de auditoría, bloqueos
de registros, desactivación de mappings y estado disconnected del assignment.
Un fallo en cualquiera de ellos revierte todos los cambios. No hace llamadas
al broker o a Google dentro de esa transacción. La API devuelve 202 solo después
del commit si quedan confirmaciones del broker; conserva 200 cuando no quedan.

SC/GA comprueba tanto GroupAssetClinicAssignments como los primarios de
GruposClinicas en modo group y los miembros de esos grupos, incluso de un
grupo distinto. Usa metadata y bloqueos SQL, con un máximo de 1.000 filas por
consulta de compartidos/grupos/miembros. Si cualquier consumidor está fuera de
las clínicas que efectivamente se eliminan, devuelve 409
scope_disconnect_shared_asset_conflict sin cambios parciales. Una clínica con
override sigue fuera de una baja heredada aunque pertenezca al mismo grupo.
Comprobación conservadora: una asignación/primario residual puede exigir resolver
primero esa configuración. No elimina asignaciones ajenas automáticamente.

La cola identifica (kind, clínica, connectionRef, assetRef), con SHA256 de ese
array JSON como PK. mapping_id no es una dimensión del protocolo del broker:
varios registros originales de la misma tupla producen una intención. Se exigen
identidad, recurso canónico, subject y referencias coincidentes; un registro
huérfano conserva su autoridad original. Un mapping marcado como gestionado sin
registro ni bloqueo durable que lo cubra falla cerrado antes de desvincularlo.
No se infiere una identidad nueva a partir de un mapping incompleto.

Límite de captura: 200 registros SC/GA combinados, 200 intenciones previas y
200 tuplas totales por operación. Excesos, actor inválido, referencias
inconsistentes, captura deshabilitada para gestionados o auditoría no disponible
producen 503 google_property_revocation_unavailable. Añadir eventos exige
pendientes de auditoría más nuevos eventos <=10.000 y antigüedad <3.600 s.
Repetir la baja conserva UUID, usuario original, estado y correlación.

## Bloqueo local que sobrevive a los registros originales

GooglePropertyBrokerRevocations guarda recurso, referencias, ID/subject Google,
clínica, usuario iniciador, UUID, tiempos y estado de entrega. No tiene FK,
cascadas, tokens, contenido clínico ni métricas. pending y confirmed bloquean
la misma tupla; confirmed no significa permiso para borrar la fila.

Los lectores SC/GA consultan esta tabla antes de decidir usar legacy y alrededor
de las lecturas. Una tupla revocada devuelve asset_revoked incluso con gates
apagados. Cualquier marcador de la propiedad impide fallback de un mapping sin
registro propio; otras tuplas gestionadas válidas conservan su acceso.
La comprobación tras la respuesta del proveedor evita entregarla si observa
una baja concurrente. No puede deshacer una solicitud ya recibida por Google
ni ofrecer una transacción distribuida entre SQL, broker y proveedor.

El loader legacy incorpora la tabla a los guards por ID/subject y al NOT EXISTS
de la propia sentencia SELECT/UPDATE de credenciales. Revalida cachés y respuestas.
Borrar/recrear una conexión o sus bindings no elimina ese cierre. OAuth legacy
global también se cierra con el primer marcador; sigue pendiente el ciclo OAuth
completo SC/GA. DELETE sin ámbito usa metadata y rechaza conexiones con cualquier
registro OAuth/SC/GA o revocación por ID/subject; no es un borrado de seguridad.
No se presenta la rama legacy sin ámbito como una transacción de baja gestionada.

## Worker, confirmación y estado

GooglePropertyRevocation.service usa clientes de control separados por cohorte.
Cada comando contiene UUID original, tenant clinic:id, referencias y payload {}.
Solo acepta ACK con el mismo requestId y data exactamente {revoked:true}.
El bloqueo del broker es el control durable ya preparado; no revoca el token OAuth.

Claim con FOR UPDATE SKIP LOCKED, lease de 120 s y token aleatorio; confirmación
por CAS verifica lease vigente e identidad inmutable. Estado confirmed y evento
completed se guardan juntos. Un ACK perdido reintenta el UUID original y aprovecha
el replay del broker. Error fijo, backoff exponencial hasta una hora, hasta 20
comandos por ciclo y 30 s cooperativos; cada HTTP tiene como máximo 10 s/restante.
SQL pendiente no se cancela por ese plazo. Una fila corrupta permanece pendiente
con error cerrado para conciliación; no se borra ni se confirma por agotamiento.

GET /oauth/google/disconnection-status conserva ámbito explícito/write, sesión
y autorización revalidadas después de leer. Suma pendientes/confirmados GBP y
SC/GA en pending_assets/confirmed_assets; status pending prevalece, luego
confirmed o none. Los recuentos SC/GA son tuplas, no número de mappings ni tokens
OAuth revocados. Un fallo no devuelve los recuentos parciales: 503
google_revocation_unavailable. Éxito GET/DELETE usa private, no-store.

## Auditoría y costes

Nueva versión de plataforma v9, acción integration.asset.disconnect. attempted
identifica al usuario iniciador y completed al job google_property_revocation_worker,
con subjectUserId original, clínica y correlación común. Política
connection-scope-write-v1 y captura google-property-disconnect-durable-v1.
Proveedor google_search_console o google_analytics; referencia SC hash o GA ID.
No contiene URL de la propiedad, nombre, métricas, secretos ni lista de mappings.

Writer/reader y protocolo aceptan app/platform/v9 y verifican versión S3 concreta.
El visor restringido proyecta v9 en integrationDisconnect, con el contrato
frontend genérico existente. No cambia componentes ni se ha hecho QA visual nueva.
La confirmación SQL del broker no demuestra entrega a S3: esa entrega conserva
su outbox, roles y verificación separados. La auditoría completa de la plataforma
sigue pendiente; este bloque no registra todos los intentos rechazados de baja.

Por nueva tupla: dos eventos de plataforma más los dos eventos v2 del broker,
una fila durable SQL y el resultado/bloqueo SQLite. Replays no duplican esos
pares; otros errores/denegaciones pueden producir sus propios eventos. Control
sin consultas a Google o Secrets Manager; entrega a S3/KMS y volumen SQL tienen
coste no medido en real. Ajustes conserva caché y estados pendientes existentes.
No se inventa gasto o ahorro; Cost Explorer/tags, Budget/CloudFormation siguen
sin verificar y las decisiones DPD/IAM/retención continúan abiertas.

## Esquema, flags y lote real pendiente

Migración nueva 20260913060000-create-google-property-broker-revocations.js:
CREATE TABLE InnoDB ASCII/binario, sin modificar datos existentes. Up/down con
tabla vacía y reaplicación ensayados; down con cualquier fila se rechaza. Nunca
borrar marcadores para conseguir rollback. Tabla necesaria **antes del código,
incluso con gates apagados**, porque lectores y guards legacy la consultan.
Falta de tabla cierra el acceso; no permite volver a cargar tokens por SQL.

Dependencias: esquema previo de Google OAuth 20260913020000, SC 030000, GA 040000,
PK SC 050000; registros GBP y outbox/sesiones/resultado de auditoría previos del
runbook. No ejecutar todas las migraciones pendientes por comodidad. Nada de
esto se ha aplicado a la BD compartida en esta tarea.

| Configuración nueva | Uso |
|---|---|
| GOOGLE_PROPERTY_REVOCATION_ENABLED=true | Captura de tuplas gestionadas en la baja; apagada por defecto |
| GOOGLE_PROPERTY_REVOCATION_WORKER_ENABLED=true | Job googlePropertyRevocations, cada minuto Europe/Madrid; apagado por defecto |
| GOOGLE_SEARCH_CONSOLE_BROKER_CONTROL_KEY_ID / CONTROL_KEY_FILE | Identidad y clave de control SC |
| GOOGLE_ANALYTICS_BROKER_CONTROL_KEY_ID / CONTROL_KEY_FILE | Identidad y clave de control GA |

Cada control usa ORIGIN/AUDIENCE/CA_FILE existentes de su vertical. Archivos de
clave y CA: ruta absoluta canónica, fichero regular privado, hasta 64 KiB.
El broker exige principal y clave Ed25519 distintos de todos los lectores,
con grant explícito por tupla/operación. No se instala ninguna clave/grant aquí.
El scheduler declara 47 jobs; este usa su propia cola/lease, maxAttempts=1 y
retryable=false en la envoltura del scheduler. Sus reintentos pertenecen a la
cola durable. Flags apagados no cargan modelos, claves ni abren conexiones
por ejecutar el worker. No se ha cambiado .env, PM2, pausas o procesos reales.

El lote real deberá concretar respaldo/restauración, DDL y servicios exactos,
compatibilidad writer/reader v9 antes de emitir, identidades/rutas por cohorte,
autorización sobre bindings compartidos, volumen/capacidad, prueba canary,
monitor/conciliación y ventana/rollback. El runtime de una cohorte por configuración
sigue pendiente de integración operativa; no se afirma convivencia desplegada
en un origen. OPS continúa fuera del foco. No hay solicitud de aprobación de
ese lote durante este bloque local ni autorización implícita por el push.

Rollback conserva cola SQL, outbox y SQLite/WAL; no volver a una versión que
ignore marcadores, reponer tokens SQL o borrar evidencias. Si falla entrega,
conservar bloqueo local y la intención para reparación/reintento. Altas/remapeo,
OAuth/estado/UI generales SC/GA, otras cohortes, auditoría completa y verificación
AWS/cifrado/restauración/corte BD continúan pendientes.

## QA y publicación

265 tests Node aprobados: 132 backend (Node 22.17.0), 93 broker y 40 auditoría
(Node 24.21.0), con guardas offline, HTTPS local firmado y proveedores ficticios.
Once pruebas nuevas de worker/lectores/captura/proyección, ocho pruebas HTTP de
baja/estado y seis pruebas codec/lector v9; la cifra total incluye regresiones.

79 comprobaciones MySQL 8.0.42 propias: 20 GA, 20 SC, ocho legacy, once OAuth,
siete GBP y trece de desconexión SC/GA. Incluyen DDL, rollback completo por fallos,
compartidos/primarios/overrides, exclusión concurrente, lease vencido, ACK perdido,
recreación de registros y guards SQL durante carreras. Seis instancias temporales
con shutdown 0. Cuatro contratos pasan: scheduler 47, caducidad GBP, multigrant
y desconexión por ámbito. Sin credenciales/datos/instancias reales en estas pruebas.

Las primeras ejecuciones detectaron fakes sin la nueva dependencia, aserciones
entre objetos de VM, recuento anterior de jobs y un preload offline incorrecto
en el runner de auditoría; se corrigieron los tests/runner y se repitieron las
suites afectadas. La revisión añadió rechazo de un mapping gestionado sin binding,
con prueba unitaria y SQL antes de cerrar el bloque. No se rebajaron los guards.

Evidencia privada property-disconnect-* bajo
/home/ubuntu/qa-evidence/security-migration-20260912/ (0700/0600), incluidos
hashes, cierre de MySQL, inventario propio y verificación remota de publicación.
El [delta de consumidores](google-property-disconnect-consumers.json) contiene
fuentes y límites. Solo commits propios a DEV según apartado 5 del runbook;
push no despliega ni aplica migraciones. La tarea general permanece abierta.
