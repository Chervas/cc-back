# WhatsApp: procedimiento de reconexión controlada

> **Tipo:** runbook.
> **Fuente de verdad:** prechecks, preparación, prueba y rollback del piloto; estado en el manual central 19.
> **Última revisión:** 2026-09-15 (Europe/Madrid).
> **Relacionado con:** [14.1: contrato del canal](https://github.com/Chervas/cc-front/blob/dev/src/Documentacion/14.1-whatsapp-integracion-meta.md), [14.3: coexistencia](https://github.com/Chervas/cc-front/blob/dev/src/Documentacion/14.3-whatsapp-coexistencia.md).

## Destino público y valoración de la separación

Staging es el único consumidor de negocio público; gateway atiende las entradas
externas; DEV conserva sus pausas y queda fuera de credenciales operativas. OPS
no es dependencia. Consultar la [tabla vigente de seguridad](https://github.com/Chervas/cc-front/blob/dev/src/Documentacion/19-estado-actual.md#seguridad-de-acceso-e-integraciones)
antes de ejecutar. Un paso preparado no acredita instalación ni reactivación.

Namespaces y flags de jobs no aíslan credenciales si DEV/público comparten UID,
identidad SQL o claves. Antes de introducir una credencial real deben existir:

- usuarios del sistema y claves de servicio separados, con denegación comprobada
  de lectura y firma desde DEV;
- acceso SQL separado a sesiones, MFA, autorizaciones, bloqueos y auditoría;
  DEV no debe poder fabricar una sesión pública ni quitar sus bloqueos;
- un único consumidor de recepción y uno de salida por cohorte, con guard de
  runtime y permiso de operación/activo revalidado al ejecutar;
- claves de firma, TLS, almacenamiento privado y acceso AWS propios del broker,
  sin proxy genérico, sin exportación de tokens ni fallback a la BD antigua.

La separación de acceso SQL afecta a DEV y a las importaciones compartidas.
Presentar su matriz exacta de grants y ensayo antes del corte; no retirar grants
al usuario compartido sin trasladar sus consumidores. Conservar las pausas.

## Prechecks antes del lote

1. Registrar HEAD/upstream y cambios locales de DEV/staging/gateway/frontend.
   Comparar el hotfix `socialstats.controller.js`, MFA, flags, namespaces y los
   propietarios de cada cola. No imprimir `.env`, PM2 env ni credenciales.
2. Verificar `MetaScopeBlocks` y `WhatsappAuthorizationStates`, índices y registro
   de sus migraciones `20260913140000` y `20260913150000`. Verificar las tablas
   previas de sesiones/MFA/auditoría. No lanzar todas las migraciones pendientes.
3. Inventariar WABA/número/clínica/grupo y primarios mediante metadata. Un activo
   compartido necesita autorización sobre todas sus clínicas; otro número del
   mismo grupo no es un reemplazo implícito. Revisar restricciones históricas sin
   presentarlas como estado actual de Meta. No leer ni probar tokens revocados.
4. Confirmar que no hay alta legacy abierta. POST `/api/whatsapp/webhook` sin firma
   devuelve 401; con forma de firma válida y app placeholder, 503 con
   `Retry-After: 60`. Callbacks Meta antiguos, 503. Las mutaciones
   WhatsApp autenticadas deben bloquearse antes del handler. El montaje del router
   legacy debe dejar pasar `/webhook` al guard de recepción, sin exigir JWT de Meta.
5. Antes de usar AWS, verificar STS y la identidad temporal/instancia esperada.
   `SendCommand` aceptado por la API no acredita ejecución: comprobar el resultado
   de la invocación. Un fallo de acceso anterior al shell no es fallo del instalador.
   Session Manager solo se usa dentro del permiso OS admin ya autorizado.

## Secretos y alta

Usar el [broker de alta](whatsapp-onboarding-broker.md), [gateway con MFA](whatsapp-onboarding-gateway.md)
y [ventana específica](whatsapp-onboarding-ui.md). El titular inicia sesión con
código por correo: una sesión posterior mediante dispositivo recordado no cumple
`requireEmail:true`. No pedir contraseñas, códigos ni secretos por chat.

Fijar App ID, Config ID, redirect URI, clínica/conjunto de clínicas y versiones de
secretos. Revisar en Meta que el consentimiento sea exclusivo de WhatsApp, sin
Ads/páginas/leads/Instagram; no ampliar permisos para superar un error. Valorar el
secreto de aplicación compartido, no solo los botones de la interfaz.

La candidata necesita un slot propio con placeholder AWSCURRENT y permiso de
escritura acotado a su ARN. Un slot no configurado de app no debe contener un
app secret que pase el validador. Si hay nuevos secretos o IAM, presentar JSON,
prechecks, coste y rollback antes de aplicar. `PutSecretValue` no admite una
restricción IAM de VersionStage: AWSPENDING lo fija el código, mientras el slot
sigue separado del secreto operativo. No dar GetSecretValue al operador SSO.

`finish` puede recibir solo WABA en coexistencia. El broker acepta la resolución
solo con un número tras paginar todo el edge, conserva la selección original y
registra la observación del proveedor. Una candidata `staged` siempre mantiene
`connected:false`; no registra, suscribe, sincroniza ni envía. Un canje incierto
se consulta por UUID/versión; no se repite con un código nuevo como recuperación.

## Recepción y reconstrucción de conversaciones

El listener se ejecuta mediante `services/integrations-broker/src/whatsapp-inbox-main.js`
y el consumidor separado mediante `src/scripts/whatsapp-inbox-consumer.js`.
La operación, unidades, certificados y rollback se mantienen en
[31](https://github.com/Chervas/cc-front/blob/dev/src/Documentacion/31-roadmap-arquitectura-entornos-gateway.md#recepción-y-alta-whatsapp-en-el-entorno-público).
Antes de habilitar una app real:

1. Comprobar servicios, versiones y certificados de gateway/receptor/importador.
   El certificado gateway no puede leer `/pending`; el importador no captura.
2. Verificar solo la DDL `20260915040000-create-whatsapp-inbox-imports.js` y sus
   tres tablas; no ejecutar todas las migraciones de DEV contra staging.
3. Probar el UID de DEV con `src/scripts/tests/dev_isolation_runtime_probe.js`
   dentro de su unidad. Debe permitir solo su BD/Redis y rechazar recursos públicos.
4. Comprobar el guard público por CRM/autenticacion/app y ambas variantes de URL.
   Un 200 del router legacy o un 200 sin persistencia impide abrir el piloto.
5. Contrastar App/config/redirect en Meta, configurar el secreto de app nuevo
   por canal privado y fijar su versión en receptor y broker. Mantener las
   candidatas/emisores separados. No copiar secretos al frontend o a `.env`.
6. Abrir únicamente el alta revisada; el titular inicia el flujo desde CRM con
   un código nuevo de correo. `awaiting_activation` es el punto de revisión,
   no un permiso para activar envíos ni suscripciones automáticamente.

Comportamiento que debe conservarse:

- Verificar HMAC sobre los bytes originales y un único encabezado de firma;
  límite 3 MiB, WABA/números explícitos, capacidad y auditoría antes del ACK.
- Conservar el lote completo cifrado en SQLite privado (WAL/FULL). La clave de
  datos se genera con la KMS de payload y su manifiesto cifrado se escribe con
  fsync. El arranque descifra la misma clave; nunca reemplaza una perdida.
- Persistir lote y outbox en una transacción. Los duplicados vuelven a comprobar
  que el contenido cifrado sea legible. Un recibo confirma conservación, no
  actualización de Messages o de citas.
- Autenticar el consumidor staging y su alcance antes de prestar un lote. La
  importación debe deduplicar WAMID/evento/contacto en su transacción y devolver
  recibo durable antes de confirmar el lease. Lease caducado o de otro consumidor
  no confirma. No asociar todo un historial al primer contacto.
- Importar historia, ecos del móvil y cambios de forma pasiva. La recepción no
  autoriza respuestas automáticas, recordatorios ni mutaciones de cita por IA.
- Los ACK 200 del recorrido antiguo pueden corresponder a payloads descartados.
  No hay reconstrucción desde logs sin cuerpos ni reintento garantizado de esos
  eventos. Marcar el hueco y revisar posibles cancelaciones/cambios desde el móvil.

Las condiciones de QR, registro e historial están en el contrato 14.3. No
registrar/desregistrar o repetir onboarding para forzar la descarga. La bandeja
no borra automáticamente payloads; retención, eliminación y backup deben fijarse
antes de introducir datos clínicos, distintos de la retención de auditoría.

## Reanudación controlada de mensajes

### Inspección previa sin efectos

Consultar agregados SQL con transacción READ ONLY y Redis mediante lecturas de
contadores/pausas. No cargar `models/index`, `queue.service` ni instanciar workers
para inspeccionar. `Messages.sent_at` también aparece en errores preflight y no
acredita aceptación Meta. Registros BullMQ borrados no equivalen a destinatarios
sin atender: pueden incluir completados/fallidos. No recuperar automáticamente
los registros eliminados ni las campañas pausadas.

Unir citas a ejecuciones por su `trigger_entity_type`; un flujo de lead sin cita
no es una confirmación perdida. Releer las fechas y estados al elaborar el lote.
La política excepcional de fechas/08:00 y revisión vive únicamente en
[14.1: recuperación](https://github.com/Chervas/cc-front/blob/dev/src/Documentacion/14.1-whatsapp-integracion-meta.md#recuperación-de-mensajes-tras-una-parada).

### Lote de recuperación y piloto

1. Preparar vista previa por clínica/activo, finalidad, idioma/plantilla local
   aprobada, intención original, revisión de cita y motivo de inclusión/exclusión.
   No incluir cuerpos ni destinatarios en evidencia general.
2. Aplicar `whatsappRecoveryPolicy` con entregas históricas y revisión entrante.
   Es una función pura: falta conectarla a la lectura y reserva transaccional y
   al POST final. Sus tests no acreditan la barrera en un worker desplegado.
3. Fijar cantidades, ritmo, expiración y clave estable de idempotencia. Revalidar
   versión/estado/consentimiento y respuestas después de cualquier espera, justo
   antes de entregar al broker. Aceptación o resultado desconocido impiden replay.
4. Con el titular, revisar la autorización del WABA existente y un destino de
   prueba. Primero recepción pasiva, después un envío expresamente autorizado.
   El consentimiento de alta no autoriza envíos ni reanuda los cinco tipos legacy:
   `webhook_whatsapp`, `outbound_whatsapp`, `whatsapp_template_create`,
   `whatsapp_template_sync`, `whatsapp_phone_sync`.
5. Liberar exclusivamente el lote revisado de esa clínica. Campañas, DEV y backlog
   siguen fuera. Si vence la ventana de recordatorio, no enviarlo tarde ni ampliar
   su plazo automáticamente. No prometer entrega a las 08:00 sin un corte aceptado.

## QA

```bash
# Node 24; desde services/integrations-broker, proveedores/AWS ficticios:
node --require ./test/offline-guard.cjs --test --test-concurrency=1 test/*.test.js
# Desde backend; HTTP locales y política pura:
node --test src/scripts/tests/whatsapp_legacy_containment.test.js src/scripts/tests/whatsapp_webhook_containment.test.js src/scripts/tests/whatsapp_recovery_policy.test.js
npm run test:security:whatsapp-resume
# MySQL propio, Node 24, sin sockets de la BD compartida:
CAMPAIGN_OPTIMIZATION_MYSQL_TEST=1 node src/scripts/tests/whatsapp_authorization_state_mysql.integration.js
```

La prueba AWS `whatsapp-inbox-aws-canary.js --synthetic-only prepare|resume <id>`
requiere la EC2 autorizada, Node 24, entorno AWS fijado y datos ficticios. Tiene
coste medido KMS/S3, no es una prueba unitaria ni se lanza desde el runner general.
Conservar archivos parciales tras fallo; no recrear claves ni reintentar sin
revisar su fase. Dos procesos verifican descifrado tras reinicio y entrega de
outbox; no prueban el listener, datos clínicos ni integración con las colas.

## Activación y regreso al servicio

Presentar lista exacta de procesos/puertos/colas, versiones, grants, ventana y
rollback antes del corte operativo. Conservar MFA y auditoría; verificar un único
consumidor y no abrir DEV. La atribución forense del incidente puede continuar en
paralelo; la validación técnica pendiente no se sustituye por esa investigación.

Ante fallo, cerrar salida y altas, conservar recepción durable si ya está validada,
recibos, candidatas, bloqueos e historial. Un POST en vuelo puede haber sido
aceptado: pausar no autoriza repetirlo. No volver al webhook que acepta y descarta,
a tokens de BD ni al OAuth general. Mantener las tablas y no borrar evidencia.
Los commits, resultados y rollbacks concretos se registran en el
[histórico 99](https://github.com/Chervas/cc-front/blob/dev/src/Documentacion/99-bitacora-operativa.md).
