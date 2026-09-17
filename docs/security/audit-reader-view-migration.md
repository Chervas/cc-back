# Lector, visor y conciliación de auditoría

> **Tipo:** runbook técnico.
> **Fuente de verdad:** consulta verificada, proyección del visor y compatibilidad de despliegue.
> **Última revisión:** 2026-09-17.
> **Relacionado con:** [manual central](https://github.com/Chervas/cc-front/blob/dev/src/Documentacion/00-README.md), [contrato 39](https://github.com/Chervas/cc-front/blob/dev/src/Documentacion/39-seguridad-integraciones-cifrado-auditoria.md).

Estado operativo y límites vigentes en [19](https://github.com/Chervas/cc-front/blob/dev/src/Documentacion/19-estado-actual.md#seguridad-de-acceso-e-integraciones).
Este documento no sustituye la evidencia de despliegue. Los lotes históricos del
12–13/09 se conservan en Git y en la bitácora central; no ejecutar sus instrucciones
de aprovisionamiento como si describieran la infraestructura actual.

## Alcance y confianza

El visor consulta el índice local de eventos entregados de `PlatformAuditEvents`
y exige comprobar cada cuerpo contra la versión S3 de su recibo. Una versión
ausente, un digest distinto o un fallo de auditoría impiden devolver la página.
No utiliza el cuerpo local como alternativa si falla el lector. La respuesta
proyecta identificadores, fechas, acción, etapa, resultado y scope; no expone
IP, cuerpo canónico, recibos, criterios históricos ni credenciales.

Esto acredita las versiones comprobadas, **no la integridad ni exhaustividad
del índice local**: quien pueda modificar la BD puede ocultar filas. Tampoco
prueba inmutabilidad de S3; un administrador con permisos efectivos de borrado
de versiones puede eliminarlas. Object Lock sigue apagado según la entrega.
El lector admite los eventos versionados `app/platform/v1/` a `v15/`; no incluye
el contrato `app/v1` del broker, eventos aún pendientes de entrega ni acciones
no instrumentadas. La lista cerrada de acciones está en `src/view-contract.js`
del paquete de auditoría. Añadir un esquema al writer requiere probar también
`refFor`, `inputFor`, lectura, proyección y filtro: aceptar su escritura no
garantiza que el lector reconozca la ruta de esa versión.
No se reconstruyen seis meses anteriores ni se declara cobertura clínica,
de permisos, exportaciones, sockets o de todas las lecturas de la plataforma.
La lectura de `/audit/health` sigue pendiente de instrumentación semántica.

El servicio lector es Node 24 separado de la API Node 18, sin modelos ni BD
clínica. Solo usa GetObject y STS con IMDSv2 explícito; verifica cuenta/rol
origen, asume el reader existente y verifica el destino antes de leer. No usa
perfiles compartidos, SSO del operador ni claves AWS de entorno. Endpoints
fijos París, sin reintentos automáticos del SDK ni redirecciones S3.

El rol de origen del lector debe ser distinto del origen del writer. Comparar
ARNs en el programa no demuestra aislamiento de permisos efectivos: revisar
trusts, políticas y acceso a IMDS desde cada workload. Instalar ambos como
procesos con acceso al mismo instance profile no cumple esa separación.
La separación real de usuarios, roles e IMDS se documenta en el contrato 39.
Verificarla al reinstalar servicios; este runbook no concede al backend permiso
de asumir el reader ni de consultar secretos.

## API y consultas

`GET /api/system-monitoring/audit/events`, detrás del verificador común JWT.
Habilitado exige administrador técnico global (IDs 1 o 44 del helper actual)
y sesión persistente vigente. Ser propietario/admin de una clínica no concede
esta lectura global. Actor y sesión proceden del middleware; el cliente no
elige la identidad que autoriza la consulta.

| Parámetro | Contrato |
|---|---|
| `from`, `to` | Fechas UTC inclusivas YYYY-MM-DD, máximo 31 días |
| `action` | Opcional: catálogo cerrado `view-contract.ACTIONS`, incluidas autorizaciones WhatsApp |
| `userId` | Opcional: ID numérico positivo, filtra actor **o** sujeto |
| `cursor` | Opcional: continuación firmada HMAC, ligada a actor/sesión/criterios, caduca en 10 minutos |

Rechaza campos desconocidos, fechas inválidas, cursores alterados/expirados y
reutilización por otra sesión. SQL fijo con replacements, límite 26 para
devolver 25 y conocer si existe siguiente página, orden por fecha/UUID y
snapshot de entregas confirmadas. Una entrega tardía no entra a mitad de esa
navegación; una consulta nueva la puede incluir. Hint MySQL de ejecución
máxima 1500 ms e índice `(state, occurred_at, event_id)`; revisar el plan con
volumen representativo antes del corte, los filtros JSON no tienen índice
propio. El límite de fechas no equivale a un límite del total de eventos.

Respuesta disponible: `version:1`, `status:available`, `criteria`, `snapshot`,
`nextCursor`, `coverage:confirmed_platform_index_only`, `events`. Cada evento
tiene `verification:s3_version_verified`. Gate apagado devuelve a técnicos
`status:disabled`, lista vacía y cursor null sin consultar modelos/lector ni
leer archivos de claves. No afirma que no existan registros. No técnico: 403.
Con gate activo: 400 consulta inválida, 403 acceso/sesión insuficientes, 503
indisponibilidad; JWT inválido/revocado: 401 del middleware. `private, no-store`.

Ajustes → monitorización → Auditoría hace una consulta al entrar y luego
consultas explícitas, sin polling. Fechas de filtro UTC y resultados en Madrid.
Anterior/siguiente conservan el snapshot; cambios de filtro/errores vacían los
datos visibles. No incorpora exportación. El estado parcial se explica en UI.

El panel muestra tarjetas con acción, ámbito, actor, fecha y resultado; los
identificadores técnicos, motivo categorizado y correlación se despliegan a
petición. Los contadores describen **solo los registros de la página**, no
operaciones únicas ni totales del periodo. Denegación no equivale a ataque.
Una autorización WhatsApp iniciada/recibida no se etiqueta como envío activo.
No se incluyen direcciones IP, texto de pacientes, secretos ni valores de cambios.
El enlace a Usuario solo se construye con un ID numérico válido.

La proyección incluye `correlationId` y, en v15, `whatsappAuthorization.requestRef`.
Son referencias de auditoría, no el código OAuth, el estado de retorno ni el
identificador de acceso Meta. Mantener esa distinción al añadir detalles.

## Lectura firmada y límites

TLS 1.2 como mínimo, CA/nombre verificados y claves Ed25519 distintas para
`confirmed` (visor) y `reconcile` (conciliador). El lector rechaza reutilizar
una misma clave pública con distintos IDs de principal. Cada principal tiene
un solo permiso. La firma liga método, ruta fija `/v1/audit/read`, cuerpo,
audiencia, timestamp y nonce. Desfase máximo 60 s; nonce durable 120 s y
petición UUID única. Hasta 25 referencias cerradas por lote, 30 peticiones por
minuto/principal, 4 peticiones simultáneas y 4 GET simultáneos por petición.

`confirmed` solo acepta actor 1/44 y referencia de sesión; exige VersionId
exacto y devuelve el cuerpo verificado. El lector confía en la afirmación
firmada de la API sobre ese usuario: no verifica su JWT ni consulta sesiones.
Comprometer la clave del visor permite suplantar esa afirmación dentro de
los límites del permiso. Proteger y asignar esa clave es parte del corte.
`reconcile` solo acepta actor técnico fijo sin sesión y referencias sin
VersionId; comprueba la versión actual y devuelve **únicamente recibos**.
La clave del conciliador no permite recuperar cuerpos por el protocolo.
Dar ambas claves al mismo proceso reduce su separación efectiva; verificar
su distribución por runtime, además del aislamiento IAM del lector.

S3 debe devolver owner/bucket esperados, SSE-KMS con ARN de auditoría exacto,
Content-Type JSON, longitud 1–4096, checksum SHA256, contenido canónico, clave
y VersionId compatibles. Respuestas completas validadas en orden y ligadas a
la petición; ni un resultado parcial ni una versión ajena se muestra como éxito.
Backend: timeout absoluto 20 s y respuesta máxima 300 kB. Lector: cuerpo de
entrada máximo 64 KiB, timeouts HTTP y señal AWS de 15 s; operaciones SDK
con conexión 1,5 s/solicitud 3 s. No hay descargas ni proxy arbitrarios.

## Auditoría de la propia consulta

El visor escribe intento v3 durable antes del SELECT/lectura externa y
resultado antes de devolver datos. Resultado exitoso significa registros
verificados y respuesta preparada, no recepción por el navegador. Criteria
está cerrado; solo fechas, acción enumerada e ID. El resultado conserva número
y digest del conjunto de referencias, sin copiar eventos leídos. V3 usa
`audit.records.read`, `capturePolicy:audit-view-v1`, `app/platform/v3/`.
Fallos finales pueden dejar un intento sin resultado, visible como incertidumbre
en el monitor. Cola ≥10000 o antigüedad ≥1 h impiden consultas nuevas.

Rechazos de permiso/sesión y criterios inválidos, con gate activo y actor JWT
verificado, escriben denegación sin criterios crudos. Si esa escritura falla,
responde 503. JWT rechazado por middleware o gate desactivado no genera este
evento: no debe contarse como cobertura total de intentos de acceso.

Además, SQLite privado del lector confirma una entrada antes de cada lectura
firmada admitida: principal, actor/sesión, requestId, modo, digest/cantidad de
referencias y tiempos/resultado. La correlación v3 del visor coincide con el
requestId. No almacena cuerpos. WAL/FULL, directorio 0700 y archivo 0600,
sin purga de este journal; máximo 100000 entradas, después rechaza consultas.
Una entrada sin finalización expresa resultado desconocido. Nonces y ventanas
de cuota sí expiran. Peticiones rechazadas antes de admitir no entran en él.

**Este journal es evidencia local, no una segunda entrega externa inmutable.**
El outbox v3 se entrega por el writer de plataforma; su confirmación S3 es
asíncrona. Definir respaldo externo, monitor de capacidad, retención y pruebas
de recuperación del journal antes de activarlo. CloudTrail reportado no tiene
eventos de datos S3: el lector no corrige esa carencia por sí solo. DPD debe
decidir plazo/cómputo de ambos registros; 183 días no se equiparan a seis meses.

## Conciliación y persistencia

Job `platformAuditReconciliation` / `platform_audit_reconciliation`, cada 5
minutos Europe/Madrid, con gate propio por entorno. Hasta 25 filas `reconcile`, con
claims SKIP LOCKED y leases existentes de 120 s; ventana de adquisición 10 s.
Verifica recibos y confirma con CAS de lease/digest. Conflictos y fallos
conservan el evento pendiente y backoff de outbox; el job declara `failed`
si alguna fila falla, sin retry genérico. No borra eventos ni reescribe S3.
Varios workers no concilian la misma fila a la vez. Esto resuelve el ACK
perdido del writer cuando la versión externa coincide; no certifica histórico
de versiones ni recupera objetos eliminados.

Índice del visor: `20260912230000-index-platform-audit-view.js`, añade
índice en PlatformAuditEvents. En las pruebas se aplica en MySQL propio ficticio. `down`
retira el índice y conserva tabla, eventos, recibos y sesiones. Dependencias:
outbox `20260912210000`, monitor `20260912213000`, sesiones `20260912220000`.
Comprobar `SequelizeMeta` del entorno antes de promover. No ejecutar todas las
migraciones pendientes ni inferir el estado de SQL a partir del código.

## Configuración por entorno

| Runtime | Ajuste |
|---|---|
| API | `PLATFORM_AUDIT_VIEW_ENABLED` (ausente/false desactiva; inválido falla) |
| Worker | `PLATFORM_AUDIT_RECONCILIATION_ENABLED` (solo true habilita) |
| Ambos clientes | `PLATFORM_AUDIT_READER_ORIGIN`, `PLATFORM_AUDIT_READER_CA_FILE` |
| Visor | `PLATFORM_AUDIT_VIEW_KEY_ID`, `PLATFORM_AUDIT_VIEW_KEY_FILE`, `PLATFORM_AUDIT_VIEW_CURSOR_KEY_FILE` |
| Conciliador | `PLATFORM_AUDIT_RECONCILE_KEY_ID`, `PLATFORM_AUDIT_RECONCILE_KEY_FILE` |

Claves Ed25519 PKCS8 PEM; cursor: archivo de **32 bytes binarios** aleatorios
independiente, no hexadecimal ni JWT_SECRET. Archivos privados regulares de
ruta absoluta/canónica, sin symlink y sin permisos de grupo/otros. Claves y CA
se cargan una vez por proceso; su sustitución exige el reinicio aprobado.
No imprimir valores de claves ni copiar la configuración pública a DEV.

Servicio lector: `node services/platform-audit/src/reader-main.js <config>`
con Node 24 y dependencias de su package-lock. JSON privado con
`readerSourceRoleArn`, `writerSourceRoleArn`, `port` (1024–65535),
`listenAddress` (default 127.0.0.1), `stateFile`, `tlsKeyFile`, `tlsCertFile`,
`principals:[{keyId,enabled,modes:[confirmed|reconcile],publicKey}]`.
Son nombres de campos, no un archivo listo para desplegar. La configuración
debe recoger ARNs, origen TLS y rutas realmente asignados; no inventarlos.

## Compatibilidad antes de publicar

1. Comprobar identidad y permisos efectivos del lector y writer con metadata;
   no leer secretos. Confirmar red, aislamiento, KMS y retención con el contrato 39.
2. Publicar primero codecs y lector compatibles con todas las versiones que el
   emisor ya captura. Usar un evento ficticio y comprobar el recibo concreto.
3. Publicar proyección API y frontend compatibles. No reiniciar trabajadores de
   negocio ni cambiar pausas al actualizar el lector de auditoría.
4. Preservar outbox, recibos, sesiones y SQLite del lector. Una incompatibilidad
   no se resuelve borrando eventos ni sirviendo su cuerpo local sin verificarlo.
5. Comprobar una consulta autorizada y el rechazo de otra no autorizada en cada
   entorno; DEV consulta su propio índice y no el de staging.

| Síntoma | Comprobación y acción |
| --- | --- |
| Una página falla al incluir autorizaciones WhatsApp | Verificar soporte v15 en `reader-protocol.js` tanto en cliente como en servicio AWS. Publicar ambos; conservar el evento. |
| `audit_integrity_invalid` | Contrastar VersionId, digest, KMS y cuerpo canónico; no relajar comprobaciones. |
| 403 | Sesión persistente y administrador técnico; no ampliar acceso a toda la clínica. |
| 400 al paginar | Cursor caducado o filtros/sesión distintos: iniciar consulta nueva. |
| Sin registros | Verificar filtros, entrega pendiente y cobertura; no equivale a ausencia de actividad. |
| Una página mezcla inicio y resultado | Son dos eventos de la misma correlación; no sumar como acciones de negocio independientes. |
| No hay respuesta del lector | Revisar TLS, identidad, servicio y límites; no usar un fallback sin firma. |

Por página no vacía hay hasta 25 GET S3, operaciones KMS que requiera S3 y
verificación/asunción de roles (tres operaciones STS por petición). Se añaden
dos eventos v3 a entregar; denegación genera uno. El conciliador añade lecturas
por lote. No se ha medido facturación ni cotizado un despliegue; Budget 60 USD
es reportado, alerta y no límite duro. Conciliar filtros/CloudFormation y
Cost Explorer/tags antes de estimar el coste incremental. No sumar estos costes
dos veces a IA ni afirmar que quedan cubiertos con una nueva instancia gratis.

Rollback: cerrar gates, detener solo el lector/job aprobado, conservar journal,
outbox/recibos/sesiones. Volver a UI previa o estado desactivado, nunca a servir
cuerpos locales sin verificación. Retirar el índice solo si se aprueba y hace
falta; no borrar evidencias, ampliar permisos ni deshacer el hotfix Meta.

## QA y publicación

En `services/platform-audit`, con Node 24:

```sh
node --require ./test/offline-guard.cjs --test test/*.test.js
```

Desde backend, la siguiente integración crea y destruye su propio MySQL por
socket UNIX; impide TCP, bootstrap de modelos productivos y proveedores reales:

```sh
CAMPAIGN_OPTIMIZATION_MYSQL_TEST=1 node src/scripts/tests/platform_audit_view_mysql.integration.js
```

Cubre paginación con precisión de milisegundos, 25/25/2 registros sin duplicados,
lectura v15, fallos de integridad, auditoría durable de la consulta, conciliación
concurrente y HTTP con sesión real en SQL ficticio. El fixture debe aplicar las
migraciones actuales de sesión/dispositivos de confianza antes del recorrido HTTP.

Desde frontend: `node --test scripts/tests/platform_audit_view_contract.test.js`.
La revisión visual usa `scripts/tests/platform_audit_view_chromium_qa.js` con un
build actual en `AUDIT_VIEW_QA_BUILD` y salida en `AUDIT_VIEW_QA_OUTPUT`.
Renderiza el componente Angular real con datos ficticios, bloquea APIs externas
y comprueba escritorio/móvil, vacíos, denegación, detalles, paginación y XSS.
No acredita sesión real ni despliegue público. Registrar la evidencia y SHAs en
99, y la madurez en 19; no duplicarlos en este runbook.
