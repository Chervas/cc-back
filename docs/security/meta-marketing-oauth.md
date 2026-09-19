# OAuth Meta: candidato de autorización nuevo

Preparación del 19/09/2026. Broker base `a1478095`; ampliación CRM/UI sobre
ese backend y frontend `529b6017`, todavía sin despliegue.
No desplegada. Contrato canónico primero en
[13-backend](../../src/Documentacion/13-backend.md#oauth-meta-candidato-nuevo-dentro-del-broker-preparado-19092026).

El callback legacy sigue intercambiando y guardando tokens en MySQL. Este corte
prepara el sustituto dentro del broker y su callback CRM con flags apagados.
No activa el producto ni reutiliza los tokens investigados. Meta real no se usa como QA.

## Flujo y límites

Runtime dedicado `meta-marketing-oauth-v1`; cuatro operaciones
`meta.marketing.oauth.{begin,finish,status,abort}.v1`. Solo claves independientes
`gateway:{dev|staging}:meta-marketing-oauth` y
`control:{dev|staging}:meta-marketing-oauth`; control limitado a status/abort.
Ed25519, TLS con CA, replay/nonce del broker y payload cerrado. Principal20/min;
dos peticiones ordinarias y una admisión de control, operación25 s y HTTP8 s.

Configuración privada estricta: entorno, policy, bind IP/puerto, SQLite, TLS y
renovación opcional. Máximo64 slots, uno por ámbito; cada slot separa secreto de
app y candidato, pins inmutables y lista completa/ordenada de clínicas. Callback
HTTPS exacto `/oauth/meta/marketing/callback`. La aplicación se preconfigura en
vault; no se solicitan ARN, host, permisos o credenciales al navegador.

Begin preflight de slot vacío, KMS, pins y capacidad; captura digest del ámbito,
state hash, UUID y vencimiento≤10 min. Máximo6 intentos/hora por conexión. Finish
intercambia code→token corto→token largo e inspecciona app/USER/scopes/expiraciones
y granular scopes. Sin consultas de perfil/nombre/email, campañas, mensajes o leads.
Permisos cerrados a los del lector Meta; no acepta permisos WhatsApp, escritura ni
scopes extra. No inventa caducidad de60 días si Meta no la aporta.

Guarda `meta-marketing-oauth-candidate` en la versión Secrets identificada por la
UUID, AWSPENDING; AWSCURRENT conserva `meta-marketing-oauth-slot` sin credencial.
La capacidad se vuelve a comprobar antes del canje y del Put; menos90 versiones,
sin paginar un conjunto desconocido. Candidato≤65536 bytes, sin truncar permisos.
No CreateSecret/UpdateSecretVersionStage/DeleteSecret, grants ni lectura de negocio.
Metadata de respuesta siempre `accessBlocked=true`. Solo autoridad futura de
activación podrá dar acceso tras verificar ACL, sesión, activos e historial.

SQLite guarda hashes del state/code y del candidato, metadata y estados; nunca
code, state literal, token o app secret. Auditoría técnica v2: solicitud y
confirmación atómicas con las transiciones. Un error devuelve código cerrado.
Se borran buffers propios/copiados; JavaScript/SDK aún pueden conservar strings
en heap hasta GC, por lo que no se afirma zeroización completa de memoria.

## Incertidumbre y recuperación

- ACK de Put perdido: consultar la misma versión/digest; no repetir code ni Put.
- Fallo al escribir auditoría final: permanece staging, sin declarar éxito.
- Candidato inexistente tras fallo: permanece incierto; abort y autorización nueva.
- Reinicio durante intercambio: mantiene exchanging incierto y prohíbe reenviar
  code; abort explícito. No modifica estados de otros propietarios al arrancar.
- Abort previo a begin deja tombstone. Durante I/O cancela el proceso y evita
  confirmación tardía. Un Put remoto puede dejar candidato inactivo tras abort;
  conservarlo, sin promoción ni borrado automático.
- Cambios de versión/KMS/identidad/conjunto de clínicas o bloqueo durante I/O:
  rechazo. No reparar cambiando el hash ni borrando diarios/bloqueos.
- Una sola instancia posee SQLite. Los límites no reservan CPU/SQL ni detienen una
  dependencia que ignore AbortSignal. Desactivar altas preservando cancelación y
  resolución de candidatos; conservar archivo SQLite y versiones Secrets.

## Validación y recursos

Node24, desde `services/integrations-broker`:

```sh
node --require ./test/offline-guard.cjs --test --test-concurrency=1 test/meta-marketing-oauth.test.js test/meta-marketing-oauth-http.test.js test/meta-marketing-oauth-runtime.test.js
node --require ./test/offline-guard.cjs --test --test-concurrency=1 test/*.test.js
```

42 pruebas específicas: recorrido de identidad nueva, HTTP real del adaptador con
transporte simulado, TLS/firmas/SQLite reales, reinicio real del servidor, pérdida
de ACK, fallo de auditoría, scope/grants/expiry, KMS/versiones, capacidad, buffers,
cancelación, errores y aislamiento de claves/entorno/proveedor. Red exterior cerrada;
Meta, Secrets y S3 son ficticios. Ese primer corte no contenía pantalla CRM.
La ampliación y sus evidencias propias se describen abajo; las capturas de retirada
anteriores no validan esta alta.

Muestra aislada: begin4 llamadas Secrets, finish28 (15 Describe,10 Get,2 List,1 Put)
y3 Meta (code, extensión, inspección). Status confirmado y abort: cero Secrets/Meta.
Dos eventos técnicos para alta preparada; abort añade uno, más fallos cuando ocurran.
Duraciones exactas/resultados de suite completa en99/evidencia privada; no extrapolar
a AWS. Coste incremental facturado `null`; no se ha consultado Cost Explorer ni
creado/contratado infraestructura. La operación no transporta archivos clínicos.

Evidencia: `qa-evidence/security-resume-20260917/meta-oauth-20260919/`.
El primer ensayo26/27 detectó que capacidad se revisaba demasiado tarde si cambiaba
entre begin y finish; corregido antes de aceptar42/42. Conservar ambos logs.

## Requisitos pendientes para publicación

1. Inicio/callback CRM y UI preparados según la sección siguiente; falta su
   publicación selectiva y aceptación pública con MFA y proveedor real.
2. Selección/discovery y escritor transaccional de bindings/grants; validar
   identidad/propiedad/alias/primarias/shares y toda baja física previa. Una UUID o
   conexión nuevas no permiten borrar historial ni restaurar acceso retirado.
3. Activación independiente, idempotente y recuperable, con aceptación por el titular
   y proveedor; lectores preparados no pueden consumir el envelope candidato.
4. IAM/TLS/slots y servicio de entorno propios, publicación selectiva, lectura
   AWS y verificación de recibos y carga. Autenticación AWS caducada, sin challenge
   nuevo abierto en este corte. No promover toda DEV ni modificar canary v19.
5. Retirar el callback/credenciales legacy solo con consumidores completos y corte
   aceptado. Mantener MFA, pausas, WhatsApp y DEV clínico apagado.

La documentación Meta oficial consultada devolvió429. El patrón de intercambio
está contrastado con el
[SDK oficial archivado de Facebook](https://github.com/facebookarchive/php-graph-sdk/blob/5.x/src/Facebook/Authentication/OAuth2Client.php),
fuente histórica; no acredita la disponibilidad ni permisos vigentes. Revalidar
[flujo manual](https://developers.facebook.com/docs/facebook-login/guides/advanced/manual-flow/),
[tokens largos](https://developers.facebook.com/docs/facebook-login/guides/access-tokens/get-long-lived/)
y [debug_token](https://developers.facebook.com/docs/graph-api/reference/debug_token/)
antes de aceptar una cohorte real. Copias/restauración permanecen al final.


## Ampliación CRM/UI candidata

Contrato canónico: [OAuth desde CRM](../../src/Documentacion/13-backend.md#oauth-meta-desde-crm-autorización-candidata-y-conciliación-preparado-19092026).
DDL `20260919060000-meta-marketing-oauth.js`; modelos Slots/Requests independientes,
metadata y hashes, sin código/token/state literal/ARN. Sesión gestionada y prueba
MFA por correo, permiso completo de clínica/grupo y revalidación durante I/O.
Una sesión solo con contraseña responde401 en el helper fuerte existente; no se
ha debilitado la política MFA para cambiar ese contrato. La UI muestra un nuevo
inicio solo con slot/política habilitados y no presenta staged como conexión activa.

El job `meta_marketing_oauth_reconciliation` usa JobRequests y solicitudes SQL
como outbox, lease120 s/SKIP LOCKED, diez filas/30 s cooperativos y backoff hasta1 h.
No activar la planificación clínica DEV para ejecutarlo. Estado GET local; solo
inicio, callback y comprobación/cancelación explícitos llaman al broker. La ruta de
control puede terminar una baja después del logout; aceptar candidato exige la
sesión/permiso de origen. Cancelación conserva versiones candidatas inactivas y
historial de revocación, sin promoción ni eliminación.

Auditoría humana v22 separa autorización y cancelación por result_part0/1 dentro
de la misma correlación. Captura y transición SQL atómicas; copia S3 verificada en
el panel. La salud distingue cancelación pendiente de autorización ya completada.
Antes de habilitar productor: lector v22, escritor v22 y prueba compatible; no
alterar archivo ni canary v19 congelados. Cualquier ACK incierto se reconcilia con
la misma UUID/versión; nunca se resuelve reenviando código ni retirando el lector.

Pruebas reproducibles, desde back-dev con Node24:

```sh
CAMPAIGN_OPTIMIZATION_MYSQL_TEST=1 META_OAUTH_CRM_VISUAL=1 node src/scripts/tests/meta_marketing_oauth_mysql.integration.js
node --test services/platform-audit/test/*.test.js src/scripts/tests/platform_audit*.test.js
node src/scripts/tests/scheduled_jobs_orchestration.test.js
```

El arnés crea y cierra su propio MySQL sin red y permite solo servidores TLS/HTTP
loopback propios. Los componentes de producto Angular se montan sin modificar;
Meta/Secrets/S3 y datos de alrededor son ficticios. No abre popup Facebook real ni
acredita login público. Evidencia privada separada:
`qa-evidence/security-resume-20260917/meta-oauth-crm-20260919/`.
Revisar también `meta-marketing-oauth-crm-consumers.json`; el inventario anterior
conserva los hashes y el alcance histórico del broker. No hay runtime/DDL/flags
promovidos. Recuperación: detener nuevas altas conservando worker de control,
solicitudes/diarios/versions/eventos; reintentar estado/abort, no canje. Revertir UI
es reversible; no bajar DDL poblado ni retirar soporte lector con v22 pendiente.


## Resultado del corte CRM (19/09/2026, UTC)

- Siete grupos integrados SQL/API/TLS/SQLite; MySQL8.0.42 propio termina0, pool0/0.
  Begin29 consultas/77 ms; ensayo completo con fallos y UI1011 consultas. Son
  datos de laboratorio con proveedores ficticios, no latencias de CRM o AWS.
- Ocho capturas Angular/Chromium, desktop1440 y móvil390: preparado, esperando,
  staged, cancelación pendiente y confirmada, y auditoría. Cambio de ámbito retira
  URL; pérdida de permiso oculta inicio; tras confirmar cancelación permite un
  nuevo inicio. Cero errores JS, desbordamiento, salidas externas o escrituras de
  negocio. Abrir Ajustes y cancelar no añaden llamadas Meta/Secrets.
- 122 pruebas de auditoría/regresiones; ocho grupos de auditoría MySQL y siete de
  lotes de pacientes anteriores; siete pruebas de router OAuth/regresiones Google
  y baja scoped. Catálogo51/orquestación correcto. Sintaxis31 archivos backend.
- Build Angular completo `cf7d25b1fb5a1f74`,108197 ms; aviso CommonJS preexistente
  debug/socket.io-parser. Compilación y capturas privadas, sin publicación de assets.
- Corregida colisión de auditoría entre autorización/cancelación y su medición de
  pendientes; corregido retorno de error para usar origin configurado, sin heredar
  el dominio fijo legacy. La ruta OAuth montada verifica éxito/error, sesión y rechazo
  de destino inyectado. Fixtures anteriores actualizados para registrar dependencias
  Meta no usadas, que siguen lanzando error si se invocan; no se abrió acceso real.

Se conservan fallos iniciales en los logs: expectativa401/403 incorrecta de MFA,
colisión real de auditoría, expectativa de cancelación pendiente cuando ya estaba
confirmada y selector ficticio que mantenía un nombre de grupo al elegir clínica.
Las últimas ejecuciones aceptadas son `accepted.log`, `audit-final.log`,
`mounted-routes-final.log`, `audit-sql-regression.log`, `audit-patient-regression.log`
y `build-final.log`. Los hashes exactos de código están en el inventario CRM.
