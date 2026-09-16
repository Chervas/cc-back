# Alta WhatsApp: registro del broker y credencial candidata

> **Tipo:** procedimiento técnico del alta privada.
> **Fuente de verdad:** configuración, estados y recuperación del broker; instalación en el manual central 19/99.
> **Última revisión:** 2026-09-15 (Europe/Madrid).

El [puente gateway/MFA](whatsapp-onboarding-gateway.md) y la
[interfaz](whatsapp-onboarding-ui.md) están implementados con proveedores
ficticios en QA. `staged` significa candidata guardada: `connected` es siempre
`false`. No existe operación de activación en esta cohorte. Consultar instalación,
DDL y límites reales en [19](https://github.com/Chervas/cc-front/blob/dev/src/Documentacion/19-estado-actual.md#seguridad-de-acceso-e-integraciones).

## Contrato y separación

`src/whatsapp-onboarding-main.js`, cohorte `whatsapp-onboarding-v1`, registra
operaciones firmadas en el servidor TLS privado `/v1/execute`. Mantiene firma
Ed25519, audiencia, nonce, autorización por tenant/conexión/activo y límites del
broker. Configuración privada exacta; dos principales con claves distintas:

| Principal | Operaciones permitidas |
| --- | --- |
| `gateway:whatsapp-onboarding` | `meta.whatsapp.onboarding.begin.v1`, `finish.v1`, `status.v1`, `abort.v1`, con el mismo prefijo |
| `control:whatsapp-onboarding` | `status.v1`, `abort.v1`, `meta.whatsapp.onboarding.scope.revoke.v1` |

La configuración fija App ID, Config ID, URI HTTPS, versiones de app secret y
slot, scope `clinic:<id>` o `group:<id>` y lista ordenada de clínicas. El grant
usa `assetRef=wa-enroll:<scope>` y como tenant la primera clínica de esa lista.
Esa convención no concede acceso a otras clínicas: el gateway deberá acreditar
el conjunto completo mediante el [estado con MFA](whatsapp-authorization-state.md).
No se confía en un actor, URI, ARN o configuración enviados por el navegador.

El alta no exige `MetaConnection` previa. La nueva identidad se obtiene del
diagnóstico autenticado del proveedor y se contrasta con App ID, tipo, permisos,
WABA y caducidad. El número debe aparecer en el edge fijo del WABA, con paginación
acotada. Solo se aceptan `whatsapp_business_management` y
`whatsapp_business_messaging`, más `public_profile` si está configurado.
El modo de selección descrito abajo permite además el permiso de eventos
observado en el ajuste existente, sin exponer operaciones de eventos.
Ads, leads, páginas, Instagram y `business_management` se rechazan.

### Autorización por negocio de Meta

El binding opcional `customer: {businessId, wabaIds}` permite dar de alta un
negocio con varias cuentas WhatsApp. Los IDs proceden de configuración privada
revisada: `wabaIds` ordenados, únicos y como máximo 64. Un ámbito de clínica
individual solo admite una cuenta; para varias se exige un ámbito de grupo con
el conjunto completo de clínicas autorizado mediante MFA. Sin `customer` sigue
vigente la comprobación de un único WABA, con el mismo fingerprint anterior.

El número elegido debe pertenecer a una cuenta de esa lista antes de canjear
el código. Después se exige un SYSTEM_USER de la aplicación, los permisos
exactos y el WABA seleccionado en ambos permisos WhatsApp. Cada destino
granular debe estar en la lista aprobada. Se consulta cada cuenta concedida,
también las no seleccionadas, mediante GET de `id,owner_business_info`; todos
los propietarios deben coincidir con `businessId`. No se admite una relación
`on_behalf_of` como prueba de propiedad ni se enumeran portfolios.

La candidata conserva internamente `businessId` y `grantedWabaIds`, dentro del
envelope protegido por versión/hash. Todas las cuentas concedidas se reservan
en la misma transacción; un conflicto sobre cualquiera revierte el conjunto
y evita el Put. La conciliación comprueba esas reservas completas. Un cambio
de negocio, cuentas permitidas o clínicas invalida el intento anterior.
La API pública sigue mostrando solo el número seleccionado, no el inventario
completo del negocio ni la credencial. El alta no asigna un número primario.

### Selección de un número conservando el ajuste existente

`customer: {selectionOnly: true}` distingue la credencial del negocio de la
asignación clínica. Permite seleccionar el número autorizado desde Meta sin
fijar Sants ni cambiar el Config ID. Puede usarse en ámbitos de clínica o grupo;
solo reserva el teléfono seleccionado. Dos clínicas pueden asignar teléfonos
distintos del mismo WABA, pero no apropiarse del mismo teléfono ni ignorar una
reserva exclusiva creada por el modo anterior. No asigna otros números ni
primarios y no habilita envíos.

El propietario se obtiene del WABA seleccionado mediante una lectura autenticada,
no del nombre del portfolio ni del evento del navegador. Después se comprueban
todos los destinos granulares (máximo 64): deben ser WABAs del mismo propietario.
Los pins `businessId`/`wabaIds` siguen siendo opcionales y vinculantes si se
configuran. No se admiten destinos desconocidos, otros negocios o inventario
sin comprobar. La candidata conserva la evidencia de todo el grant.

Solo este modo puede declarar explícitamente `whatsapp_business_manage_events`
además de los dos permisos WhatsApp y `public_profile`. El conjunto devuelto
por Meta debe coincidir exactamente con el configurado. El permiso de eventos
no crea ninguna operación HTTP nueva de eventos/publicidad; sus destinos también
se verifican. Plantillas ordinarias siguen usando `whatsapp_business_management`.
Los modos anteriores y el motor de envío mantienen sus restricciones originales.

Cada ámbito necesita su binding y slot de Secrets Manager autorizados; este modo
no convierte un slot de clínica en un almacén compartido para todos los clientes.
Conservar el ajuste Meta existente. Fuentes:
[business tokens](https://developers.facebook.com/documentation/business-messaging/whatsapp/access-tokens/),
[propiedad WABA](https://www.postman.com/meta/whatsapp-business-platform/request/nem6vuw/waba-id),
[productos del alta](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/version-4/).

Antes del corte: instalar código compatible conservando los bindings existentes,
aprovisionar el slot del ámbito completo, fijar el Config ID validado y las mismas
listas en gateway/broker, y comprobar permisos y membresías. No convertir un
slot de clínica en uno de grupo modificando solo su nombre: el placeholder,
la política y los hashes fijan el ámbito. El inventario histórico ayuda a
preparar la lista, pero la propiedad se prueba de nuevo en Meta durante el alta.

Rollback: cerrar nuevas altas del negocio y conservar versiones, SQLite y
auditoría; no restaurar una BD anterior ni eliminar reservas. Si se vuelve al
binario anterior, restaurar también su configuración sin bindings `customer`;
esos intentos quedan fuera de servicio hasta recuperar código compatible.
Este cambio de contrato no acredita instalación ni uso operativo: ver 19/99.

Para la finalización de coexistencia que solo identifica WABA, el número puede
ser null en la solicitud. Se resuelve únicamente si el edge completo contiene un
número; con varios se rechaza. La selección original y la observación de
`is_on_biz_app/platform_type` persisten separadas del número resuelto, conservando
idempotencia después de un reinicio. Esa lectura no activa el canal ni registra
el número. Ver el [contrato de coexistencia](https://github.com/Chervas/cc-front/blob/dev/src/Documentacion/14.3-whatsapp-coexistencia.md).

Esto implementa el rechazo de permisos ajenos en código; **la independencia
real de la aplicación/configuración Meta sigue por verificar**. Si Embedded
Signup exige datos/permisos incompatibles, el alta falla. No se amplían scopes
ni se elimina la inspección para hacerlo funcionar. Un token de alta con ambos
permisos WhatsApp tampoco satisface las identidades separadas de envío/gestión
del [motor operativo](whatsapp-broker-messaging.md): no copiarlo en ambos roles.

## Estado durable y recuperación

`begin` recibe estado de 32 bytes codificado en base64url, caducidad de hasta diez
minutos y hashes del ámbito/conjunto de clínicas. El UUID de petición identifica
el flujo. Se guardan hashes de estado/código, configuración, ámbito e identidad;
ni código, token ni app secret se persisten en SQLite o auditoría.

| Estado | Comportamiento |
| --- | --- |
| `awaiting` | Intención y auditoría registradas; repetir el mismo begin recupera la configuración pública. |
| `exchanging` | Código reclamado bajo transacción antes de AWS/Meta; otro proceso no puede reclamarlo. Tras reinicio no se presupone si Meta lo consumió. |
| `staging` | Permisos y número comprobados, WABA/número reservados, hash y metadata de candidata guardados antes del Put. |
| `staged` | Lectura de versión/hash confirmada y recibo auditado atómicamente. No activa el canal. |
| `interrupted` | Canje sin resultado acreditado; no se vuelve a presentar ese código. |
| `aborted` | Cancelación persistente; un begin tardío con el mismo UUID tampoco puede resucitarlo. |

Una respuesta perdida del Put se concilia con `status`, leyendo exclusivamente
la versión fijada y su hash. No se repite el canje ni la escritura. Si la versión
falta, se conserva la incertidumbre. `finish` repetido sobre una candidata
confirmada devuelve metadata sin llamadas remotas. Las respuestas `staged`
posteriores son recibos históricos; no certifican la validez actual del token
en Meta ni sustituyen la futura verificación de activación.

Cancelación, expiración, cambio de configuración o bloqueo impiden confirmar.
Se revalida el estado después de esperas de proveedor. Los buffers propios se
borran por salida/error/cancelación; cadenas JS y copias internas del SDK no
permiten prometer borrado físico completo. Cancelar no revoca remotamente un
token ya emitido ni deshace un Put que AWS haya aceptado.

Una candidata `staged` permite comenzar otra autorización conservando la anterior.
Los flujos `awaiting` vigentes, `exchanging` y `staging` sí se excluyen entre sí.
El rol opcional queda firmado y las candidatas usan versiones inmutables distintas
en el mismo slot; lectores por UUID/digest aceptan versiones históricas sin
etiqueta, sin usar AWSCURRENT/AWSPREVIOUS. Compatibilidad de columnas y rollback
en el [runbook del gateway](whatsapp-onboarding-gateway.md#principal-secundario-y-compatibilidad-de-estados).

Se permite una solicitud pendiente por conexión; diez inicios/hora y seis
códigos/hora, ochenta/día por conexión. El runtime limita conexiones y peticiones
simultáneas y el motor tiene un plazo de 25 s. No son cuotas verificadas de Meta.

## Secretos y límites AWS

El runtime fija la cuenta/región/prefijo/KMS reportados y usa el bootstrap STS
del broker. **IAM y aislamiento efectivos todavía no están verificados.** Lee
el app secret desde una versión `AWSCURRENT` fijada, con envelope exacto para
esa app. No usa variables de credenciales del backend ni fallback a la BD.

Cada conexión necesita un slot previamente aprovisionado cuyo `AWSCURRENT`
fijado contiene solo `version`, `provider=meta-whatsapp-onboarding-slot`,
`connectionRef`, `scopeKey` y `appId`. Un secreto vacío o con credencial legacy
se rechaza antes de canjear. La cohorte no crea secretos, mueve `AWSCURRENT`,
borra versiones ni activa credenciales.

La candidata se escribe una vez con `ClientRequestToken=flowId` y `AWSPENDING`.
La identidad es la versión inmutable y su hash; `AWSPENDING` puede moverse y no
se usa como selector para recuperar una candidata. La lectura rechaza candidatas
con `AWSCURRENT`/`AWSPREVIOUS` y revalida slots y versión de la app después de
leer. El requisito de placeholder evita que la primera escritura se convierta
automáticamente en la versión actual. Véase [PutSecretValue de AWS](https://docs.aws.amazon.com/secretsmanager/latest/apireference/API_PutSecretValue.html).

El permiso mínimo a revisar incluye Describe/Get del app secret fijado y
Describe/Get/ListSecretVersionIds/Put del slot exacto, KMS y escritura de
auditoría. Ningún principal gateway/DEV/API obtiene permiso de lectura del token.
El esquema de rol actual no demuestra por sí solo esa separación. La
asignación de permisos y el placeholder reales requieren el lote de corte.
La política IAM de Put no permite exigir VersionStage=AWSPENDING: limitar el
ARN candidato y mantenerlo separado de los secretos operativos; no presentar
el control de etiqueta del código como una restricción IAM.

Se consulta el listado de versiones, incluidas las sin etiqueta, y se rechaza
paginación o al menos noventa versiones. AWS limita versiones y etiquetas;
por eso no se crea una etiqueta por intento. Véanse [límites de Secrets Manager](https://docs.aws.amazon.com/secretsmanager/latest/userguide/reference_limits.html).
No hay limpieza automática ni autorización para borrar evidencia. Capacidad,
retención de candidatas y precio real deben conciliarse antes de operar.

Coste técnico: lecturas de metadatos/versiones, un Put por candidata y llamadas
Meta de canje, diagnóstico y pertenencia; el alta por negocio añade una lectura
por cuenta concedida. Begin y cancelación son locales;
la recuperación incierta añade lecturas. Este corte no crea gasto AWS real ni
modifica Ajustes, Cost Explorer, etiquetas o la conciliación Budget/CloudFormation.

## Propiedad, bloqueo y auditoría

Un WABA y sus números quedan vinculados a un único ámbito/conjunto original;
se permiten varios números del mismo WABA en ese ámbito. Un WABA ya vinculado
a otro ámbito se rechaza antes del canje. Los activos desconocidos se reservan
solo tras prueba de proveedor; la reserva no acredita autorización humana.

La baja de control añade bloqueos independientes para el grupo y cada clínica
original en la misma transacción que la revocación y su recibo/auditoría. Se
conservan tras borrar registros originales o cambiar el ID de conexión. Un fallo
de auditoría revierte todo el bloqueo de esa transacción. Cancelar un alta no
libera la propiedad del WABA ni borra esos bloqueos.

Estos registros privados no sustituyen `MetaScopeBlocks` ni conocen nuevas
membresías de la BD clínica. Falta conectar su propagación/revalidación desde
gateway, incluida baja compartida/activos primarios. Una reconexión aprobada
necesitará autorización específica sin borrar bloqueos de credenciales antiguas
ni habilitar Ads. No hay API de desbloqueo automática.

La BD clínica distingue bloqueos universales (`clinic:N`/`group:N`) de un
bloqueo revisado solo de Meta no WhatsApp (`meta:clinic:N`/`meta:group:N`).
El resolver Meta consulta ambos; alta, listado y transporte WhatsApp consultan
los universales. La recepción duradera también consulta las claves universales.
Acotar una baja histórica requiere autorización explícita de reconexión,
revisión de todos los miembros del grupo y evidencia antes/después; no lo hace
OAuth ni el cambio de configuración. Una nueva baja vuelve a insertar la clave
universal y prevalece incluso sobre una autorización WhatsApp ya obtenida.
Antes de acotar el registro deben estar desplegados todos los lectores Meta;
un rollback de código exige restaurar primero la clave universal. El token
antiguo permanece revocado y hace falta una autorización nueva del titular.

La auditoría técnica usa el outbox del broker y el UUID del alta como correlación:
intención, canje solicitado, interrupción, candidata confirmada y cancelación,
más denegaciones del broker. La correlación con usuario/sesión MFA y auditoría
humana v15 la aporta el puente gateway. Retención/inmutabilidad AWS
no quedan acreditadas por estas pruebas locales.

## Validación y próximo corte

QA con TLS real de loopback, SQLite propios, SDK/Meta ficticios y guard de red:
reinicio, competencia entre procesos, ACK perdido, versión ausente, cancelación,
ACL, permisos/WABA ajenos, rotación de app durante lectura, bloques durables,
fallo transaccional de auditoría y ausencia de secretos en resultados/estado.
Ejecutar el runner completo del broker con Node 24 y guard de red, y los tests
gateway/cliente y MySQL propio descritos en [reconexión](whatsapp-reconnection-readiness.md#qa).
Resultados y evidencias de cada corte viven en 99; no deducir de esta suite la
compatibilidad real de Meta, la aplicación de DDL o el despliegue de consumidores.

El puente gateway ya une sesión MFA verificada y correlación de estado/candidato.
Siguiente trabajo: configuración/UI Meta exclusiva de WhatsApp, activación
operativa aprobada y recepción durable gateway → cola → staging. Incluye
registro/coexistencia/suscripciones según proceda y deduplicación de workers;
no registrar números, suscribir WABAs ni enviar como efecto de guardar candidata.
DEV queda fuera; OPS puede seguir apagado.

Sin interrupción actual porque no se instala. Antes del corte se presentarán
recursos/ARNs/permisos, versiones, DDL exacta, procesos/colas, respaldo, ventana,
canary y rollback. Conservar SQLite, recibos, candidatos y bloqueos; ante fallo
cerrar la cohorte y usar un artefacto seguro compatible, sin restaurar estado
antiguo, reutilizar códigos ni recuperar tokens revocados o el alta general.

## Recibo después del plazo OAuth

### Vigencia de conexiones operativas

El plazo del formulario OAuth (30 minutos) no es la duración de una conexión
ya autorizada. `expiresAt: null` en el binding de incorporación y en la
autorización operativa expresa continuidad hasta desconexión o revocación.
También se admite una fecha positiva para cortes temporales explícitos; omitir
el campo o usar cero no equivale a una autorización permanente. Una autorización
operativa sin fecha requiere un binding de incorporación sin fecha.

El ledger conserva su estado y revisión al reiniciar: modificar solo el JSON
no renueva una conexión ya registrada. Para retirar un plazo del piloto, validar
los hashes de configuración, respaldar configuración y SQLite y cambiar solo
`expires_at` de las conexiones activas incluidas en el lote. No modificar estados,
revisiones, recibos, candidatos ni bloqueos. Revertir solo las fechas y el código,
nunca sustituir el ledger por un respaldo que pierda actividad posterior.

Se mantienen los vencimientos reales de Meta (`expiresAt` y
`dataAccessExpiresAt` de la credencial), identidad, clínica, número, reserva,
versión inmutable y revocaciones. El cambio no añade consultas periódicas ni
consultas al token o plantilla por mensaje. Una caída temporal no elimina la
autorización. Los resultados de envío inciertos siguen sin reintentarse a ciegas.

Pruebas: `whatsapp-authorized*.test.js` y `whatsapp-onboarding*.test.js` con el
runtime Node 24 y `test/offline-guard.cjs`; cubren continuidad tras el plazo y
reinicio, revocación posterior y vencimientos reales del proveedor.

`status` conserva la candidata `staged` después de `expiresAt` del formulario.
El campo `expired` sigue describiendo ese plazo; el gateway da precedencia al
recibo guardado para mostrar `awaiting_activation`. Esta excepción se aplica
solo a la proyección de un resultado completado: `begin`, `finish` y la
confirmación de canje mantienen el límite original. Bloqueos, cambio del
fingerprint, reservas y expiraciones reales de la credencial siguen mandando.
Cerrar el diálogo de éxito conserva el recibo; una cancelación expresa mantiene
su efecto revocador. No cambiar a `AWSCURRENT` ni reusar un código OAuth.

## Lectura de recibos sin conciliación

`meta.whatsapp.onboarding.status.v1` admite el campo opcional `readOnly:true`.
Conserva firma, identidad, grants exactos y comprobación del binding, pero solo
proyecta el estado durable. En particular, no intenta conciliar una escritura
`staging` leyendo la versión candidata en Secrets Manager. No inicia canje,
no llama a Meta, no cancela ni activa. El status ordinario conserva su recuperación
anterior cuando este campo no se solicita.

Usar este modo mediante `statusReadOnly` para el
[listado de autorizaciones del gateway](whatsapp-onboarding-gateway.md#consulta-de-autorizaciones-guardadas).
Un estado sin candidata `staged` acreditada no es una autorización visible.
Un terminal `aborted`/`interrupted` confirmado se omite; la incertidumbre de
estados en curso o errores de lectura marca resultado incompleto. No convertir una lectura incierta en
un begin/finish de recuperación automático. La firma consume el control de replay
y la auditoría técnica habituales; «solo lectura» se refiere a los estados y
credenciales del alta, no a omitir esos controles.
