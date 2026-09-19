# Comprobación manual Meta desde CRM

Preparada el 19/09/2026 en los mismos worktrees DEV. Sin despliegue, cohorte real,
escrituras en bases de clientes ni uso de credenciales Meta reales. Contrato
canónico primero en [13-backend](../../src/Documentacion/13-backend.md#comprobación-manual-meta-desde-crm-y-registro-v20-preparado-19092026)
y espejo idéntico en front. La migración completa continúa pendiente.

## Qué cambia

La apertura de Ajustes conserva sus lecturas locales de conexión/asignaciones.
Un activo con binding activo del ámbito exacto puede ofrecer «Comprobar acceso»
si ambos gates están abiertos. El clic usa el endpoint
`GET /oauth/meta/mappings/:mappingId/verification`; no permite indicar app,
conexión, credencial, URL Graph o activo alternativo. El éxito mantiene
`connected:false` y `availability.available:false`: Meta Ads sigue pausado.

La nueva tabla `MetaMarketingBrokerBindings` contiene identidad, ámbito y estado,
sin FK de borrado en cascada, credenciales ni ARN. Distingue staged/active/blocked.
La migración añade el marcador de credenciales externas y app a MetaConnections;
el CHECK exige token NULL para vault y presente para legacy. No altera el contenido
de una conexión anterior, copia tokens o crea grants. El consumidor exige además
ausencia SQL de tokens de página/WhatsApp y de additionalData; solo lee booleanos.

El registro debe coincidir en todos los alias activos del mismo recurso, incluidos
IDs Ads con/sin `act_`. Comprueba grupo completo, shares, referencias primarias,
asignaciones y bloques. Un alias bloqueado sigue bloqueando después de borrarse su
mapping. La clínica pivote no sustituye permisos del grupo. Contextos opacos y
revalidación SQL antes/después de I/O y antes de responder; sin fallback legacy.
La autorización no queda cacheada. No hay transacción abierta durante el proveedor.

El cliente HTTPS usa firma de lectura y CA privadas; no tiene clave de control.
Solo admite dos lecturas tipadas y proyección cerrada. El endpoint humano usa la
lectura de activo, no el estado de token como prueba de acceso a ese activo.
Las siete variables nuevas, ambos gates cerrados por defecto y requisitos de
archivos están en 03. No se han añadido variables a .env ni unidades de runtime.

## Auditoría y pantalla

Intención SQL durable antes de la llamada y resultado durable antes de devolver
éxito. Si falla el outbox, devuelve 503 sin datos; no consulta al proveedor si no
puede registrar el intento. Comprobación de salud: pendientes <10.000 y antigüedad
<3.600 s. Después de registrar éxito vuelve a comprobar sesión/permisos/contexto.
El éxito guardado acredita la prueba remota en ese momento, no que una respuesta
posterior haya llegado al navegador ni que Meta Ads esté activo.

Evento v20 `integration.meta.access_check`: actor/sesión, scope, mapping, activo,
conexión, número/hash de clínicas y hash del resultado. Sin etiquetas, token,
payload clínico o respuesta íntegra. El UUID generado en servidor correlaciona
los dos eventos humanos SQL con los dos eventos técnicos v2 del broker en SQLite.
La entrega humana conserva escritor/lector S3 existentes y el panel de Actividad,
exclusivo de administradores técnicos, con comprobación de versión/hash/KMS.

Angular descarta resultados tras cambiar clínica/sesión; 401/403 refresca el estado
y retira los datos inaccesibles. Sin llamadas de verificación al abrir, retry,
OAuth, actualización de mappings o activación de campañas/CAPI/leads. Activos sin
nombre muestran su ID. El resultado de acceso es temporal en esa pantalla.

## QA reproducible y alcance

Node 24 desde back-dev:

```sh
CAMPAIGN_OPTIMIZATION_MYSQL_TEST=1 META_ACCESS_E2E_TEST=1 META_ACCESS_E2E_VISUAL=1 node src/scripts/tests/meta_marketing_broker_mysql.integration.js
CAMPAIGN_OPTIMIZATION_MYSQL_TEST=1 META_METADATA_VISUAL=1 node src/scripts/tests/meta_connection_metadata_mysql.integration.js
```

MySQL 8.0.42 propio, DDL up/down/up y rechazo de down poblado, sesión/ACL reales,
handlers y repositorios del producto, HTTPS/Ed25519/SQLite reales. Meta/Secrets/S3
son dobles, con respuestas adversas y red externa cerrada. No monta todo el router
OAuth ni realiza login público/MFA. Las APIs ajenas al recorrido son fixtures.

Diez grupos de integración correctos: identidad/alias/full-group, residuos SQL,
shares y primarias ajenas, gates/staged, contexto falso, revocación de sesión,
permisos, assignment o bloque durante I/O, respuesta contaminada, fallos de
auditoría, baja durante consulta y persistencia tras reiniciar. La baja en curso
puede devolver `connection_blocked` por aborto; tras reinicio ese activo devuelve
`asset_revoked` y otro activo continúa accesible. No implica baja de todo el token.

Cuatro capturas Angular inspeccionadas: escritorio/móvil con comprobación por clic,
retirada tras perder permisos y panel v20 con detalle abierto. Tres verificaciones
desde navegador, cero automáticas, errores JS, escrituras de negocio o red ajena.
Dos eventos SQL v20 y dos técnicos SQLite comparten UUID. La entrega humana usa
escritor/drain/lector reales sobre S3 ficticio con versiones y recibos; no es AWS.

Regresión local de metadatos: nueve grupos y cinco capturas generadas por los
mismos componentes; cambio A→B→A y selector pausado correctos. Pruebas separadas:
85/85 de auditoría, 27/27 del broker Meta y 10/10 de contención/HTTP/rate-limit.
Build Angular development correcto, con advertencia CommonJS preexistente de
socket.io-parser/debug; no publica assets. Sintaxis de 23 JS y diff correctos.
No se afirma paridad i18n global: persisten incidencias previas fuera de este corte.

Ejecución final integrada: cuatro lecturas base 148 sentencias/293 ms; clic humano
64/246 ms. Total de escenarios: 18 comandos, 100 llamadas Secrets y 34 Meta
ficticias, 1.140 sentencias, cero selección de valores secretos y pool final 0/0.
Regresión de apertura local: 29/88 ms; ocho repeticiones 232 sentencias, 29–52 ms.
Latencia de un ensayo aislado, no benchmark de CRM, Meta o AWS. SQL lento no queda
cancelado por el presupuesto HTTP. Coste incremental facturado `null`, sin consulta
Cost Explorer nueva; no imputar el total de cuenta al broker. Detalle de recursos
y coste en 39. Evidencia privada: `qa-evidence/security-resume-20260917/meta-crm-broker-20260919/`.

## Publicación, recuperación y siguiente paso

1. Completar escritor de alta/OAuth nuevo directamente a vault y grants por ámbito;
   no reutilizar credenciales investigadas ni copiar tokens al CRM. La baja
   coordinada con productor/worker ya se prepara en
   [el corte posterior](meta-marketing-revocation.md); publicación y aceptación real
   siguen pendientes. Ese corte añade historial independiente e índices al lector.
2. Preflight selectivo de modelos, DDL y consumidores. La DDL MySQL no es una sola
   transacción reversible: comprobar tabla/columnas/CHECK/índices y SequelizeMeta
   después de cada paso; si queda parcial, no arrancar el modelo ni repetir a ciegas.
   La fuente nueva del modelo requiere DDL previa incluso con el gate cerrado.
3. Publicar soporte v20 de auditoría con un candidato propio, lector antes que
   escritor y antes del gate humano. No reconstruir/sustituir el archivo ni los seis
   eventos del canary v19 congelado: pertenecen a otro corte y revisión AWS.
4. Completar IAM/grants/TLS/renovación, aceptación Meta por el titular, MFA público,
   recorrido real y medición de carga antes de abrir ambos gates. No promover todo
   DEV. Campañas, CAPI, históricos y jobs clínicos DEV permanecen cerrados.

Ante regresión, cerrar gates y conservar registro independiente, bloqueos, marcador
externo, SQLite y auditoría. No restaurar tokens ni hacer down si hay registros
o conexiones vault; la migración lo rechaza. Una comprobación explícita nueva usa
UUID nuevo, sin reproducir el anterior. Backups/restauración siguen al final.

Inventario de fuentes y hashes en `meta-crm-broker-consumers.json`. Contratos en
13/20.17, variables en 03, madurez en 19, prioridades en 16 y corte/recuperación en 99.
