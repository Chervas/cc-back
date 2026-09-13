# Google: reautorización de conexiones fijadas al broker

## Ampliación vigente: registro SC independiente (13/09/2026)

El primer SearchConsoleBrokerBindings también cierra globalmente connect y
callbacks legacy no reconocidos, aun con gates apagados. Los guards de conexión
consultan este registro por ID o subject; esquema `20260913030000` previo al
código junto a dependencias anteriores. No cambia la admisión GBP: SC/GA/Ads
activos siguen rechazados y alta/reautorización SC completas siguen pendientes.
Las [cuatro lecturas SC](google-search-console-read-migration.md) no autorizan
retomar OAuth real ni migrar una identidad con consumidores incompatibles.

## Ampliación local de loaders SC/GA (13/09/2026)

[La frontera de credenciales legacy](google-web-credentials-boundary.md) aplica
el registro OAuth a las rutas web y jobs SC/GA: carga/UPDATE condicionales y
revalidación de cachés/respuestas. No habilita esos consumidores en esta
reautorización ni cambia la política de una assignment. Sin despliegue real.

Preparación local del 13/09/2026. Ninguna conexión real migrada; sin despliegue,
OAuth real, lectura/escritura AWS ni migración de la BD compartida. OPS está
aplazado por el usuario; el apagado EC2 fue anunciado y no se ha comprobado.

## Alcance y límites

Se implementa la reautorización de una identidad Google previamente revisada,
con conexión, secreto existente, aplicación OAuth, activo de control y ámbito
fijados. Conserva el ID de `GoogleConnections` y su assignment. No crea cuentas,
secretos AWS, mappings, grants ni assignments, ni reactiva los desconectados.
No constituye el alta de identidades nuevas ni la migración de todas las
verticales Google. Google Ads/Data Manager, Search Console, GA4, escrituras GBP,
Meta, WhatsApp, recepción, webhooks y scripts restantes conservan sus pendientes.

La cohorte inicial admite una sola assignment de clínica o grupo por conexión,
una única fila Google para esa identidad, ninguna credencial en sus columnas SQL
y ningún mapping activo de las otras tres verticales legacy. Todas las fichas
activas deben tener referencias coherentes con el registro GBP independiente y
pertenecer al ámbito autorizado. El activo de control no puede estar revocado.
Se rechazan los casos compartidos incompatibles; no se recortan sus permisos ni
se desconectan consumidores automáticamente para hacer pasar el corte.

**El primer registro OAuth cierra globalmente `/google/connect` y los callbacks
legacy no reconocidos.** Un ámbito sin registrar podría autorizar la misma
identidad y obtener sus tokens antes de conocerla; un guard solo al guardar sería
tardío. Este impacto requiere aceptación previa, drenaje de callbacks antiguos y
publicación compatible de todos los receptores, incluido gateway. No borrar el
registro ni bajar un flag para recuperar el camino legacy. Los guards no pueden
retirar un token que un proceso antiguo ya haya recibido: el drenaje es una
condición del corte, no una garantía atribuida al código nuevo.

## Intercambio y activación

1. La API resuelve solo el ID de conexión. Comprueba sesión gestionada vigente,
   identidad del usuario, permisos de gestión sobre todas las clínicas, conjunto
   exacto del grupo, assignment y consumidores. Persiste solicitud, hash de state
   y auditoría v8 en una transacción `REPEATABLE READ`.
2. El broker recibe `oauth.begin.v1` firmado. Lee solo los dos secretos revisados,
   fija identidad/scopes/redirect y devuelve la URL Google. Mantiene PKCE en
   memoria durante diez minutos; la API no recibe el verificador.
3. El callback busca por hash de state. Revalida sesión y ámbito; consume la
   solicitud con un cambio SQL de estado antes de remitir el código una vez.
   El broker intercambia en `/token` y comprueba el ID de Google en la respuesta
   de `/oauth2/v2/userinfo`. Los access/refresh/client secrets permanecen dentro
   del broker. El código y state pasan por la memoria del callback; no se guardan
   en la BD, la cola ni la auditoría.
