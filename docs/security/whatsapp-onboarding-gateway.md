# Puente de alta WhatsApp: gateway, MFA y broker

13/09/2026. Código preparado y probado con datos/proveedores ficticios. Añade
rutas específicas a gateway y une el estado MySQL con el broker firmado. Sin
configuración instalada ni despliegue. **La interfaz/Embedded Signup y la
validación real de Meta siguen pendientes; no autoriza reconectar.**

## Recorrido implementado

`whatsappOnboardingGateway.service` une el [estado con MFA](whatsapp-authorization-state.md)
con el [broker del alta](whatsapp-onboarding-broker.md). El cliente tipado
`whatsappOnboardingBrokerClient` solo expone begin/finish/status/abort. No puede
enviar mensajes, activar candidatas, recuperar tokens o usar OAuth legacy.

Begin registra la intención humana y el ámbito en MySQL antes de crear el flujo
del broker. Finish reclama el código una vez y revalida sesión/permisos antes
y después del canje. El mismo UUID identifica ambos registros. Solo el broker
canjea en Meta, inspecciona identidad/alcance y escribe la candidata.

El broker utiliza el conjunto exacto de clínicas y su hash, junto con el hash
del ámbito validado por el estado MySQL. Estos dos hashes se añaden a las
proyecciones **internas** del servicio de estado; no hay columnas nuevas ni
se exponen en el DTO HTTP. No se leen MetaConnections ni tokens legacy.

Dos callbacks simultáneos compiten por la reclamación MySQL; el perdedor solo
consulta estado. Nunca se vuelve a presentar su código, incluso tras reinicio
o pérdida de respuesta. Un error de transporte posterior al intento devuelve
`outcomeUnknown:true`; el cliente debe consultar status con el mismo requestId.
No generar un requestId nuevo para intentar repetir una operación incierta.

Si se pierde el ACK de begin, el mismo begin recupera la intención pendiente.
Si se pierde el ACK del Put, status concilia la versión/hash desde el broker.
Código reclamado pero no confirmado por el broker permanece pendiente de
revisión/cancelación: no se reconstruye ni se repite desde logs, BD o navegador.

Una sesión revocada o un permiso perdido durante el trabajo impide devolver el
resultado. Se intenta cancelar ese flujo en el broker usando su ámbito original;
si la red no responde no se afirma haberlo cancelado. Esto no deshace un canje o
Put ya aceptado. La candidata permanece sin activar y el plazo/bloqueo del broker
sigue vigente. Ninguna de estas operaciones reactiva consumidores de negocio.

## Rutas públicas preparadas

Base: **gateway** `/api/whatsapp/onboarding`. Solo POST JSON, sin query string,
con Bearer de sesión gestionada y cabecera `X-Whatsapp-Onboarding: 1`.
Origin debe ser exactamente app, crm o autenticacion de clinicaclick.com sobre
HTTPS. No se admite localhost, Origin ausente/null, cookies como autenticación,
URI/cuenta de proveedor arbitraria ni selección del runtime desde el cuerpo.

| Ruta | Cuerpo JSON exacto |
| --- | --- |
| `/begin` | `requestId`, `scope:{type:'clinic'|'group',id:entero}` |
| `/finish` | `requestId`, `state`, `code`, `wabaId`, `phoneId` |
| `/status` | `requestId` |
| `/cancel` | `requestId` |

Actor, sessionRef y expiración se obtienen del middleware verificado. El estado
exige prueba de correo vigente y permiso sobre todas las clínicas. El cuerpo no
puede sobrescribir esos campos. Las rutas se montan antes del parser general:
JSON de máximo 8 KiB, sin compresión ni copia en `req.rawBody`. Content-Type
distinto produce 415, cuerpo excesivo 413 y JSON/contrato inválido 400.

Cache-Control no-store, Referrer-Policy no-referrer y errores de código fijo.
No registrar cuerpos de estas rutas ni cabeceras Authorization; proxy/APM deben
verificarse antes de desplegar. El código de canje solo viaja en el cuerpo al
gateway y al broker, nunca en parámetros de estas rutas. Su salida a Meta sigue
el [transporte privado](whatsapp-oauth-transport.md) y sus restricciones de logs.

## Respuesta y cancelación

El DTO contiene `requestId`, `authorizationStatus`, `connected:false`, `pending`,
`expiresAt`, `scope`, `clinicCount`, `selected` y `cancellationConfirmed`.
Solo un begin todavía pendiente añade `authorization:{appId,configId,redirectUri,state}`.
Son la configuración pública fijada por el broker y el estado de ese intento.
No se devuelven subjectId, scopes, ARN, versión del secreto, hashes, código o token.

| authorizationStatus | Significado |
| --- | --- |
| `awaiting_authorization` | Estado y broker preparados para la autorización Meta específica. |
| `processing` | Reclamación/canje o escritura pendientes de confirmación. |
| `awaiting_activation` | Recibo histórico de candidata guardada; selected contiene solo WABA/número. |
| `cancelled` | Cancelación local solicitada o cancelación acreditada por el broker. |
| `expired` | El plazo original ha terminado. |
| `blocked` | Configuración/ámbito bloqueados por el broker. |
| `interrupted` | El canje no quedó acreditado y no puede repetirse. |

