# Selección y activación Meta: broker y consumidor CRM preparado

Preparado sobre backend `3f5d61f5`, 19/09/2026. No desplegado ni aceptado con
proveedor real. Contrato canónico en
[13-backend](../../src/Documentacion/13-backend.md#selección-y-activación-meta-dentro-del-broker-preparado-19092026).
El consumidor SQL/worker y su evento humano v24 están preparados; alcance vigente
en «Consumidor transaccional» y «API/job y selección desde Ajustes» al final. API/UI y
planificación están preparadas; publicación y aceptación real siguen pendientes.
Los metadatos de grupo se describen en el runbook de Ajustes.
El inventario CRM ya incorpora una revisión local orientativa, descrita al final;
no es ese escritor ni una reserva de activos.

## Operación y autoridad

`assetEnrollment=true` exige discovery y añade prepare/activate/status/revoke.
Gateway OAuth y su control conservan identidades separadas; lector de activos y
su control añaden otras dos claves únicas. Todos limitados al entorno/ámbito del
slot. No grants estáticos ni derechos enviados por el llamador: una selección
activa deriva solo las dos lecturas existentes y control de retirada del activo.

Prepare verifica un conjunto de 1–100 activos de un candidato; activate verifica
otra vez la misma identidad y relación Instagram/página. Una selección por flujo,
conjunto inmutable y claims físicos únicos entre ámbitos. Claims del padre son
exclusión de conflictos, no permisos para leer un activo no seleccionado.
El registro y el recibo comparten transacción con la auditoría técnica v2. Comandos
inciertos conservan evidencia; no vuelve a canjearse código ni a escribirse token.

OAuth, selección, claims, comandos y auditoría comparten el único SQLite propietario.
Los guards leen la política vigente del Broker, estado del flujo y bloqueos durante
el I/O. Falta un claim o aparece una baja: no hay datos. El control de un activo
invalida la selección atómica completa, incluidos los restantes; conservar este
efecto al diseñar el consumidor y la confirmación humana. No borrar historial para
reenrolar un activo. Los tombstones anteriores a prepare solo bloquean esa selección.

## Credencial y retención de versión

Se reutiliza el VersionId/digest del candidato y se exige que conserve AWSPENDING
antes/después del uso. AWSCURRENT sigue siendo el slot vacío. No Put, List, Create,
Delete o UpdateSecretVersionStage durante selección/activación/lectura. La inspección
comprueba USER/app/scopes/granular/caducidad; los pins de app/slot/KMS se revalidan.
Una lectura de activo consulta su endpoint fijo, con comprobación del padre para IG.
Estado del token hace dos inspecciones y no acredita acceso al activo concreto.

AWS permite leer por [VersionId](https://docs.aws.amazon.com/secretsmanager/latest/apireference/API_GetSecretValue.html).
Una versión que pierde su última etiqueta puede eliminarse; por eso este nuevo
consumidor exige conservar la etiqueta, además de identidad y digest. Véase
[gestión de etiquetas](https://docs.aws.amazon.com/secretsmanager/latest/apireference/API_UpdateSecretVersionStage.html).
No mover AWSPENDING, activar rotación, limpiar versiones o promover AWSCURRENT
para recuperar un fallo. Comprobar IAM y retención reales antes de publicar.
El contrato anterior de diagnóstico de candidatos por UUID permanece separado.

## Recursos y publicación

Misma unidad/SQLite, dos solicitudes ordinarias y una de control reservada;
una operación ordinaria por selección, 20/minuto/principal, 25 s por operación y
8 s HTTP. El índice
`meta_marketing_revoked_asset` y consultas por lotes evitan escanear todas las bajas
por cada activo; claims y selecciones se consultan por claves. Esto no reserva CPU,
disco, red o SQL ni acredita la carga real del proveedor o del CRM.

El lector preexistente de Meta continúa disponible como componente independiente.
El nuevo recorrido requiere dirigir los clientes de lectura/control al runtime
que posee la selección, con sus identidades y configuración exactas; no hacer
fallback al lector anterior, a tokens SQL o a otra base SQLite. Antes del corte,
verificar e incorporar el historial físico autorizado de todos los consumidores;
el código no puede conocer bajas de otro archivo/servidor no incorporado.

El núcleo necesita el escritor CRM preparado al final: sesión/MFA, permiso de todas
las clínicas, identidad, asignaciones, aliases/primarias/shares, historial independiente
y commit local tras resultado del broker. Una activación solo en broker no confirma
conexión clínica. La UI y la planificación están preparadas en el corte posterior,
todavía sin publicar. No se migra el callback
legacy ni se instala un job por publicar únicamente este núcleo.

No desplegar todo DEV. Seleccionar dependencias, revisar migraciones anteriores,
IAM/slots/grants/TLS, registros y fuente de configuración por entorno. Mantener
compatibilidad del lector AWS antes de escritores/productores humanos. Este corte
usa técnica v2 y no añade versión humana al v23 preparado. Archivo/seis eventos
del canary v19 sin modificar. No tocar MFA, pausas, Vitaldiet o jobs clínicos DEV.

## Diagnóstico y recuperación

- `not_found`: aún no hay selección registrada; no implica permiso para activar.
- `prepared`: selección verificada y reservada, sin lectura concedida.
- `active/accessBlocked=false`: grants locales válidos en ese instante; no es una
  comprobación nueva de Meta ni un commit de asignaciones del CRM.
- `revoked/accessBlocked=true`: conservar tombstone, claims y bajas.
- `outcome_unknown`: consultar status con el mismo enrollmentId. Recuperar recibo
  completado con la UUID original; si no hubo commit, una nueva operación explícita
  puede usar otra UUID sobre esa misma selección. No reenviar código OAuth.
- `secret_version_changed`: verificar pins y etiqueta de la versión aprobada;
  mantener bloqueado. No sustituir credencial ni mover etiquetas automáticamente.

Para cerrar altas nuevas conservando retirada/lectura existente, deshabilitar el
principal gateway OAuth en la configuración validada y publicar selectivamente;
los dos controles permanecen. Para bloquear también lecturas, deshabilitar además
el lector. No quitar el módulo y sus controles mientras existan selecciones a
conciliar. Conservar el SQLite y su recuperación; los cambios de configuración
requieren el procedimiento de reload/reinicio, no basta editar el archivo.
Abortar OAuth deja sin acceso sus selecciones. No bajar esquema ni restaurar un
SQLite antiguo que borre revocaciones. Copias/restauración general al final.

## Pruebas reproducibles

Desde `services/integrations-broker`, Node 24 y red exterior cerrada:

```sh
node --require ./test/offline-guard.cjs --test --test-concurrency=1 test/meta-marketing-enrollment.test.js test/meta-marketing-enrollment-runtime.test.js
node --require ./test/offline-guard.cjs --test --test-concurrency=1 test/*.test.js
```

Regresión y capacidad desde backend:

```sh
CAMPAIGN_OPTIMIZATION_MYSQL_TEST=1 META_OAUTH_CRM_VISUAL=1 META_OAUTH_DISCOVERY_TEST=1 node src/scripts/tests/meta_marketing_oauth_mysql.integration.js
node --test src/scripts/tests/meta_marketing_oauth_http.test.js src/scripts/tests/google_oauth_broker_http.test.js
node --require ./services/integrations-broker/test/offline-guard.cjs --test src/scripts/tests/meta_marketing_enrollment_capacity.test.js
```

SQLite/TLS y cliente de lectura CRM reales; Secrets/Meta/S3 ficticios. La regresión
MySQL/Chromium recorre OAuth/inventario ya existente, no una selección CRM nueva.
Ninguna prueba usa token histórico, abre Facebook o activa campañas/leads/envíos.
Evidencia, conteos finales y commits en 99 y en la carpeta privada
`qa-evidence/security-resume-20260917/meta-enrollment-20260919/`.


## Evidencia local del 19/09/2026

- Suite completa del broker: 734/734. El subconjunto de enrollment tiene 19 casos;
  los 65 casos dirigidos de enrollment/OAuth/discovery/TLS están incluidos en el total.
- Cliente CRM real sobre HTTPS firmado, SQLite y reinicio reales; prueba de selección
  concurrente de dos ámbitos y bloqueo de una relación Instagram/página compartida.
- Capacidad separada: 1/1, con 100 seleccionados y 10.000 bajas ficticias preexistentes.
  Prepare 51 ms, activate 58 ms, una lectura 60 ms; 48 llamadas Secrets y 11 Graph
  simuladas entre las tres operaciones. Una baja nueva bloquea antes de Secrets.
  No extrapolar a AWS/Meta ni a CPU/SQL del servidor CRM bajo carga.
- Muestra de tres activos, seis operaciones: 96 Secrets / 20 Graph. El chequeo extra
  de etiqueta se incluye en estas cifras, sin atribuirle coste facturado inexistente.
- Regresión de routers OAuth/Google: 6/6; MySQL/Chromium y sintaxis finales en99.
  Frontend solo cambia documentación; no se publica ni añade pantalla de selección.

Coste incremental real `null`; no se consultó Cost Explorer ni se crearon recursos.
Estado/push/hashes en `source-final.json` privado y fuentes cambiadas en
`meta-marketing-enrollment-consumers.json`. La medición es ficticia y no acepta
la migración de conexiones reales ni reemplaza las comprobaciones del titular.

## Revisión SQL del inventario antes de asignar — 19/09/2026

`metaMarketingEnrollmentReview.service.js` se ejecuta en la transacción final de
la consulta manual de inventario. La autorización actual precede la revisión y el
evento humano v23 completado precede la respuesta. No devuelve inventario parcial
si falla SQL/auditoría. El DTO `assignmentReview` contiene hora, estado/razones
cerradas de ámbito y activo y `reservationMade=false`; no da permiso para escribir.

Comprueba identidad única de Meta, marcador/app y presencia de credencial mediante
un booleano SQL, sin seleccionar el token. Una identidad legacy compartida exige
migración revisada; no vacía su credencial ni toca WhatsApp. Revisa asignaciones
directas/heredadas, tombstones generales/Meta y miembros completos del grupo.
Aliases numéricos/`act_`, bindings y bajas físicos anteriores son conflictos aunque
estén inactivos o se haya borrado el mapping. Para IG revisa también página y
relación inversa de otro IG, sin devolver IDs ajenos. Las consultas se agrupan y
deduplican en SQL; no recorren todo el historial por cada activo. La lectura física
usa snapshot sin bloqueos de rango: una prueba registra una baja de otra clínica
antes de cerrar la transacción de diagnóstico, y la siguiente observación la ve.

Migración aditiva `20260919070000-meta-marketing-parent-identity-indexes.js`:
índices `cc_meta_marketing_parent`/`cc_meta_revoke_parent` por `parent_page_id`.
Preparar después de las DDL Meta anteriores y antes de publicar el consumidor
con discovery habilitado. Solo ejecutada en MySQL temporal; no hay tablas, flags,
jobs ni protocolo humano nuevos. Lector/escritor AWS v23 sigue siendo requisito.
Publicar API y UI juntas mediante candidato selectivo, sin promover todo DEV.

El diagnóstico no acredita primarias/shares, propiedad clínica ni ausencia de
cambios posteriores como contrato de escritura. El futuro escritor debe repetir
la comprobación completa y reservar identidades con exclusión, antes de confirmar
bindings y resultado remoto. Nunca usar un resultado `clear` como claim durable;
no borrar bajas/aliases para hacer que pase. La UI conserva estado sin conexión,
avisa del conflicto y retira la observación con su inventario al cambiar ámbito,
sesión o caducar; depende del temporizador local, sin nuevas consultas periódicas.

Pruebas desde backend, con Node 24 y red real bloqueada por la fixture:

```sh
CAMPAIGN_OPTIMIZATION_MYSQL_TEST=1 node src/scripts/tests/meta_marketing_enrollment_review_mysql.integration.js
CAMPAIGN_OPTIMIZATION_MYSQL_TEST=1 META_OAUTH_CRM_VISUAL=1 META_OAUTH_DISCOVERY_TEST=1 node src/scripts/tests/meta_marketing_oauth_mysql.integration.js
```

Diez grupos MySQL nuevos, ocho de regresión OAuth, 13 capturas reales Angular
con API/MySQL/TLS/SQLite reales y Meta/Secrets/S3 ficticios. Sin error JS, overflow,
tráfico externo ni mutaciones de negocio; se comprueba WhatsApp intacto. Build
Angular completo válido, sin publicación del preview. Detalles y conteos en99.
500 IG/500 padres ante 10.000 bindings y 10.000 bajas: 13 sentencias/78 ms; tres
activos: 13/21 ms, incluidas las tres sentencias de transacción. EXPLAIN usa rangos
por los índices de activo/padre. Petición manual completa: 67 sentencias/111 ms,
frente a 57 en el corte anterior; la revisión añade diez consultas, sin I/O externo
extra ni trabajo por abrir Ajustes. Pool 0/0. Son muestras, no prueba de carga real.

Coste incremental real `null`, sin refresco Cost Explorer. Inventario de fuentes en
`meta-marketing-assignment-review-consumers.json`; evidencia privada
`qa-evidence/security-resume-20260917/meta-assignment-review-20260919/`.
Rollback de este diagnóstico: volver al par API/UI anterior manteniendo los gates
de proveedor, datos y contención. Los índices pueden permanecer; no bajarlos mientras
el consumidor los usa. Preservar journals/claims/revocaciones y el canary v19 intacto.
No rotación, migración de credenciales, activación de cohortes ni recuperación por
tokens legacy. La conexión real y su aceptación permanecen pendientes.

## Diario CRM y transporte de selección preparados — 19/09/2026

DDL `20260919080000-meta-marketing-enrollment-journal.js` y tres modelos:
`MetaMarketingEnrollmentRequests`, `MetaMarketingEnrollmentClaims` y
`MetaMarketingEnrollmentIdentities`. Solicitud única por flujo, UUIDs estables
por comando, selección/candidato/ámbito inmutables y estados recuperables. Claims
únicos por activo físico y sujeto Meta; IG reserva también su página, sin otorgar
lectura de una página no seleccionada. Son registros de seguridad sin cascada al
borrar mappings. La migración inversa rechaza cualquier tabla poblada.

El contrato valida recibos contra identidad, ámbito, candidato y selección de la
solicitud SQL. El estado remoto `active` no confirma el commit clínico; su
`accessBlocked` también deberá comprobarlo el consumidor. Solo una retirada anterior
a prepare puede devolver un tombstone sin candidato/selección y con acceso bloqueado.
El cliente CRM admite las cuatro operaciones tipadas: prepare/activate con gateway,
status/revoke con control. Conserva UUID, TLS, firma y timeout, sin reenvío automático
tras respuesta perdida. Un cambio de configuración rechaza el cliente ya inicializado.

Prueba estructural desde backend con Node24:

```sh
CAMPAIGN_OPTIMIZATION_MYSQL_TEST=1 node src/scripts/tests/meta_marketing_enrollment_journal_mysql.integration.js
```

MySQL temporal real, cliente CRM configurado, HTTPS/Ed25519, broker y SQLite reales;
Graph/Secrets ficticios. Comprueba DDL ida/vuelta, conflicto/concurrencia, rollback
sin huérfanos, conservación de claims tras retirada, respuestas de otra selección
rechazadas y activación sin respuesta conciliada tras reinicio. El control funciona
sin clave ordinaria; la allowlist y configuración inválida fallan antes de la red.
No usa tablas, claves o proveedores operativos. Evidencia y conteos finales en99.

Este corte estructural precede a la autoridad, escritor y worker descritos después.
El esquema/cliente por sí solo no autoriza una conexión. API/UI preparadas en el
corte posterior de este runbook; sigue sin despliegue operativo.
Publicar mediante candidato selectivo cuando estén unidos y probados
los consumidores y su lector/escritor de auditoría compatible. Preservar el canary
AWSv19 congelado y registrar por separado su eventual publicación.

## Reserva clínica y actividad v24 preparadas — 19/09/2026

`metaMarketingEnrollmentAuthority.service.js` admite selección de IDs tipados,
nunca inventario o identidades aportados por el navegador. Consulta `oauth.assets`
autenticado y después bloquea/revalida flujo, sesión/MFA, ACL de todas las clínicas,
slot/candidato, asignaciones y bloqueos. Reserva sujeto y activos físicos, incluida
página de IG, con las tres tablas del diario. Aliases inactivos, vínculo ajeno o
baja independiente bloquean el alta. Identidad compartida legacy requiere revisión:
no se transforma, vacía su token ni se altera WhatsApp.

Una transacción conserva solicitud, claims y evento humano. Un fallo de auditoría
revierte también una identidad externa nueva. Dos selecciones idénticas simultáneas
convergen en una solicitud/evento; el conjunto no se reemplaza. `assertPending`
revalida la sesión original, ámbito completo, identidad, política y claims. El
worker preparado bloquea la solicitud y posee su lease antes de usarla. Cancelar
OAuth invalida autoridad y encola retirada en el nuevo diario, conservando reservas.
Ningún mapping/grant clínico se crea durante la reserva.

El gate `META_MARKETING_ENROLLMENT_ENABLED` está apagado por defecto; todavía sin
rutas, bootstrap ni planificación del worker preparado. No activarlo por disponer
de esta fuente. Confirmación, escritor y conciliación se detallan a continuación;
la UI de selección se completa en el corte posterior de este runbook; su
publicación y aceptación real siguen pendientes.
Para grupos, conservar una fila canónica por activo/grupo y publicar sus lectores
compatibles preparados; no expandir a una fila por sede ni cambiar primarias implícitas.

El codec v24 tiene fases durables separadas y `result_part` por fase. El visor
muestra pendientes con etiqueta explícita y cantidades/IDs técnicos, sin tokens
ni inventario. La reserva verificada desde SQL atraviesa lector/escritor y S3
ficticio antes de mostrarse en Angular real. Compatibilidad AWS actual **v24**, publicada 19/09 10:15 UTC;
verificarla antes del productor, manteniendo los seis canarios v19
ya entregados y sus guards. No repetirlos ni volver a lector v17.

Prueba de autoridad independiente, desde backend y Node24:

```sh
CAMPAIGN_OPTIMIZATION_MYSQL_TEST=1 META_OAUTH_DISCOVERY_TEST=1 META_OAUTH_CRM_VISUAL=1 META_ENROLLMENT_AUTHORITY_TEST=1 node src/scripts/tests/meta_marketing_oauth_mysql.integration.js
```

El flag selecciona esa suite con BD/runtime nuevos. Ejecutar la regresión OAuth
anterior por separado, sin ese flag: no sumar ambas al mismo slot excediendo sus
seis altas/hora. No limpiar cuotas ni reintentar una mutación rechazada para QA.
Siete grupos autoridad y dos capturas; regresión ocho grupos/trece capturas.
Protocolos94/94, contrato frontend8/8 y build Angular completo. Proveedores
ficticios, sin login público ni aceptación real. Cifras de carga y límites en39;
evidencia `qa-evidence/security-resume-20260917/meta-enrollment-authority-20260919/`.

Recuperación: conservar gates cerrados y releases actuales; este corte está solo
en fuente DEV. No bajar tablas con datos ni borrar claims/identidades/bajas.
Inventario de fuentes `meta-marketing-enrollment-authority-consumers.json`; es un
manifiesto de cambios, no un paquete listo para publicar toda la rama DEV.

## Consumidor transaccional: confirmación y retirada — 19/09/2026

Factoría `metaMarketingEnrollment.service.js` y escritor
`metaMarketingEnrollmentBinding.service.js`. Contrato canónico en13, apartado
«Consumidor Meta: confirmación, asignación y retirada» y «API y pantalla de
selección Meta». API, singleton, job y UI preparados; no instalados en runtimes
operativos. Gates de altas y `META_MARKETING_ENROLLMENT_WORKER_ENABLED` siguen
OFF. Migraciones09/10/11/12 solo ejecutadas en MySQL temporal.

El worker consulta estado antes de mutar y guarda marcas de posible envío. Una
respuesta perdida recupera el recibo tras reinicio sin repetir activate. Si el
estado remoto aún no permite saber qué ocurrió, deja pendiente explícito; la
interfaz ofrece consulta manual y retirada, sin reintento automático ni éxito.
No existe todavía un comando humano para reintentar con otra UUID. Nunca borrar
marcas/claims o modificar UUID para forzar ese recorrido.

Lease120 s, diez solicitudes por invocación y plazo de admisión30 s; no es un
timeout total de la función. `SKIP LOCKED` real, fecha generada de trabajo y rango
por índice excluyen retiradas/futuras. Las operaciones de red quedan fuera de SQL.
Preparado revalida a30 s, incertidumbre a60 s, activo a cinco minutos; backoff hasta
una hora. Job cada minuto preparado; planificación operativa y capacidad bajo
carga real pendientes.

El commit local exige recibo activo sin bloqueo y autoridad original vigente.
Grant, mappings canónicos de grupo/clínica, bindings propietarios y evento humano
se guardan atómicamente. Una referencia primaria/share ajena al ID recién asignado
revierte todo. Un grant nuevo que amplíe WhatsApp compartido se rechaza; sus
credenciales y estado permanecen intactos. Sin selección de primaria implícita.

Un fallo de auditoría local deja el remoto recuperable por estado. Pérdida de
permisos encola retirada. Los nuevos lectores comprueban selección completa,
padres/claims, asignaciones y bajas sin depender de la sesión original después
del commit. El llamador conserva su propia autorización vigente. Un miembro añadido
al grupo, share ajeno o baja de otro activo impide servir el conjunto.

Retirada bloquea solo mappings/bindings propios y conserva el grant genérico
compartido, identidad y claims. Funciona con altas OFF y termina tras logout.
Cancelar OAuth encola la retirada de selección en la misma transacción; terminar
la retirada encola cancelar el candidato OAuth. Su worker completa ese último
control. Auditoría v24 distingue las seis fases, sin guardar inventario ni tokens. El visor
muestra la cancelación OAuth confirmada como «Cancelada» y la excluye del contador
de denegaciones de acceso, conservando el outcome técnico del evento v22.

Publicación futura: DDL Meta04–08 y luego09 propietario,10 marcas,11 índice de
trabajo y12 índice de última selección por ámbito antes
del código; incluso el lector/cancelación OAuth con altas OFF necesitan ese
esquema. Publicar AWS compatible v24 antes del productor. Incluir metadatos de grupo
y API/UI/job de selección preparados; elegir dueño de ejecución sin activar jobs
clínicos DEV. No publicar toda la rama DEV. Las migraciones09/10 rechazan
inversa con propiedad/marcas pobladas. La11 solo se retira después de detener o
sustituir consumidores que consulten su columna; no elimina diario ni histórico.
Mantener guard de propiedad mientras existan bindings nuevos. Preservar lectores,
controles, marcas y bajas al recuperar; no volver a tokens SQL. AWSv19 y sus seis
canarios permanecen intactos; no hay publicación o DDL operativa nueva en este corte.

Pruebas desde backend con Node24:

```sh
CAMPAIGN_OPTIMIZATION_MYSQL_TEST=1 META_OAUTH_DISCOVERY_TEST=1 META_ENROLLMENT_RUNTIME_TEST=1 META_ENROLLMENT_RUNTIME_CASE=query_health META_OAUTH_CRM_VISUAL=1 node src/scripts/tests/meta_marketing_oauth_mysql.integration.js
```

Ejecutar cada caso negativo con un runtime nuevo, sustituyendo `query_health`
por `uncertain`, `permission_race`, `foreign_primary`, `foreign_share` o `wa_grant`.
No compartir la BD/slot de pruebas ni relajar cuotas. Regresiones de autoridad,
diario, lector y OAuth se ejecutan por separado. MySQL8/TLS/SQLite/cliente CRM y
componentes Angular reales; Graph/Secrets/S3 ficticios, sin login público nuevo.
La prueba visual muestra confirmación pendiente, conexión y retirada en Actividad;
la prueba `selection_ui` recorre también selección/confirmación/retirada desde
Cuentas conectadas. Ambas usan proveedores ficticios y no acreditan aceptación real.

Evidencia privada `qa-evidence/security-resume-20260917/meta-enrollment-runtime-20260919/`;
conteos y límites en39/99. Manifiesto nuevo
`meta-marketing-enrollment-runtime-consumers.json`; los manifiestos anteriores
conservan las huellas históricas de sus cortes. Coste incremental real null, sin
cambiar la última recogida etiquetada real. La fase sigue pendiente de aceptación
con proveedor y titular; no activa campañas, leads, envíos ni jobs clínicos DEV.


## API/job y selección desde Ajustes — 19/09/2026

Contrato y endpoints cerrados en13; gate/configuración03 y JobRequests11. El GET
recupera solo la última selección con índice12 y revalida sesión/MFA y permiso
de todo el ámbito. Si una conexión activa pierde coherencia, muestra revisión
sin afirmar acceso, conservando retirada autorizada. No hay llamadas Meta al
abrir/refrescar el estado. Confirmación exige sesión original, digest y altas ON;
retirada exige sesión actual autorizada y funciona con altas OFF. Una sesión nueva
no hereda capacidad de confirmar la preparación anterior.

UI ES/CAT/EN: checkbox para activos sin conflictos, preparación, confirmación y
retirada con revisión de alcance. Solo actualización manual; cambios de sesión o
ámbito descartan estado y callbacks antiguos. Una asignación sin nombre/correo Meta
mantiene visible la tarjeta de activos. Sin nombres inventados ni primaria nueva.

Prueba del recorrido humano preparado:

```sh
CAMPAIGN_OPTIMIZATION_MYSQL_TEST=1 META_OAUTH_DISCOVERY_TEST=1 META_ENROLLMENT_RUNTIME_TEST=1 META_ENROLLMENT_RUNTIME_CASE=selection_ui node src/scripts/tests/meta_marketing_oauth_mysql.integration.js
```

`session_changed` prueba negativa de confirmación con nuevo MFA y retirada posterior.
`query_health` comprueba también el índice12 entre11.000 solicitudes históricas/futuras.
No compartir runtime entre casos ni borrar cuotas/claims. La interfaz usa componentes
producto sin modificar, HTTP y SQL reales aislados, TLS/broker con Graph/Secrets/S3
ficticios. El worker se invoca directamente: no acredita ejecución de cron desplegado.
Prueba del catálogo incluye gate, namespace y delegación al ejecutor; gateway omite.

Para publicar, preparar candidato selectivo desde el inventario
`meta-marketing-enrollment-ui-consumers.json` y dependencias anteriores. Instalar
DDL04–12 antes del productor y comprobar la compatibilidad AWS v24 ya publicada. Mantener controles y lectores compatibles al cerrar altas. No revertir
propiedad/marcas/diarios ni quitar índice12 bajo la API activa; ninguna recuperación
restaura credenciales SQL o reproduce activación incierta. Evidencia privada en
`qa-evidence/security-resume-20260917/meta-enrollment-ui-20260919/`, costes39 y corte99.


Compatibilidad AWS v24 publicada y verificada 19/09 10:15 UTC; evidencia y recuperación
en `audit-reader-view-migration.md`. Los 25 eventos ficticios nuevos cubren v20–v24;
no prueban Meta real ni autorizan abrir cohortes. Conservar lector v24 desde la
primera entrega, además de los originales/guards v19. No repetir ninguno de los
canarios. API/UI/DDL/job clínicos siguen sin publicación ni activación en este corte.


## Candidata del servicio y preflight real — 19/09/2026, 10:35 UTC

Paquete `meta-oauth-3135db10.tar.gz`, SHA256
`9b74a9abbbbf98acd7cd872fd6c91a7aa5302182cab4fcb14d81fcad17b66ab6`:
65 archivos, 104.736 bytes comprimidos; 63 fuentes transitivas más package/lock.
No contiene configuración privada, credenciales, node_modules o fixtures.
La lista exacta está en [manifiesto](meta-marketing-runtime-candidate.json).
Es una candidata del broker, no una release clínica completa ni un servicio publicado.

La dependencia compartida de `google-main` incorpora 26 módulos Google. No
eliminarlos del paquete sin revisar el arranque; su inclusión no monta servicios
Google. La unidad debe invocar `src/meta-marketing-oauth-main.js` explícitamente,
no el `start` genérico del paquete. Instalar dependencias desde el lock en el
runtime de destino. La copia local lo hizo con `npm ci --offline --ignore-scripts`:
42 paquetes y 78/78 tests focales con red exterior bloqueada, incluyendo TLS,
firmas, SQLite, reinicio, retirada e incertidumbre. El proveedor sigue siendo
ficticio. Arranque sin `NODE_PATH`: 150 módulos, todos dentro de la candidata.

Preflight real de solo lectura: no existe unidad Meta ni secretos en
`/clinicaclick/integrations/prod/meta-marketing/`. La simulación IAM del rol actual
permite Describe/Get para un ARN ficticio; List/Put devuelve `implicitDeny` con
contexto ausente. Se revisaron también los siete documentos inline: las escrituras
existentes son para namespaces IA/WhatsApp. Esto no sustituye la prueba de permisos
sobre los slots reales. El permiso de lectura del rol EC2 abarca el prefijo prod;
las comprobaciones del proceso no equivalen a una identidad IAM por proveedor.

Antes de publicar faltan app/slots y ámbito autorizado por entorno, principales,
permisos exactos/KMS, TLS con renovación, aislamiento del usuario y límites de
recursos. Incorporar el historial físico previo; no inventar una configuración
activa ni copiar credenciales investigadas para obtener un smoke positivo. Después,
publicación selectiva de API/UI/DDL04–12 y propietario de conciliación, conservando
los workers clínicos DEV apagados. Aceptar MFA público/proveedor con el titular
antes de abrir cohortes. La auditoría v24 ya publicada conserva sus canarios.

Evidencia privada `qa-evidence/security-resume-20260917/meta-runtime-preparation-20260919/`:
archivo, manifiesto, instalación, tests, comprobación de módulos, inventario SSM,
metadata de Secrets, políticas y simulación IAM. No hubo publicación, cambio IAM,
secretos, DDL, gates o nuevo recurso AWS. Recursos/costes en39, estado19 y corte99.


## Instalación inicial sin cohortes — preparada el 19/09/2026

`standby: true` es explícito y solo admite `principals`, `connections` y `grants`
vacíos. Permite instalar los propietarios DEV/staging y comprobar transporte y
recursos antes de preparar un slot. No crea una autorización ficticia. El resto
de la configuración mantiene su esquema estricto. Sin ese modo siguen siendo
obligatorios los slots y las identidades separadas del contrato.

Antes de obtener identidad AWS, revisa todas las tablas del SQLite propietario:
cualquier fila impide el arranque vacío. Conexiones, bajas, comandos inciertos,
selecciones y auditoría no se borran ni se ocultan. Todas las operaciones entrantes
fallan en autenticación mientras no haya principales. Configuración completa y
reinicio revisado son necesarios para pasar al modo normal; tras comenzar OAuth
ya no se acepta volver al modo vacío. Cerrar altas en una instalación utilizada
requiere conservar su configuración y los principales de control.

81/81 pruebas Meta, incluidos tres casos de instalación: TLS/SQLite y reinicio
reales locales, rechazo de solicitudes firmadas, ausencia de llamadas al proveedor,
transición explícita al modo normal y rechazo posterior sin perder historia.
Proveedor ficticio y red exterior bloqueada. No acredita una cohorte real.

Puertos con identidades de certificado cerradas: DEV `8453`, staging
`8454`. Preparar monitor, publicador y firmante compatibles antes de enrolarlas;
serían doce servicios HTTPS en la misma EC2 de seguridad, cada uno con su
certificado, más el certificado del cliente de mantenimiento. No son doce
instancias EC2. El modo vacío no sustituye
esa renovación ni la prueba de aislamiento. No tocar la CA ni claves existentes.
La instalación se acredita por el acta siguiente, separada de la aceptación clínica.

### Instalación inicial publicada — 19/09/2026

DEV y staging ejecutan `release-0627ae37` en la misma EC2, con las unidades
`clinicaclick-meta-marketing@dev.service` y `@staging.service` habilitadas para
arranque. Usuarios propios, `standby: true`, ninguna identidad de cliente, ningún
slot ni grant. El archivo candidato y sus 65 fuentes coinciden con el manifiesto;
42 dependencias instaladas desde su lock, sin scripts de paquetes. La primera
preparación se detuvo antes de crear usuarios o arrancar por cargar `/dev/null`
dos veces como configuración npm; se diagnosticó el resultado terminal y se
continuó con dos archivos de configuración vacíos distintos. No se repitieron
servicios ni operaciones de negocio.

Las claves TLS se generaron en AWS y no salieron de allí. Solo los CSR públicos
viajaron al firmante existente; su CA privada permaneció en el host de aplicación.
Ingreso 8453/8454 limitado a `51.44.225.192/32`; reglas anteriores conservadas.
Cuatro peticiones firmadas con una clave ficticia desconocida, usando ambos
audiences, devuelven `invalid_signature` por TLS real. Los dos estados conservan
veinte tablas sin filas. No equivale a probar roles clínicos configurados.

Desde el espacio de montajes y el UID efectivo de cada unidad: puede leer su
configuración/clave y escribir su estado; no puede modificar esa configuración
ni leer configuración, clave o SQLite del otro entorno. Los límites de memoria,
CPU/tareas y el consumo real están en `meta-standby-deployment.json`. No se afirma
aislamiento IAM por proveedor: los dos procesos usan el rol EC2 existente.

Publicador y firmante incorporan ambos certificados conservando sus diez destinos
previos. Dos renovaciones reales, mismas claves/PID, trece certificados sanos y
cero alertas en lectores DEV/CRM. No se configuraron credenciales Meta ni se
publicaron consumidores clínicos/DDL o autorizaciones de una clínica. La medición
vacía no acredita capacidad bajo tráfico de proveedor.

Recuperación de esta instalación todavía vacía: comprobar ausencia de autoridad
y filas, detener/inhabilitar únicamente la unidad afectada, y retirar solo su
destino de los dos registros de certificados y su regla de ingreso. Conservar
claves y SQLite para inspección. Si existe historia o autoridad clínica, seguir
la conciliación y retirada de permisos del contrato; no vaciar la base ni intentar
volver a `standby`. No bajar validadores/monitores anteriores al soporte Meta
mientras queden destinos Meta enrolados.

Acta versionada: `meta-standby-deployment.json`. Evidencia privada:
`qa-evidence/security-resume-20260917/meta-transport-publication-20260919/`.


Candidata clínica selectiva preparada y probada el19/09, sin publicación ni DDL:
[fuentes, QA y requisitos de corte](meta-clinical-candidate.md). Los inventarios
anteriores conservan su corte histórico; no sustituyen la candidata actual.
