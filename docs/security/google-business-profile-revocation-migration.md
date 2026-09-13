# Desconexión durable de activos GBP

Estado 13/09/2026: código y QA aislada preparados, **sin despliegue, migración
compartida ni revocación real en proveedores**. OPS sigue aplazado por el usuario.
El apagado de EC2 fue anunciado por él; no se ejecutó ni verificó desde esta tarea.
Complementa [lecturas GBP](google-business-profile-read-migration.md) y
[listado por grants](google-business-profile-discovery-migration.md).

## Problema y alcance

La desconexión Google por clínica/grupo desactivaba mappings SQL, pero dejaba
vigente el grant del broker. Ahora registra una intención durable por activo,
desactiva los mappings y desconecta el assignment en una transacción. La API
devuelve 202 mientras espera la confirmación del broker. Una caída de ese
servicio conserva el bloqueo local y la solicitud pendiente.

**Se revoca acceso mediante el broker al activo autorizado. No se invalida el
token OAuth en Google.** Google Ads, Search Console y GA4 aún pueden compartir
la credencial legacy: sus consumidores, altas/callbacks/almacenamiento y
renovación OAuth completa siguen pendientes. Tampoco se ha migrado Meta,
WhatsApp, recepción, conversiones ni escrituras publicitarias. No hay una
operación de reactivación; reconectar OAuth no borra estos bloqueos.

| Entrada | Comportamiento preparado |
|---|---|
| `DELETE /oauth/google/disconnect?clinic_id=…` o `group_id=…` | Sesión canónica, permiso de gestión sobre todo el scope, resolución con `metadataOnly: true`, locks y revalidación de sesión/permisos/conjunto de clínicas antes del commit |
| Desconexión de grupo | Conserva overrides activos o pendientes de reautorización de clínicas; conflicto 409 si un mapping afectaría consumidores fuera del ámbito |
| Activos registrados sin mapping activo | También generan intención desde el registro independiente; repetir conserva actor, correlación y estado originales |
| Resultado | 202 `revocation_pending` con `pending_assets` si queda trabajo; 200 para desconexión sin pendientes, incluido camino legacy sin activos gestionados |
| `GET /oauth/google/disconnection-status` | Scope explícito obligatorio y permiso de gestión; SQL solo de metadata, nueva verificación de sesión/permisos/clínicas antes de responder |
| DTO de estado | `{status: none\|pending\|confirmed, pending_assets, confirmed_assets}`; suma por clínicas autorizadas, sin credenciales, nombres ni contenido del proveedor |
| Borrado sin scope | Rechaza 409 una conexión con registro o bloqueo durable superviviente, además de assignments/mappings existentes |

Éxitos scoped llevan `Cache-Control: private, no-store`. Sesión inválida 401,
permiso insuficiente 403, cambio de conexión/scope o conflicto compartido 409,
captura gestionada no disponible 503. Los fallos inesperados de la desconexión
mantienen el 500 genérico; estado devuelve 503 cerrado. No se envían errores
internos/credenciales del broker o proveedor al cliente. El GET de estado y las
denegaciones de esta ruta aún no tienen captura semántica de plataforma propia.

## Registro SQL y worker

`BusinessProfileBrokerRevocations` conserva una fila por `external_location_id`,
PK global acorde al registro GBP anterior, sin FK/cascada. Incluye referencias
de conexión/activo/clínica, conexión SQL, UUID de solicitud, usuario iniciador,
fechas, estado `pending|confirmed`, intentos, próximo intento, lease y error
cerrado. No contiene tokens. Cualquier fila bloquea el adaptador antes de
leer un token legacy; se repite el control alrededor de la llamada gestionada.
También mantiene cerrado el descubrimiento/remapeo legacy global si se borra
el registro original. Este comportamiento conservador sobrevive a borrar y
recrear un mapping. Eliminar estas filas invalidaría la garantía y no forma
parte de ningún flujo normal.

Captura exige `GOOGLE_BUSINESS_PROFILE_REVOCATION_ENABLED=true` para ámbitos
con registros/bloqueos. El ámbito puramente legacy conserva su comportamiento
SQL sin generar comandos. Máximo 100 registros y 100 bloqueos previos por
desconexión; rechaza exceso. Se comprueba salud del outbox en la transacción:
umbral conservador 10000 pendientes y antigüedad menor de 3600 segundos.
No se afirma reserva distribuida de capacidad entre solicitudes concurrentes.