`awaiting_activation` no prueba validez actual en Meta ni habilita el número.
Cancel primero conserva la cancelación en MySQL y después solicita abort al
broker. Solo `cancellationConfirmed:true` acredita ambas. Si falla el transporte,
la cancelación local persiste y se puede volver a pedir con el mismo UUID.
También se reconcilia una cancelación local al consultar status si el usuario
conserva permiso; después de perder membresía/bloquear el ámbito se usa cancel.
Se exige la sesión MFA original válida; no se transfieren intentos a otra sesión.
Cancel no revoca remotamente el token Meta ni libera propiedad del WABA.

## Configuración privada y activación pendiente

Se conservan los requisitos de `WHATSAPP_ONBOARDING_ENABLED=true`, runtime,
namespace/prefijo gateway, workers/cron false, sesiones/MFA enforce y auditoría
del [contrato de estado](whatsapp-authorization-state.md). Sin ellos, la ruta
falla antes de consultar modelos o abrir transporte. Activar ese gate requiere
el corte aprobado; no equivale a levantar la cuarentena del resto de Meta.

Nueva variable: `WHATSAPP_ONBOARDING_BROKER_CONFIG_FILE`, ruta absoluta real de
archivo privado, máximo 128 KiB. JSON exacto:

```json
{
  "version": 1,
  "origin": "https://broker.example.invalid",
  "audience": "broker:whatsapp-onboarding",
  "keyId": "gateway:whatsapp-onboarding-key",
  "privateKeyFile": "/private/gateway-whatsapp.pem",
  "caFile": "/private/broker-ca.pem",
  "bindings": [{
    "connectionRef": "connection:whatsapp-enrollment",
    "scopeKey": "group:9",
    "clinicIds": [71, 72],
    "appId": "101",
    "configId": "102",
    "redirectUri": "https://autenticacion.example.invalid/whatsapp/callback",
    "scopes": ["whatsapp_business_management", "whatsapp_business_messaging"]
  }]
}
```

Ejemplo ficticio, no configuración para instalar. Máximo 64 bindings únicos por
ámbito/conexión; clínicas ordenadas e idénticas al conjunto autorizado. No admite
ARN, versión o valor de secretos del proveedor. La clave Ed25519 pertenece solo
al principal gateway de alta, sin privilegios de control/envío. Ficheros privados,
sin enlaces, clave de hasta 8 KiB y CA hasta 64 KiB; buffers propios se borran al
salir. Las claves criptográficas importadas/cadenas JS no permiten prometer
borrado físico completo. No hay caché de configuración ni credenciales Meta.

El cliente usa TLS verificado, plazo de 30 s y no reintenta transporte. Vuelve a
leer configuración/binding después de la respuesta y comprueba campos exactos,
App/config/URI de begin, alcance, expiración y candidata/versión/selección. Un
cambio o respuesta incongruente produce incertidumbre sin exponer su contenido.

Pendientes antes del corte: verificar configuración Meta de WhatsApp exclusiva,
identidades/IAM/OS/SQL/Redis, proxy/APM, correo MFA efectivo y migraciones previas.
El UID compartido observado no aísla claves aunque los nombres de entorno difieran.
No se ha instalado ninguno de estos archivos ni cambiado variables/servicios.

## Auditoría, QA y siguiente entrega

Las transiciones humanas issue/claim/cancel usan v15 y requestRef; el broker
registra intención, candidata/cancelación y resultado técnico con el mismo UUID.
No se añade un evento humano de activación porque no se activa. Denegaciones
HTTP previas a autenticación y cobertura global/retención siguen pendientes de
la auditoría de plataforma; no presentar esta correlación como cobertura total.

QA: cliente tipado con broker firmado/SQLite, HTTP real de loopback con identidad
de prueba, runtime TLS usando la configuración de archivos, y composición con
sesiones/MFA/estado reales en MySQL propio. AWS/Meta ficticios y red bloqueada
fuera de fixtures. **36 pruebas Node pasan** (35 regresión y una TLS), más
**15 grupos de comprobaciones en MySQL propio**, cuyo proceso cerró con código 0.
Tras endurecer el tipo de connectionRef se repiten los ocho tests afectados
(siete de cliente y uno TLS), todos correctos.
Evidencia privada `whatsapp-gateway-*.log`. No hay UI nueva:
la validación de navegador corresponde a la siguiente integración de interfaz.

Sin DDL clínica nueva; 20260913150000 y dependencias de sesión/MFA/bloqueos/auditoría
siguen pendientes en BD compartida. Sin gasto AWS/Meta real. Las llamadas de
recuperación añaden las lecturas del broker ya descritas; Ajustes/Cost Explorer,
Budget/CloudFormation, retención y cifrado BD mantienen su estado pendiente.

Siguiente entrega: interfaz/recorrido Meta exclusivo de WhatsApp sin la conexión
general previa, correlación Embedded Signup, configuración real, activación
aprobada y consumidores/colas de staging. OPS puede seguir apagado; DEV fuera.
Antes del despliegue se concretarán versiones, DDL, procesos, respaldo, ventana
y rollback. Para revertir, cerrar nuevas altas conservando estado, cancelaciones,
candidatas y bloqueos. No restaurar códigos consumidos, OAuth general o tokens
revocados. Esta publicación no modifica la interrupción operativa existente.
