# Lector, visor y conciliación de auditoría

12/09/2026. Séptimo bloque implementado y probado con datos ficticios. **Sin
desplegar, activar, consultar AWS ni migrar la BD compartida.** La entrega AWS
sigue siendo reportada. Complementa el runbook general, las sesiones
persistentes y el README de `services/platform-audit`.

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
El alcance es `app/platform/v1`, `v2` y `v3`; no incluye el contrato `app/v1`
del broker, eventos aún pendientes de entrega ni acciones no instrumentadas.
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
La topología/identidad del lector aún no está asignada; este bloque no crea
otra instancia ni concede al backend permiso de asumir el reader.

## API y consultas

`GET /api/system-monitoring/audit/events`, detrás del verificador común JWT.
Habilitado exige administrador técnico global (IDs 1 o 44 del helper actual)
y sesión persistente vigente. Ser propietario/admin de una clínica no concede
esta lectura global. Actor y sesión proceden del middleware; el cliente no
elige la identidad que autoriza la consulta.

| Parámetro | Contrato |
|---|---|
| `from`, `to` | Fechas UTC inclusivas YYYY-MM-DD, máximo 31 días |
| `action` | Opcional: auth.sign_in, auth.token_sign_in, auth.unlock, session.issued/renewed/revoked/expired, audit.records.read |
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
minutos Europe/Madrid, gate propio apagado. Hasta 25 filas `reconcile`, con
claims SKIP LOCKED y leases existentes de 120 s; ventana de adquisición 10 s.
Verifica recibos y confirma con CAS de lease/digest. Conflictos y fallos
conservan el evento pendiente y backoff de outbox; el job declara `failed`
si alguna fila falla, sin retry genérico. No borra eventos ni reescribe S3.
Varios workers no concilian la misma fila a la vez. Esto resuelve el ACK
perdido del writer cuando la versión externa coincide; no certifica histórico
de versiones ni recupera objetos eliminados.

Migración nueva única: `20260912230000-index-platform-audit-view.js`, añade
índice en PlatformAuditEvents. Probada solo en MySQL propio ficticio. `down`
retira el índice y conserva tabla, eventos, recibos y sesiones. Dependencias:
outbox `20260912210000`, monitor `20260912213000`, sesiones `20260912220000`.
Ninguna se ha aplicado aquí a la BD compartida. No ejecutar todas las pendientes.

## Configuración preparada, sin valores reales

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
No se han generado ni movido claves reales, cambiado .env o PM2.

Servicio lector: `node services/platform-audit/src/reader-main.js <config>`
con Node 24 y dependencias de su package-lock. JSON privado con
`readerSourceRoleArn`, `writerSourceRoleArn`, `port` (1024–65535),
`listenAddress` (default 127.0.0.1), `stateFile`, `tlsKeyFile`, `tlsCertFile`,
`principals:[{keyId,enabled,modes:[confirmed|reconcile],publicKey}]`.
Son nombres de campos, no un archivo listo para desplegar. La configuración
debe recoger ARNs, origen TLS y rutas realmente asignados; no inventarlos.

## Diferencias AWS y lote pendiente de aprobación

| Comprobación | Estado y acción necesaria |
|---|---|
| SSO | Sin asignación temporal. Operador/usuario debe habilitar lectura mínima; después verificar identidad y metadata, sin credenciales alternativas |
| Trust reader | Plantilla recibida confía en SSO de aprovisionamiento, no en el servicio; definir origen aislado y permiso/trust concretos |
| S3 | Plantilla concede GetObject y GetObjectVersion para app/*; verificar política efectiva, bucket/KMS y versiones con prueba ficticia autorizada |
| KMS | Plantilla reader contiene Decrypt/DescribeKey, sin GenerateDataKey; la referencia oficial de GetObject exige además GenerateDataKey para SSE-KMS. Revisar IAM y key policy antes del corte; no concedido por este código |
| Hosting/red | Instancia entregada sin ingress ni canal de instalación aprobado. Aislamiento reader/writer y HTTPS deben resolverse dentro del presupuesto o aprobar su coste adicional |
| Protección | Object Lock apagado, rotación KMS apagada, eventos de datos S3 ausentes reportados; DPD/operador deben resolver cada cambio por separado |

La exigencia descrita de permisos S3/versiones y KMS procede de la
[referencia oficial GetObject](https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObject.html),
consultada el 12/09/2026; no es una prueba de permisos efectivos. Si se aprueba
ajustarlos, limitar a clave/prefijo/contexto/vía S3 necesarios y verificar que
reader no recibe Put/Delete/retención ni writer lectura. Revisar esta misma
diferencia en la conciliación preparada en fases anteriores. No modificar el
original recibido ni usar el writer como atajo para conceder lectura.

El lote de activación debe enumerar identidad origen y target, grants por
runtime, instalación/TLS/red, migración exacta e impacto de índice, respaldo
outbox/sesiones/journal, ventana y responsable. Desplegar primero codec/writer
v3 y lector, validar con eventos ficticios y sin proveedores; después API/job
y front, con gates cerrados hasta aceptar permisos/retención/cobertura. Coordinar
el modo de sesiones en todos los runtimes y conservar las pausas efectivas.

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

Paquete completo con guard de red; TLS real propio y SDK dobles; firmas, claves
separadas, roles/orden STS, versiones/digests/KMS incorrectos, nonce tras reinicio,
cuotas, cursores y contrato v3. MySQL 8.0.42 propio por UNIX, sin TCP ni BD real:
páginas 25/25/2, snapshot, filtros, denegaciones, fallos de auditoría, reconciliadores
concurrentes, HTTP con sesión persistente y rollback/reaplicación del índice.
Frontend: contratos de navegación/errores y ocho capturas Chromium ficticias
de escritorio/móvil; build de desarrollo separado, sin publicar ese build.

Evidencia saneada privada en
`/home/ubuntu/qa-evidence/security-migration-20260912/audit-view-offline-qa.json`;
el acta `audit-view-publication.json` registra SHAs realmente comprobados tras
push. No son evidencia AWS. Base sincronizada de este bloque: backend
`6fd6751732ca7d8b4b837fc111db99584756cf44`, front
`cd763cf35fd37a2894d4f80ddf596af6b988d159`. Revisar rango completo a origin/dev,
stage explícito y push fast-forward solo propio. Push no equivale a despliegue.
