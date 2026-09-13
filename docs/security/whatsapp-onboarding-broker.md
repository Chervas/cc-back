# Alta WhatsApp: registro del broker y credencial candidata

13/09/2026. Implementación del broker privado, con AWS/Meta ficticios en QA.
El runtime no está instalado. El [puente gateway/MFA](whatsapp-onboarding-gateway.md)
ya está conectado en código; la interfaz sigue pendiente. No hay
credenciales reales incorporadas, migración compartida ni autorización de
reconexión. El resultado `staged` significa candidata guardada: `connected` es
siempre `false`. No existe operación de activación en esta cohorte.

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
Ads, leads, páginas, Instagram y `business_management` se rechazan.

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

Se consulta el listado de versiones, incluidas las sin etiqueta, y se rechaza
paginación o al menos noventa versiones. AWS limita versiones y etiquetas;
por eso no se crea una etiqueta por intento. Véanse [límites de Secrets Manager](https://docs.aws.amazon.com/secretsmanager/latest/userguide/reference_limits.html).
No hay limpieza automática ni autorización para borrar evidencia. Capacidad,
retención de candidatas y precio real deben conciliarse antes de operar.

Coste técnico: lecturas de metadatos/versiones, un Put por candidata y llamadas
Meta de canje, diagnóstico y pertenencia. Begin y cancelación son locales;
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

La auditoría técnica usa el outbox del broker y el UUID del alta como correlación:
intención, canje solicitado, interrupción, candidata confirmada y cancelación,
más denegaciones del broker. La correlación con usuario/sesión MFA y auditoría
humana v15 depende del puente gateway pendiente. Retención/inmutabilidad AWS
no quedan acreditadas por estas pruebas locales.

## Validación y próximo corte

QA con TLS real de loopback, SQLite propios, SDK/Meta ficticios y guard de red:
reinicio, competencia entre procesos, ACK perdido, versión ausente, cancelación,
ACL, permisos/WABA ajenos, rotación de app durante lectura, bloques durables,
fallo transaccional de auditoría y ausencia de secretos en resultados/estado.
Regresión completa: **331 pruebas pasan**, incluidas 37 nuevas de este bloque,
sin fallos ni omisiones. Evidencia privada `whatsapp-onboarding-full-tests.log`.
No hay cambios de UI o DDL clínica nuevos; no corresponde QA Angular/MySQL en
este corte. DDL anteriores de estado/sesión/MFA/bloqueos siguen pendientes en
BD compartida. El hotfix getAssetStats se conserva.

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