`businessProfileRevocations` / `business_profile_broker_revocations` se añade
al catálogo (45 definiciones): cada minuto, `Europe/Madrid`, prioridad high,
gate `GOOGLE_BUSINESS_PROFILE_REVOCATION_WORKER_ENABLED` falso por defecto.
Respeta leader y pausas existentes. Un intento del scheduler, sin retry
genérico ni lease del carril publicitario. La propia cola conserva el backoff.

Worker: máximo 20 activos secuenciales por ciclo y presupuesto de 30 s para
nuevos despachos; cada HTTP recibe hasta 10 s y el remanente. SQL no tiene
cancelación propia y puede exceder ese presupuesto, conservando la ejecución
ocupada. Claim con `FOR UPDATE SKIP LOCKED`, lease 120 s y CAS; intentos
limitados numéricamente y backoff exponencial hasta una hora. Sin máximo de
reintentos que elimine la solicitud. Estado confirmado y evento de finalización
se guardan juntos; un ACK recibido con lease antiguo no confirma SQL.

El job ejecuta la intención autorizada al desconectar aunque el usuario pierda
permisos después. No necesita que conserve una sesión viva para bloquear el
activo. Un error mantiene la fila pendiente y el acceso local bloqueado.

## Control del broker

Operación cerrada `google.business_profile.asset.revoke.v1`, payload `{}`,
grant exacto de principal + `clinic:<id>` + conexión + `gbp:<cuenta>:<ficha>`.
El arranque Google exige principal y clave pública Ed25519 distintos de todos
los lectores; cambiar solo `keyId` o el nombre del principal con la misma
clave no separa capacidades. Se autoriza incluso si la conexión está bloqueada.

Una transacción SQLite IMMEDIATE persiste el bloqueo de esa tupla, dos eventos
de auditoría y el resultado del comando. Un replay del mismo UUID/digest devuelve
el resultado guardado. Si falla auditoría o supera backlog, no hay commit parcial.
`asset_revocations` es aditiva y permanece en WAL/FULL entre reinicios. No hay
caducidad automática ni endpoint para borrarla. Se abortan lecturas en vuelo
del activo dentro del proceso; los controles tras cada espera detectan además
un bloqueo escrito por otro proceso sobre la misma SQLite. Otras clínicas/grants
no se invalidan por compartir la credencial. Un GET ya recibido por Google no
puede deshacerse; se descarta el resultado si se observa la revocación.

La operación de control no obtiene secretos ni llama a Google. El arranque
`google-main.js` continúa validando identidades AWS y construyendo clientes:
ejecutarlo realmente requiere acceso/lote aprobados. `npm start` sigue usando
la entrada ficticia. El discriminador de configuración continúa siendo
`google-business-profile-read-v1` por compatibilidad, con el grant de control
añadido explícitamente por cada tupla elegida.

API/worker usa `GOOGLE_BUSINESS_PROFILE_BROKER_CONTROL_KEY_ID` y
`GOOGLE_BUSINESS_PROFILE_BROKER_CONTROL_KEY_FILE`, separados de
`GOOGLE_BUSINESS_PROFILE_BROKER_KEY_ID/KEY_FILE` de lectura. Reutiliza origen,
audience y CA de transporte. Archivos absolutos, sin symlink y permisos privados,
máximo 64 KiB. No hay clave nueva en `.env` ni secreto OAuth devuelto a la API.
Dos ficheros en el mismo host/usuario **no acreditan aislamiento de host/IAM**;
la separación de identidades del despliegue sigue pendiente.

## Auditoría y costes

Evento cerrado v7 `integration.asset.disconnect`, prefijo `app/platform/v7/`:
intento del usuario y finalización del job `gbp_revocation_worker`, con el usuario
iniciador como sujeto. Correlación = UUID SQL persistido; sesión nullable para
legacy. Solo IDs, referencias, scope, estado y políticas fijas; nunca tokens,
nombre de ficha, contenido clínico ni cuerpos del proveedor. Intento/cola/mappings
comparten commit; confirmación/resultado comparten otro. El visor muestra
solicitud y activo y conserva cobertura parcial e identidad del proceso.

La auditoría del broker sigue en `app/integrations/v2/` con actor de servicio:
`integration.requested` y `asset.revoked`. No pretende autenticar por sí misma
al usuario humano ni sustituir la auditoría de plataforma.

