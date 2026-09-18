# Conversiones Google Data Manager por broker

Estado: contrato y runtime preparados y probados localmente. Sin instalación AWS,
activación de consumidores, migración de tokens ni aceptación funcional/UI real.
Este bloque forma parte de la migración completa Google; no permite cortar por
separado la conexión Google compartida mientras queden consumidores legacy.

## Operaciones y permisos

La cohorte explícita `google-ads-conversions-v1` incorpora las lecturas y controles
Ads existentes y tres operaciones. `google-ads-read-v1` rechaza la configuración
Data Manager; instalar código nuevo no convierte una cohorte de lectura en escritura.

| Operación | Entrada específica | Resultado |
|---|---|---|
| `google.ads.conversion.validate.v1` | Acción, evento y origen registrados | `validated`, número de avisos; siempre `validateOnly=true` con datos ficticios |
| `google.ads.conversion.ingest.v1` | Selección y un evento tipado | Acuse `accepted`, UUID de envío, ID del proveedor y número de avisos |
| `google.ads.conversion.status.v1` | UUID de un envío propio | Estado, cuenta/acción fijadas y códigos técnicos/conteos acotados |

La política del broker fija cuenta, gestor, proyecto de cuota, acciones, eventos,
orígenes y autorización de señales mejoradas. Cada grant fija principal, clínica,
conexión y activo. Se mantienen las claves separadas de operación, revocación,
enrollment y OAuth. Ningún consumidor suministra tokens, URL, headers, GAQL ni ID
arbitrario de petición Google para consultar su estado.

El scope adicional `https://www.googleapis.com/auth/datamanager` es obligatorio
solo en los bindings OAuth Ads que declaran Data Manager. OAuth de Ads de lectura
conserva sus scopes anteriores. La operación Data Manager no carga ni transmite
el developer token de Ads, aunque el runtime combinado conserva esa dependencia
para sus lecturas Ads. La ampliación de scopes no autoriza por sí sola ningún envío.

## Consentimiento y datos

Un envío requiere `advertisingConsent=GRANTED`. `adUserData` y `adPersonalization`
conservan por separado los valores explícitos recibidos, incluido `DENIED`; un
valor ausente sigue ausente en la petición Google. El broker no infiere una señal
a partir de otra. Con solo clic pueden viajar esas señales sin hashes personales.

Las señales mejoradas se limitan a hashes SHA-256 de email/teléfono. Exigen
`adUserData=GRANTED`, una señal explícita de personalización y una autorización
configurada vigente que coincida en digest y tipos permitidos. Se comprueba antes
de leer secretos y después de resolver la credencial. No se admite email/teléfono
en claro, nombre, dirección, ID de paciente, propiedades libres ni contenido clínico.
El consumidor debe conservar además la política actual de orientación documentada
y autorización del anunciante, su alcance de cuentas/eventos y las pausas clínicas.
Configurar este contrato no crea ni amplía esa autorización.

Solo se envían un evento y un destino por operación. TLS verificado hacia dos
rutas fijas de `datamanager.googleapis.com`, sin redirecciones ni compresión;
petición JSON máxima 32 KiB y respuesta máxima 128 KiB. Se mantiene la admisión
del runtime Google y no se crea transporte de archivos.

## Durabilidad y recuperación

`googleAdsBroker.conversion(account, context, family, payload, options)` conecta
el cliente tipado al contexto opaco del registro Ads existente. La nueva flag
`GOOGLE_ADS_CONVERSIONS_BROKER_ENABLED=true` es adicional a la de lecturas y está
apagada por defecto. El cliente exige `requestId` UUID explícito y un callback
`beforeExecute` que vuelva a verificar la política clínica aplicable y devuelva
`true`. Recomprueba registro, grants, flags y plazo alrededor de cada llamada.
No genera identificadores, reintenta ni utiliza tokens locales como fallback.

Para consultar estado, `options.expectedActionId` identifica la acción guardada
en el recibo CRM; solo el UUID `submissionId` viaja como selección al broker.
Cada consulta posterior usa un nuevo UUID de comando de lectura. Las respuestas
se vuelven a validar en el cliente contra cuenta, acción y contrato exactos.

