# Baja coordinada Meta no WhatsApp

Preparada el 19/09/2026; no publicada. Mismos worktrees DEV. Contrato primero en
[13-backend](../../src/Documentacion/13-backend.md#baja-coordinada-meta-no-whatsapp-preparada-19092026)
y espejo idéntico en frontend. No se han modificado AWS, bases clínicas, flags,
pausas, MFA o releases. OAuth/altas nuevas y aceptación real siguen pendientes.

## Contrato y frontera

`GET/DELETE /oauth/meta/marketing-disconnection` requiere sesión SQL gestionada y
permiso Marketing de escritura en toda la clínica/grupo explícitos. DELETE no
admite payload de proveedor. Bloquea usuario/sesión y membresías en la transacción
y revalida el ámbito. Rechaza alias, shares, primarias o historial de fuera del
ámbito, sin usar solo la clínica pivote del grupo.

La misma transacción registra intenciones por tuple clínica/conexión/activo,
auditoría v21, bindings blocked y mappings no WhatsApp inactivos. Error de auditoría:
rollback completo. El registro independiente no tiene credenciales ni FK en cascada;
conserva identidad, alcance, mapping IDs, actor, UUID, lease, intentos y estado.
Cada tuple conserva su UUID ante otra solicitud o reintento. No necesita validar
primero el token con Meta. La baja empieza localmente al confirmar en CRM.

Mantiene MetaConnections/MetaConnectionAssignments compartidas y todos los mappings
WhatsApp. No usa el tombstone universal ni revoca tokens remotos. La desconexión
legacy rechaza conexiones con marcador externo para no eliminar la identidad
compartida. El lector tipado consulta ahora el historial independiente por activo:
una baja sigue impidiendo lecturas aunque se reactiven mappings/bindings. El nuevo
escritor OAuth deberá respetar este límite; no se permite borrar el historial para
volver a conectar.

`MetaMarketingBrokerRevocations` es el outbox de control. El job estándar
`meta_marketing_broker_revocations` se programa cada minuto mediante JobRequests,
prioridad high, maxAttempts1: los reintentos son de la intención, no otro payload
de JobRequest. Hasta20 comandos por lote/30 s cooperativos; petición≤10 s, lease120 s,
SKIP LOCKED y backoff hasta1 h. El worker usa clave de control separada del lector,
HTTPS/CA/audience del entorno y solo operación tipada de revocación. No ejecuta en
gateway. No crea BullMQ ni se añade al worker DEV operativo con este corte.

ACK perdido, fallo SQL o auditoría de confirmación fallida: misma intención pendiente.
Solo requestId exacto y `{revoked:true}` permiten confirmar con auditoría atómica.
La petición aceptada continúa aunque después se cierre la sesión humana. No llama
a Meta/Secrets ni reproduce mensajes, campañas o leads; los controles son bloqueos
locales del broker. Resultado desconocido no se convierte en éxito automáticamente.
Los límites no garantizan cancelación SQL ni reserva de CPU/disco/conexiones.

## Interfaz y auditoría

Ajustes añade confirmación explícita y estados pendiente/confirmado, con actualización
manual. El usuario de solo lectura conserva los metadatos y no ve controles de baja.
Cambio de clínica/sesión invalida solicitudes/confirmaciones anteriores. Un conflicto
de activo compartido pide revisar asignaciones, sin desvincular por aproximación.
WhatsApp se mantiene separado y explicado en la pantalla.

Auditoría v21 `integration.asset.disconnect`, provider `meta_marketing`: actor humano
y confirmación por job, ámbito completo, activo y correlación; sin nombres, tokens
o contenido clínico. Panel existente exclusivo de administradores técnicos, versión
S3/hash/KMS comprobados. La consulta del panel también deja su propia auditoría.
El archivo/canary AWS v19 congelado no cambia; v21 necesita un candidato separado.

## QA y carga observada

Node24 desde back-dev:

```sh
CAMPAIGN_OPTIMIZATION_MYSQL_TEST=1 META_REVOCATION_TEST=1 META_REVOCATION_VISUAL=1 node src/scripts/tests/meta_marketing_broker_mysql.integration.js
CAMPAIGN_OPTIMIZATION_MYSQL_TEST=1 META_ACCESS_E2E_TEST=1 META_ACCESS_E2E_VISUAL=1 node src/scripts/tests/meta_marketing_broker_mysql.integration.js
node src/scripts/tests/scheduled_jobs_orchestration.test.js
```

Diez grupos integrados: DDL/índices up/down/up desde esquema anterior y rechazo de
down poblado; roles de todas las clínicas; revocación de sesión antes del commit;
alias/shares/primarias ajenos; rollback al fallar auditoría; retirada durante una
lectura retenida; WhatsApp y assignment preservados; solicitudes repetidas; leases
distintas y rechazo del ACK con lease antiguo; ACK de broker perdido, confirmación
SQL fallida, reinicio y recuperación con la misma UUID. La baja confirmada persiste
si se reactivan mappings/bindings. Cierre de sesión posterior no frena el worker.

Siete capturas Angular: solo lectura, confirmación1440/390 px, pendiente móvil,
confirmado móvil/escritorio y auditoría con detalle abierto. Una sola petición DELETE
desde navegador; sin escrituras de negocio, errores JS o red ajena. Writer/drain/reader
reales sobre S3 ficticio, seis eventos v21 verificados y rechazo del usuario no admin.
No monta todo OAuth ni prueba login/MFA público o permisos Meta reales. Las APIs
WhatsApp de este montaje devuelven listas vacías: su preservación se acredita en
SQL; no es una aceptación visual o de envío real de WhatsApp.

MySQL8.0.42 propio, HTTPS/Ed25519/SQLite reales; Secrets/Meta/S3 ficticios. Reloj
simulado coherente para backoff, entrega y lectura de auditoría. Prueba final:
retirada31 sentencias/134 ms; total1129 sentencias, diez comandos de lectura y seis
de control (tres UUID), 60 llamadas Secrets/20 Meta del recorrido de lectura,
**cero de ambas durante control**. Tres pendientes tras ACK/fallo de auditoría pasan
a tres confirmadas tras reinicio. Pool final0 en uso/espera; ningún SELECT de valores
de credencial Meta. Es un ensayo aislado, no una medida sostenida de CRM/AWS.

Regresión del acceso manual v20: diez grupos, cuatro capturas, 68 sentencias/109 ms
por comprobación; añade consulta de historial a cada revalidación. Suite auditoría
87/87, 27/27 regresiones Meta/Google de revocación/contención, orquestación de jobs
correcta con50 entradas, sintaxis27 JS y build Angular development correctos.
Build final04:33:02 UTC, hash4b8762036b7f37f5, con aviso CommonJS previo de debug.
La invocación inicial de ngc sobre el tsconfig raíz encontró problemas previos de
fuentes ajenas a la app; el build de aplicación es la validación válida del corte.
No se declara limpio el catálogo i18n global; se añaden12 claves ES y12 CAT sin
cambiar valores existentes.

La revisión de fixtures corrigió la reconstrucción del esquema anterior (Sequelize
conserva `_indexes` además de options.indexes) y el uso del reloj simulado en drain
y snapshot del panel. Los ensayos fallidos se conservan, no se cuentan como aprobados.
Evidencia privada: `qa-evidence/security-resume-20260917/meta-revocation-20260919/`.
Coste incremental facturado null; sin Cost Explorer nuevo ni recursos contratados.

## Publicación y recuperación

1. Completar OAuth/escritor de altas/grants; no reutilizar tokens investigados ni
   permitir nuevas altas borrando una baja anterior. Aceptación del titular y de
   scope/grants reales pendiente.
2. Preflight selectivo de API/modelos/consumidores y ambas migraciones Meta, en orden
   040000 y050000. La segunda añade tabla y dos índices: bindings(scope_key,state),
   ClinicMetaAssets(assetType,metaAssetId). DDL MySQL no transaccional; comprobar cada
   objeto/SequelizeMeta y resolver estados parciales expresamente. El nuevo lector
   depende de la tabla aunque solo se abra la comprobación manual anterior.
3. Preparar/publicar lector AWS v21 antes del escritor y ambos antes del productor.
   Verificar versiones, recibos, TLS, IAM y carga. No reconstruir/sustituir archivo
   ni seis eventos del canary v19 congelado. Aceptación real y SSO operativo pendientes.
4. Habilitar captura/worker con los flags de03, identidad de control y namespace
   propios. Conservar dueño único de jobs, pausas y jobs clínicos DEV apagados;
   no promover todo DEV o iniciar un barrido de negocio para procesar estas bajas.

Ante regresión, cerrar capturas nuevas conservando entrega de bajas ya aceptadas.
Si se detiene el worker, documentar pendientes y reanudar la misma intención/UUID;
no limpiar leases/journals a ciegas, marcar confirmado manualmente o restaurar tokens.
Conservar registros, bloqueos, auditoría y SQLite; down rechaza tabla poblada.
Copias/restauración permanecen al final. Contratos13/20.17, variables03, jobs11,
madurez19, prioridades16, recursos/costes39 y corte/recuperación99. Inventario de
fuentes: `meta-marketing-revocation-consumers.json`.