4. `PutSecretValue` guarda la versión candidata con UUID de flujo como
   `ClientRequestToken`, etiqueta `AWSPENDING` y digest canónico. `AWSCURRENT`
   conserva la versión anterior. La API revalida la autorización y confirma en
   SQL el resultado de preparación y la intención de activación con otro UUID.
5. El worker confirma esa intención mediante `oauth.activate.v1`.
   `UpdateSecretVersionStage` mueve `AWSCURRENT` indicando también la versión
   anterior; un cambio concurrente impide sobrescribir una versión más reciente.
   Se vuelve a leer la versión y el digest exactos antes de confirmar. La API
   guarda únicamente el UUID de versión y fecha junto al resultado auditado.

Las cinco operaciones cerradas son
`google.business_profile.oauth.{begin,finish,activate,status,abort}.v1`.
`begin` acepta solo `state`; `finish`, `flowId/state/code`; las restantes,
`flowId`. No aceptan URLs, ARN, scopes, identidad o contenido del secreto del
consumidor. Cada llamada exige grant exacto de principal/tenant/conexión/activo.
La clave OAuth debe ser distinta de las claves de lectura y revocación de activos.

El secreto v3 incluye proveedor, referencia de conexión, sujeto Google, client ID,
refresh token y scopes. No persiste access token. La renovación GBP existente
acepta v2/v3; en v3 comprueba el client ID y el sujeto cuando está configurado.
Un refresh v3 validado puede conservarse si Google no devuelve uno nuevo; el v2
solo sirve de baseline y nunca de fallback, porque no fija sujeto ni aplicación.
No se fuerza `consent` cuando ya existe un refresh v3 compatible y no consta
revocado. Si consta revocado se pide consentimiento y no se reutiliza ese refresh;
una credencial nueva sigue sin restaurar el acceso bloqueado. No se afirma
que obtener un token nuevo invalide el anterior. No se revocan tokens Google.

El broker admite ocho flujos en ejecución y 128 verificadores en memoria,
deadline de 25 segundos y transportes Google acotados. Limita candidatos a seis
por hora y ochenta por día por conexión según su ledger; otros escritores AWS
pueden consumir cuotas fuera de ese contador. No hay rotación periódica.
Los buffers que controla se borran; las cadenas de JavaScript y la memoria del
proceso no ofrecen una garantía de borrado completo.

## Recuperación y bloqueo

- La API no reenvía códigos tras timeout. El worker consulta `status`, que puede
  conciliar una versión candidata o terminar una activación ya autorizada. No
  es una operación puramente de lectura; requiere el mismo principal OAuth.
- Un broker reiniciado pierde PKCE. Un flujo aún no intercambiado se cancela;
  se necesita otra autorización. Los estados SQLite `staging/activating` se
  recuperan por versión/digest sin volver a intercambiar el código.
- `abort` crea también una lápida para un inicio no recibido. Impide que una
  petición de inicio tardía sobreviva a la cancelación. No borra secretos ni
  versiones y no cancela una activación que ya comenzó.
- Las credenciales nuevas no restauran permisos. Durante `activating`, las
  lecturas de la conexión quedan bloqueadas incluso desde otro proceso SQLite;
  confirmar incrementa su revisión, invalida caché y cancela lecturas en curso.
  Los bloqueos globales y revocaciones de activos anteriores se conservan.
- Un fallo de auditoría deja estados recuperables y evita confirmar antes del
  commit. Un resultado ambiguo puede permanecer pendiente con backoff; no se
  inventa éxito, rollback de AWS ni revocación del proveedor.
- Después del commit de la intención de activación, el worker puede terminarla
  aunque caduque la sesión original. Esa autorización ya se comprobó. No vuelve
  a activar assignments ni elimina bloqueos surgidos después.
- `AWSPENDING` puede coexistir con `AWSCURRENT` tras confirmar; la siguiente
  versión candidata moverá la etiqueta. No se ejecuta limpieza de versiones.

## BD, permisos y gate

Migración nueva: `20260913020000-create-google-oauth-broker-flows.js`.

