# Lecturas Meta no WhatsApp desde el vault

Preparado el 19/09/2026. No desplegado ni con cohorte real. El corte posterior
[CRM y comprobación manual](meta-crm-broker.md) añade un consumidor preparado;
este documento conserva el contrato y QA de la base del broker. Contrato canónico en [13-backend](../../src/Documentacion/13-backend.md#broker-de-lecturas-meta-no-whatsapp-preparado-19092026).
La contención no WhatsApp y las pausas clínicas permanecen. WhatsApp conserva
su transporte independiente. No usar credenciales investigadas como QA.

## Frontera preparada

Runtime `services/integrations-broker/src/meta-marketing-main.js`, proveedor
`meta_marketing`, cohorte `meta-marketing-read-v1`. Política por entorno, principal,
clínica, conexión y activo, sin base clínica. Dos principales con claves Ed25519
distintas: `{dev|staging}:meta-marketing` para lectura y
`control:{dev|staging}:meta-marketing` para revocación local. Cada grant de lectura
necesita su grant de control. No se instala al iniciar el broker genérico.

| Operación | Entrada | Resultado/efecto |
|---|---|---|
| `meta.marketing.connection.read.v1` | `{}` y activo autorizado en el envelope | Identidad/token verificados en ese instante, caducidades y scopes requeridos. `assetAccessVerified:false`; no acredita acceso al activo ni readiness CAPI. |
| `meta.marketing.asset.read.v1` | `{}` y activo autorizado | Cuenta Ads: ID/nombre/estado/moneda/zona; página: ID/nombre; Instagram: ID/nombre/username, tras comprobar su página vinculada. |
| `meta.marketing.asset.revoke.v1` | `{}`, mismo ámbito, firma de control | Bloqueo local durable/auditado de clínica/conexión/activo; no revoca el token en Meta ni borra mappings CRM. |

No es discovery: solo lee IDs explícitos de la política. No acepta URLs, host,
fields, cursor, token o cuenta en el payload. No admite grants WhatsApp, mensajes,
campañas, CAPI o leads. La cohorte de lectura acepta solo `ads_read`,
`pages_read_engagement`, `instagram_basic`, `pages_show_list` y `public_profile`;
los scopes de escritura heredados no se convierten en permiso operativo aquí.

Binding y documento del token fijan proveedor/conexión/aplicación/sujeto/scopes,
caducidad y versiones de token/app. Solo la cuenta AWS vigente, eu-west-3, KMS de
secrets y namespace `/clinicaclick/integrations/prod/meta-marketing/{dev|staging}/`.
El prefijo prod identifica la infraestructura existente; rutas y principales
DEV/staging son distintos. Preflight IAM real pendiente, sin permisos creados.

Ambas versiones deben seguir siendo AWSCURRENT antes y después del I/O; un cambio
devuelve conflicto sin usar el reemplazo. No rota, refresca ni escribe Secrets.
Verifica `debug_token` por su propio HTTPS: app/sujeto/tipo/scopes/caducidad y
destinos granulares si Meta los devuelve. No inventa granularidad ausente. La
lectura del activo exige el ID esperado; Instagram también exige la vinculación
desde la página aprobada. No afirma propiedad empresarial. Faltan permisos y
granularidad reales. El nombre opcional de Instagram conserva fallback a username.

La inspección usa `input_token` en la URL HTTPS interna del protocolo existente:
nunca en logs/errores. Las otras lecturas usan bearer y appsecret_proof interno.
No expone proxy Graph. Proyección y comprobación de secretos evitan retornar
token/secreto de app/proof como etiqueta; los demás campos se descartan.

## Recursos, persistencia y recuperación

Graph v24.0, GET fijo, 8 s por llamada, 128 KiB por respuesta, presupuesto broker
25 s; sin retry/redirect. Cuatro lecturas simultáneas y un hueco reservado para
control, 32 conexiones, hasta 60 solicitudes/minuto por principal. No reserva
CPU, disco, sockets ni recursos AWS. Los límites son por proceso, no globales.

Una lectura correcta hace seis llamadas Secrets (cuatro Describe/dos Get) y una
inspección Meta; cuenta/página añaden un GET, Instagram dos. No se cachea autoridad
para ahorrar comprobaciones. Sin recurso creado ni precio/ahorro facturado medido;
medir volumen/coste antes de abrir cohortes. Esta base no añade DDL/job CRM;
el consumidor posterior sí prepara DDL, sin aplicarla fuera de su MySQL temporal.

`persistResult:false`: diario de referencia/digest/estado, sin nombres/respuestas.
Repetir UUID no devuelve salud pasada: `outcome_unknown`; la consulta explícita
nueva necesita UUID nuevo. Revocación y auditoría se confirman juntas; una baja
durante I/O impide liberar la respuesta y persiste al reiniciar. Un token inválido
observado bloquea su conexión; un error genérico no acredita revocación remota.
La baja local de un activo no afecta otros del binding. Auditoría técnica v2.

No retirar `metaQuarantineHttp` ni crear config activa por estas pruebas.
Recuperación actual: conservar releases vigentes. Tras un eventual corte,
bloquear cohorte/activo conservando SQLite/journals/auditoría; nunca restaurar
tokens en CRM, limpiar revocaciones o arrancar una versión legacy.

## QA y aceptación pendiente

Tres suites `test/meta-marketing*.test.js`, 27 casos dirigidos: firma/ámbito,
separación lector/control/entorno, pins/KMS, identidad/scopes/caducidad,
proyecciones, vínculo Instagram, límites HTTP, aborto, auditoría y reinicio.
Runtime HTTPS, firmas y SQLite reales, AWS/Meta ficticios y red exterior cerrada.
Con cuatro lecturas retenidas se rechaza una quinta, entra la revocación por su
hueco y las cuatro respuestas se descartan después de liberar el proveedor.

Regresión completa final con Node 24: 656/656, incluidos los 27 casos Meta;
no se suman otra vez. Un caso distingue rechazo de autenticación de aplicación
durante `debug_token` de revocación del usuario inspeccionado: el primero no
demuestra la segunda y devuelve indisponibilidad sin bloquear duraderamente al
usuario. La suite conserva las comprobaciones de los proveedores anteriores.

El corte inicial de esta base no cambiaba pantallas ni conectaba CRM. Las capturas
del asistente pausado no prueban por sí solas estas operaciones. La preparación posterior del
estado local y Ajustes/selector está descrita en
[lector local](meta-settings-metadata.md); no ejecuta este transporte. Continúan
pendientes el escritor de alta del registro, OAuth, baja coordinada CRM→broker,
discovery y consumidores restantes. El registro, lector manual y auditoría humana
v20 ya están preparados y probados en [el corte posterior](meta-crm-broker.md),
con proveedores ficticios. No se declara completo el bloque sin aceptación real.
Antes de publicar:

1. Completar escritores del registro y grants y baja coordinada desde CRM. El
   lector preparado ya exige permisos de todas las clínicas, rechazo durante I/O
   y auditoría humana v20; falta desplegar y aceptar su recorrido real.
2. Autorizar credenciales nuevas directamente en vault; no usar tokens
   invalidados/investigados ni fallback SQL. Aceptar app review, scopes, tipos,
   granularidad y campos reales con el titular.
3. Adaptar consumidores/UI distinguiendo conexión guardada, disponibilidad y
   acceso al activo; prueba autenticada de Ajustes, mapping y workspace.
4. Preflight de IAM/KMS/red/TLS/renovación/aislamiento, publicación selectiva y
   canary acotado; mantener campañas, CAPI, sync históricos y jobs en pausa.

## Fuentes y evidencia

Campos GET contrastados con el SDK oficial Meta 24.0.0:
[AdAccount](https://github.com/facebook/facebook-python-business-sdk/blob/24.0.0/facebook_business/adobjects/adaccount.py),
[Page](https://github.com/facebook/facebook-python-business-sdk/blob/24.0.0/facebook_business/adobjects/page.py) e
[IGUser](https://github.com/facebook/facebook-python-business-sdk/blob/24.0.0/facebook_business/adobjects/iguser.py).
Identidad/caducidad tienen antecedente en el
[SDK oficial archivado](https://github.com/facebookarchive/php-graph-sdk/blob/5.x/src/Facebook/Authentication/AccessTokenMetadata.php).
La documentación Graph/debug_token devolvió HTTP 429 durante esta revisión;
el SDK y los dobles no sustituyen la aceptación de permisos/granularidad con Meta.

Evidencia privada: `qa-evidence/security-resume-20260917/meta-marketing-broker-20260919/`.
Inventario acotado: `meta-marketing-broker-consumers.json`; estado/corte en 19/99 y
carga/coste en 39. Las fuentes no incluidas no se dan por migradas.
