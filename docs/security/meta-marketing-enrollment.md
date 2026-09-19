# Selección y activación Meta: núcleo del broker

Preparado sobre backend `3f5d61f5`, 19/09/2026. No desplegado ni aceptado con
proveedor real. Contrato canónico en
[13-backend](../../src/Documentacion/13-backend.md#selección-y-activación-meta-dentro-del-broker-preparado-19092026).
Este núcleo todavía necesita completar el consumidor SQL/API/UI de selección de CRM.
La reserva clínica y su evento humano v24 están preparados; alcance vigente al final.
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

Falta el escritor CRM: sesión/MFA, permiso de todas las clínicas, identidad,
asignaciones, aliases/primarias/shares, historial independiente y commit local tras
resultado del broker. Una activación solo en broker no permite afirmar conexión
clínica completada. El consumidor nuevo añadirá auditoría humana y UI antes de
aceptar la fase. No se añade un job ni DDL MySQL aquí, ni se migra el callback legacy.

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

Faltan el servicio de autoridad clínica, comprobación completa de aliases/primarias/
shares, escritor de bindings/asignaciones, lease/worker, auditoría humana y UI.
No hay routes/gates nuevos ni despliegue; este esquema/cliente por sí solo no autoriza
una conexión. Publicar mediante candidato selectivo cuando estén unidos y probados
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
revalida la sesión original, ámbito completo, identidad, política y claims. El futuro
worker debe bloquear la solicitud y poseer su lease antes de usarla. Cancelar OAuth
invalida la autoridad y conserva reservas; falta encolar/conciliar esa retirada en
el nuevo diario. Ningún mapping/grant clínico se crea en esta fase.

El gate `META_MARKETING_ENROLLMENT_ENABLED` está apagado por defecto; todavía sin
rutas, bootstrap o worker del consumidor. No activarlo ni aplicar DDL operativa.
Faltan confirmación humana, escritor final atómico (también primarias/shares),
conciliación tras ACK perdido/commit fallido, retirada independiente y UI completa.
Para grupos, conservar una fila canónica por activo/grupo y adaptar sus lectores
antes de publicar; no expandir a una fila por sede ni cambiar primarias implícitas.

El codec v24 tiene fases durables separadas y `result_part` por fase. El visor
muestra pendientes con etiqueta explícita y cantidades/IDs técnicos, sin tokens
ni inventario. La reserva verificada desde SQL atraviesa lector/escritor y S3
ficticio antes de mostrarse en Angular real. Compatibilidad AWS actual **v19**;
publicar v24 compatible antes del productor, manteniendo los seis canarios v19
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