| Tabla/cambio | Contenido y condición |
|---|---|
| `GoogleOAuthBrokerBindings` | Marcador independiente por sujeto Google; conexión/ref/activo/clínica/scope/política y última versión confirmada. Sin FK de borrado en cascada. |
| `GoogleOAuthBrokerRequests` | UUID de flujo/activación, hash de state, digest del vínculo, referencias, actor/sesión, clínicas, origen de retorno, caducidad, estado y lease/backoff. Sin OAuth code, tokens, PKCE ni JWT. |
| `GoogleConnections.accessToken` | Permite NULL. La migración no limpia, cifra, copia ni mueve valores existentes. |

Aplicar solo esta migración y sus dependencias aprobadas: sesiones gestionadas,
outbox de plataforma/result parts y registros/revocaciones GBP. Es previa al
código nuevo incluso con gates apagados: los guards consultan los marcadores.
MySQL DDL no es atómico entre sentencias. Inspeccionar cada paso si falla; no
repetir un `up` completo a ciegas. `down` rechaza registros, historial o tokens
NULL: preserva las barreras y nunca restaura credenciales legacy.
No hay purga automática de solicitudes o marcadores. Su retención SQL y la
retención externa deben acordarse; no se deducen del plazo S3 reportado.

Las transacciones mantienen el orden usuario/sesión, vínculo, conexión/ámbito y
solicitud. El worker reclama con `SKIP LOCKED` y lease de 120 segundos. Procesa
hasta diez solicitudes en un presupuesto de despacho de treinta segundos;
cada llamada del worker tiene como máximo diez segundos. Reintento propio
exponencial hasta una hora, sin retry genérico ni integración con colas de
publicidad. El job `google_oauth_broker_reconciliation` se prepara cada minuto
Europe/Madrid. No se ha cambiado ningún cron, pausa o flag operativo.

Gates API: `GOOGLE_OAUTH_BROKER_ENABLED=true` y
`GOOGLE_BUSINESS_PROFILE_BROKER_ENABLED=true`; worker adicionalmente
`GOOGLE_OAUTH_BROKER_WORKER_ENABLED=true`. Todos conservan su estado sin activar.
Sesiones `AUTH_SESSION_MODE=enforce` y contrato de auditoría de autenticación
son requisitos. Transporte: `GOOGLE_OAUTH_BROKER_KEY_ID/KEY_FILE`, origen,
audience y CA del broker existentes. Clave privada absoluta sin symlinks y con
permisos privados. No se ha creado ni instalado una clave operativa.

El role EC2 recibido solo reporta `DescribeSecret/GetSecretValue`. No se ha
verificado ni autorizado `PutSecretValue/UpdateSecretVersionStage`; se requieren
sobre los ARN exactos de las conexiones revisadas, no sobre el secreto de la
aplicación. Verificar además permisos KMS efectivos. No conceder CreateSecret,
DeleteSecret, ListSecrets ni acceso a secretos a la API. La separación de claves
de protocolo no equivale a separar hosts/roles IAM: el runtime preparado usa el
cliente Secrets Manager de la instancia. El lote IAM/aislamiento sigue pendiente.

## API, interfaz y auditoría

Se conservan `/oauth/google/connect`, `/callback` y `/connection-status`.
Connect devuelve `{success, mode:'broker', authUrl}`. Callback redirige a
Ajustes del origen permitido con `google_authorization=pending|confirmed|cancelled`,
sin reflejar state, código ni errores Google. El retorno gestionado no conserva
rutas/query arbitrarios de la pantalla inicial. Se usan `no-store` y
`Referrer-Policy: no-referrer` en el callback.

Status exige gestión del ámbito y sesión vigente, y devuelve solo metadata:
`mode`, `authorization_status`, `activation_confirmed`, `pending`, `enabled`,
`googleUserId`, `confirmed_at`, `connected:false` y
`reason:broker_authorization_metadata`. La activación de una versión no prueba
acceso actual al proveedor. Ajustes muestra conexión gestionada y estados
explícitos, actualización manual y reautorización deshabilitada mientras está
pendiente. Descarta respuestas de otro scope, cancela suscripciones reemplazadas
y no lanza lecturas legacy de Google por este DTO.