El UUID de comando debe reservarse de forma durable en el CRM antes del envío y
mantenerse entre reintentos. El broker persiste un intento antes de llamar a Google.
El recibo aceptado, la respuesta de comando y el evento de auditoría se confirman
en una misma transacción SQLite. Solo guarda referencias, digest de alcance,
estado, ID de proveedor y fechas; no guarda clic, hashes personales, cuerpo ni token.

Repetir exactamente el comando devuelve el recibo existente sin repetir la
conversión. Cambiar el contenido manteniendo UUID se rechaza. Un ACK perdido,
interrupción o fallo de persistencia después de llamar al proveedor queda con
resultado desconocido: no se genera un nuevo UUID ni se reenvía automáticamente.
La recuperación de un resultado desconocido necesita conciliación explícita; la
API de estado solo sirve cuando existe un recibo aceptado durable.

El estado exige el mismo principal, clínica, conexión, activo y alcance de destino
del envío; también vuelve a comprobar la revocación antes y después del proveedor.
Un worker de diagnóstico debe utilizar la identidad propietaria del envío y sus
referencias registradas, nunca convertir un ID Google histórico en autorización.
Un ID de recibo Google no puede reconocer dos envíos distintos en este ledger.

`accepted` solo acredita recepción por Google. La consulta posterior distingue
procesando, éxito, fallo y éxito parcial. Una respuesta vacía sigue pendiente.
Se rechazan destinos ajenos, tipos de audiencia y conteos incompatibles con el
único evento enviado. Los motivos conocidos se conservan en una lista explícita;
los nuevos se proyectan como `UNKNOWN`, sin mensajes ni detalles libres.

Para recuperar el servicio, conservar el SQLite actual, sus comandos, recibos,
bloqueos y auditoría. No restaurar una copia anterior del ledger después de un
envío, borrar intentos ni cambiar UUID para forzar repetición. Una pausa de la
cohorte impide nuevas operaciones y no rehabilita el acceso legacy.

## Verificación y trabajo necesario antes del corte

Las pruebas del contrato cubren consentimiento, política, aislamiento, scopes
OAuth, revocación concurrente, ACK perdido, transacciones, transporte y reinicio
real del servidor HTTPS con SQLite reabierto. Usan AWS/Google/S3 ficticios y una
guardia de red offline. La comparación contra el constructor actual del CRM
incluye 54 combinaciones WEB/OTHER, gclid/gbraid/wbraid y las dos señales de
consentimiento. No acredita entrega real a Google ni una interfaz autenticada.

Regresión final: 556/556 pruebas del broker en Node24, incluida la llamada desde
el cliente CRM real al servidor HTTPS local; 23/23 de cliente, scope y lector
Ads en Node18. Guardias de red/BD impiden acceder a los entornos operativos.

Queda conectar y probar subida web, hitos CRM nativos, preparación validate-only,
diagnóstico y sus resolutores de permisos. La reserva actual de
`GoogleAdsConversionUploadAttempts` reutiliza pendientes antiguos y fallidos:
antes de activar broker necesita identidad durable de comando, enlace al recibo,
tratamiento de resultado desconocido y recuperación sin doble envío. Conservar
los grants, la política del workspace, consentimiento, pausas y deduplicación.
El [inventario de este tramo](google-data-manager-consumers.json) incluye los dos
validadores de onboarding y el job que combina diagnósticos con otras tareas;
no debe reactivarse ese job para probar aisladamente la consulta de un recibo.

Completar el inventario de consumidores de la identidad compartida, preparar las
acciones registradas y las políticas, renovar acceso AWS, verificar instalación
y auditoría, ejecutar pruebas autorizadas con Google y recorrer UI autenticada
con MFA. No activar campañas, históricos, leads ni jobs clínicos DEV para probar.
No retirar credenciales locales ni marcar el bloque aceptado antes de esa evidencia.

Referencias oficiales revisadas el 18/09/2026:
[ingesta y validateOnly](https://developers.google.com/data-manager/api/reference/rest/v1/events/ingest),
[estados, conteos y motivos](https://developers.google.com/data-manager/api/reference/rest/v1/requestStatus/retrieve).