Por nueva solicitud confirmada: dos eventos de plataforma y dos del broker,
más los costes de entrega S3/KMS y consultas del visor ya definidos en los
contratos previos. Reintento del mismo comando no duplica eventos del broker;
errores/denegaciones pueden añadir sus registros. Cero llamadas a Google o
Secrets Manager por el control en sí. El job/SQL y el almacenamiento durable
crecen con activos pendientes/históricos; medir volumen antes del corte.
No se ha recalculado factura ni inventado un precio: Ajustes conserva su caché
de Cost Explorer y estado pendiente. Budget 60 reportado frente a plantilla
45, conciliación CloudFormation, etiquetas/CE, trusts/permisos, rotaciones KMS
y retención DPD siguen pendientes y sin modificaciones AWS.

## Migración y corte pendiente

Nueva `20260913010000-create-business-profile-broker-revocations.js`: añade
índice de búsqueda por conexión/clínica al registro y tabla/índices de cola.
Prerequisitos GBP `20260913000000`, outbox `20260912210000` y columna
`result_part` `20260913003000`, además del esquema base de los contratos previos.
**Aplicar antes del nuevo código/modelo aun con gates apagados**, porque el
adaptador y estado consultan la tabla para impedir fallback. DDL MySQL múltiple
no es atómica: ante fallo parcial inventariar tabla/índices y conciliar bajo el
lote aprobado, sin ejecutar de nuevo a ciegas ni borrar filas.

Orden del lote que aún necesita aprobación:

1. Inventariar la cohorte y referencias, operadores/consumidores y credenciales
   compartidas; resolver su ciclo de vida restante y aceptar el cierre global
   del descubrimiento. Drenar lecturas/mutaciones concurrentes del canary.
2. Aprobar respaldo consistente, espacio/locks SQL, migraciones exactas,
   identidades/trusts/red/secretos y canal de instalación. DEV/staging comparten
   BD: coordinar los lectores y no aplicar todas las migraciones pendientes.
3. Desplegar writer/reader con v7 y broker con soporte de control antes de
   generar eventos/comandos; configurar claves y grants exactos. Verificar
   separación efectiva y conservar SQLite con su WAL y outbox en respaldo.
4. Desplegar API/worker/UI compatibles y aprobar ambos gates por separado.
   Comprobar canary autorizado, respuesta pendiente, bloqueo local, confirmación
   del broker, entrega externa y permisos de consulta. Ninguna prueba real se
   deduce de la QA ficticia descrita aquí.

Rollback: apagar captura/worker no restablece acceso. Conservar tabla/bloqueos,
SQLite y outbox; el `down` rechaza cualquier fila de revocación. No volver a un
broker/API que ignore bloqueos. Pausar el consumidor afectado y reparar hacia
delante; reactivación/reasignación requiere otro contrato y aprobación. El down
vacío solo se ha ensayado sobre la base temporal propia.

## QA aislada y publicación

Evidencias privadas bajo `/home/ubuntu/qa-evidence/security-migration-20260912/`,
prefijo `gbp-revocation-`. Broker Node 24: 41 tests (incluye TLS local con
dobles de AWS/Google, claves distintas, replay/reinicio/carreras y auditoría
atómica). Plataforma: 31 tests con codec/lector v7 y versiones S3 ficticias.
Backend Node 18: 23 tests de adaptadores, worker y HTTP; frontend: ocho tests
de estado/cancelación/scope y visor; hotfix: once tests. Contratos previos de
desconexión y orquestación del catálogo conservados con modelos/red aislados.

MySQL 8.0.42 propio, socket único y `skip-networking`: siete comprobaciones de
revocación más diez de regresión GBP; ambos procesos finalizaron con código 0.
Prueban commits/rollback, concurrencia de seis claims, lease obsoleta, fallo de
auditoría, ACK perdido, override de clínica y recreación de mapping. No se usó
la BD compartida. El test antiguo de scheduler se corrigió para inyectar modelos
antes de importar las fuentes; el guard de red bloquea conexiones ajenas.

Angular desarrollo terminó con exit 0. Chromium usa los componentes reales,
API ficticia y perfil nuevo: 16 capturas entre estado de desconexión y visor,
1440 px / 390 px, sin API externa ni sesión de pacientes. No equivale a QA de
autenticación ni navegación de la aplicación desplegada. Hotfix socialstats
conservado con SHA256 `0d14de2cb70b183e35e88f4561a48e190fc164c8bcb0628021e727f48770b8c5`.

Publicar solo este corte propio siguiendo sección 5 del runbook. La sección
nueva de API se redacta primero en backend y se espeja exactamente en frontend;
se conserva el desfase histórico restante sin arrastrar documentación de
publicidad. Evidencia de commits/remotos: `gbp-revocation-publication.json`
una vez completado el push. Push nunca aplica las migraciones ni despliega.