Auditoría v8: `integration.oauth.authorize` y `integration.oauth.activate`,
intento/resultado con correlaciones distintas, sujeto iniciador, actor usuario
o worker, sesión y ámbito/referencias; nunca contenido del secreto. Writer y
reader deben admitir v8 antes de activar captura. El visor muestra referencias
y permite filtrar ambas acciones. Los errores previos a admitir una solicitud
no están cubiertos por este codec: queda pendiente la auditoría completa de
OAuth y del resto de la plataforma. El broker mantiene su auditoría v2 de
servicio; no se presenta como sustituto del actor humano.

La captura del proxy/gateway y de cualquier access logger de URLs debe excluir
state/código y credenciales. Su verificación operativa sigue pendiente del lote
de despliegue; los tests no prueban la configuración de los receptores reales.

## Coste, aprobación y rollback

Sin recursos nuevos ni cambios de presupuesto. Las reautorizaciones añaden
operaciones Secrets Manager/KMS, versiones y cuatro eventos de plataforma,
además de auditoría del broker. Conciliaciones/reintentos añaden lecturas; no
se afirma coste cero. Usar la monitorización AWS y caché de Ajustes existente.
Cost Explorer/tags, filtro incremental y conciliación Budget 60 comunicado /
45 en plantilla con CloudFormation continúan pendientes, sin cambios en esta fase.

Antes del corte: aprobar consumidores exactos e impacto del cierre global,
sesión/roles/SSO y canal, grants/ARN/sujeto/scopes/redirect, loggers, traslado y
retirada de todas las copias reales, respaldo seguro, DDL y restauración,
versiones writer/reader/broker/API/gateway, canary ficticio/real acotado, coste,
ventana y rollback. La entrega AWS sigue siendo reportada. No reutilizar el
smoke secret como secreto operativo de Google sin un lote explícito.

Rollback seguro: cerrar la cohorte y conservar tablas, outbox y ledger SQLite;
mantener el broker que comprende la barrera `activating`. No volver a una versión
que ignore esa barrera, borrar marcadores, copiar tokens a SQL ni devolver la
credencial anterior a producción. Las versiones AWS ambiguas se concilian por
ID/digest; su retirada necesita revisión separada. Preservar el hotfix de
`socialstats.controller.js`, las pausas y todo el trabajo ajeno.

## QA y fuentes

Pruebas exclusivamente ficticias: broker/TLS/PKCE/Secret Manager doble,
identidad, scopes, claves separadas, versiones/CAS, respuestas perdidas,
reinicio, revocación y errores cerrados; MySQL propio con migración/up/down,
sesión real ficticia, permisos de grupo, cola/outbox, concurrencia y visor;
HTTP real sobre loopback propio y regresión del hotfix/jobs; componentes Angular
y Chromium desktop/móvil. Evidencias privadas en
`/home/ubuntu/qa-evidence/security-migration-20260912/google-oauth-*`.
El acta final de QA registra recuentos y salidas, no una validación AWS/Google.
Resultado de esta fase: 139 tests (broker 55, auditoría 34, backend/hotfix 38,
frontend 12), 11 checks MySQL con cierre limpio, contrato del catálogo de
46 jobs y 20 capturas Chromium. Build Angular `41e6223b939ab9cc`, exit 0;
advertencias existentes de estilos duplicados/CommonJS, sin errores de build.

Referencias primarias: [OAuth para servidores Google](https://developers.google.com/identity/protocols/oauth2/web-server),
[ejemplo PKCE del cliente oficial Google](https://github.com/googleapis/google-auth-library-nodejs/blob/main/samples/oauth2-codeVerifier.js),
[PutSecretValue](https://docs.aws.amazon.com/secretsmanager/latest/apireference/API_PutSecretValue.html) y
[UpdateSecretVersionStage](https://docs.aws.amazon.com/secretsmanager/latest/apireference/API_UpdateSecretVersionStage.html).
Estas fuentes sustentan el protocolo; no prueban configuración ni permisos
efectivos de las cuentas entregadas.
