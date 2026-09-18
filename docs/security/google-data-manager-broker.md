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
| `google.ads.conversion.status.v1` | UUID de un envío propio | UUID e ID de recibo originales, estado, cuenta/acción y códigos/conteos acotados |

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

El UUID de comando se reserva en el nuevo registro SQL descrito más abajo antes
del envío y se conserva durante la recuperación. El broker persiste un intento antes de llamar a Google.
El recibo aceptado, la respuesta de comando y el evento de auditoría se confirman
en una misma transacción SQLite. Solo guarda referencias, digest de alcance,
estado, ID de proveedor y fechas; no guarda clic, hashes personales, cuerpo ni token.

Repetir exactamente el comando devuelve el recibo existente sin repetir la
conversión. Cambiar el contenido manteniendo UUID se rechaza. Un ACK perdido,
interrupción o fallo de persistencia después de llamar al proveedor queda con
resultado desconocido: no se genera un nuevo UUID ni se reenvía automáticamente.
La recuperación de un resultado desconocido necesita conciliación explícita; la
API de estado solo sirve cuando existe un recibo aceptado durable.

La consulta devuelve también `submissionId` y `requestId` desde ese recibo durable,
ligados al mismo ámbito. Así el CRM recupera el identificador Google incluso si
se perdió el ACK inicial. Una respuesta de Google todavía vacía no se interpreta
como éxito de procesamiento. El panel conserva el formato de diagnóstico actual.

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

Última regresión del motor broker: 560/560 en Node24, incluida la llamada desde
el cliente CRM real al servidor HTTPS local. Regresión actual de preparación,
cliente, scope, lector y adaptador CRM: 36/36 en Node18; otras 84 pruebas de
workspace/autorización/recepción/emisor pasan. Guardias de red/BD impiden acceder
a los entornos operativos. MySQL aislado verifica 41 grupos, detallados más abajo.

El emisor común de conversiones y su resolutor por mapping ya seleccionan el
camino broker cuando el registro Ads lo exige. Ya están conectados los mandatos
workspace v2, los hitos CRM nativos y su preparación validate-only. Siguen
pendientes diagnóstico, dos validadores onboarding y recepción/sync de leads.
La recepción managed falla cerrada antes de cargar un token local. No activar
el conjunto parcial ni migrar la identidad compartida antes de completarlos.
Conservar los grants, la política del workspace, consentimiento, pausas y deduplicación.
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

## Reserva SQL y recuperación en CRM, 18/09/2026

`GoogleConversionSubmissions` conserva UUID, intento/dedupe, mapping, referencias
de ámbito y hashes de contexto, identidad de firma, auditoría y comando. No
almacena el cuerpo, clic, email/teléfono, hashes personales ni credenciales.
El repositorio requiere la identidad estable de audiencia/clave y `activeSince`,
una fecha de corte explícita y fija. No debe calcularse de nuevo al reiniciar.

Solo se admiten intentos nuevos pendientes, con contador uno, datos de ámbito y
consentimiento coincidentes, creados después del corte y dentro de cinco minutos.
El evento también debe ser posterior al corte. Un registro preparado caduca para
envío a los cinco minutos. No se adoptan pendientes históricos, fallidos o recibos
legacy como nuevas conversiones broker. Dos reservas concurrentes del mismo
intento convergen en un UUID; solo una puede pasar de `prepared` a `attempted`.

`googleConversionDelivery` combina repositorio y cliente tipado. Después de
persistir `attempted`, ninguna repetición vuelve a ejecutar ingesta, aunque el
acuse o su guardado fallen. Un estado `unknown` exige conciliación mediante la
operación de lectura. Incluso si falla guardar `unknown`, queda el marcador
anterior `attempted`. Si el broker no conserva recibo, no se infiere permiso para
reintentar: ese caso requiere revisión explícita.

La aceptación y la actualización de `GoogleAdsConversionUploadAttempts` ocurren
en una transacción SQL. Se conserva el historial y la forma de los diagnósticos
que consume Salud. La consulta recupera el ID Google perdido y puede marcar
aceptación, éxito, fallo o éxito parcial. Una respuesta tardía de procesamiento
no degrada un estado terminal. Un fallo confirmado tampoco crea otro envío.

El intento existente recibe `requestMetadata.broker_submission_id`. La vía legacy
rechaza un registro marcado, incluido el camino de colisión al insertar. Esto
no sustituye drenar todos los emisores antiguos antes del corte: un proceso viejo
ya en vuelo no adquiere estas defensas por publicar una versión nueva.

Migración aditiva `20260918110000-create-google-conversion-submissions.js`:
tabla independiente sin borrado en cascada, tres CHECK de estado y unicidad por
intento, dedupe y recibo. `down` se niega con cualquier historial. El contrato de
despliegue pasa a 36 tablas y fija también la tabla de intentos existente y sus
tres migraciones previas: **solo una tabla nueva**. Ninguna DDL operativa aplicada
en este bloque. Un HEAD nuevo necesita un plan y preflight nuevos; no usar el
plan de trece migraciones ya ejecutado ni publicar esquivando el comprobador.

La prueba `google_conversion_submission_mysql.integration.js` usa MySQL propio,
el repositorio/scope/cliente reales y broker firmado con SQLite. Google/AWS son
ficticios; la única conexión SQL admitida es el socket de la instancia de prueba.
Incluye concurrencia, commit fallido, doble fallo de persistencia, revocación,
recuperación tras reapertura SQLite, rechazo de históricos y preservación de la
evidencia que consume Salud. El mismo aplicador ejecuta la migración fijada y
rechaza repetir su plan. No equivale a un recorrido autenticado ni a un corte real.


## Emisor común y selección por mapping, 18/09/2026

`resolveScopedGoogleAdsRuntime` consulta siempre el registro Ads antes de leer
credenciales, incluso con la cohorte apagada. Una cuenta gestionada devuelve
contexto opaco, mapping y metadata sin tokens; comprueba clínica/grupo y scopes.
El transporte rechaza cambios de audiencia, clave, endpoint o rutas privadas
respecto a su configuración inicial; no firma con una identidad de caché distinta.

El emisor común dirige ese runtime al coordinador SQL. El intento se crea sin
actualizar filas anteriores y lleva `broker_delivery_version: 1` desde la inserción,
antes de reservar UUID. Legacy rechaza tanto ese marcador como el UUID, incluso
tras una colisión. Si un proceso cae en ese intervalo, solo el mismo intento nuevo
con los mismos datos puede continuar dentro del límite original de cinco minutos.
Un intento legacy que gane la colisión no se adopta ni reinicia.

Se requiere `GOOGLE_ADS_CONVERSIONS_ACTIVE_SINCE` ISO UTC con milisegundos,
explícito y estable, además de audiencia/clave y las dos flags Ads. La fábrica
rechaza corte ausente antes de crear el intento. No calcularlo al arrancar ni
cambiarlo para convertir un envío incierto en otro nuevo. Conservar corte,
identidad, timestamp persistido, UUID y contador al recuperar el servicio.

El guard relee estado clínico, propietario y contenido de la configuración SQL,
mandato, consentimiento y vigencia de la autorización mejorada antes/después del
transporte. Otra clínica del grupo no puede aportar su configuración. La reserva
admite la clínica dentro del grant de grupo y conserva el ámbito original en el
intento. Una autorización mejorada configurada no obliga a enviar hashes para
un evento solo con clic. Se mantiene el consentimiento exigido por el emisor.

Un acuse perdido queda desconocido: `unknown_count` evita computarlo como
aceptado o saltado. La consulta del recibo puede recuperar el éxito sin reenvío;
no se utiliza el reintento legacy tras cinco minutos ni se activa el job combinado.

Prueba con emisor/resolutor/fábrica/coordinador reales, MySQL propio y broker
firmado en proceso con SQLite:29 grupos pasan,11 ingestas ficticias,20 llamadas
firmadas y cero lecturas de tokens SQL. Incluye concurrencia, acuse perdido,
pausa, cambio de configuración durante envío, colisión legacy y fuente de otra
clínica. La suite Node cliente/scope/constructor pasa27 casos, con54 comparaciones
del cuerpo anterior frente al nuevo. No acredita tráfico real ni interfaz.

Regresión workspace:57 casos de otros flujos pasan. Los27 fallos de la suite v2
se reproducen también en el HEAD anterior5ba33b6d aislado: faltaban registros
Google ficticios y el diagnóstico consultaba modelos globales. Corregida la
preparación, esa suite pasa28/28 conservando el control real de credenciales.
Se preservan logs de los fallos de prueba, incluido consentimiento mal configurado.

Sin tabla nueva aplicada, despliegue ni cohortes activadas en ese corte. La
adaptación posterior de workspace se describe a continuación; diagnóstico,
onboarding y sync de leads aún requieren adaptación antes del corte compartido.

## Mandatos workspace y hitos CRM, 18/09/2026

`googleAdsGrantTransport` separa permisos y transporte. Lee primero identidad
sin tokens y comprueba el cierre legacy, incluidas marcas independientes. Si
la conexión está gestionada, prepara y revalida los contextos opacos Ads de todas
las asignaciones elegibles. Solo devuelve identidad/scopes y una capacidad en
memoria no serializable, ligada a esos modelos y referencias. Un objeto fabricado
o una copia JSON no autoriza nada. Recomprueba subject, scopes, referencias,
clínicas y grants cada vez; una pérdida de permisos nunca vuelve al token local.
Los fingerprints actuales de autorización se conservan.

La preparación obtiene el inventario mediante
`google.ads.conversion_actions.read.v1`: consulta fija, máximo 5.000 acciones,
paginación completa y sin snippets. El CRM aplica su aprobación canónica real;
un flag omitido o propietario ajeno no se transforma en acción válida. Consulta
y validaciones comprueban permiso del usuario, configuración y ejecución vigente
antes/después. Los eventos `qualified_lead` y `schedule` validan WEB y OTHER;
los demás, WEB. Estas operaciones usan datos ficticios y nunca ingieren un evento.

La ruta web comprueba mandato, clínica y configuración web, y la nativa conserva
atribución persistida, receptor, consentimiento y vigencia del hito/cita. Ambas
llegan al coordinador SQL existente sin tokens locales y conservan el formato
de Salud (contexto v2 web y v3 nativo). No se activan mandatos automáticamente.
El resolutor de recepción ya entrega metadata/capacidad a los hitos; su job de
importación todavía rechaza `google_lead_broker_sync_pending` para cuentas
gestionadas. Hace falta la lectura tipada de leads antes de migrar esa identidad.

Verificación:41 grupos con MySQL8.0.42 propio, servicios de negocio reales y
broker firmado con SQLite, AWS/Google ficticios. Dieciséis ingestas ficticias,
33 comandos firmados,18 journals y cero lecturas SQL de tokens. Se prueban
preparación real, deduplicación web/nativa, mandato pausado, cita ajena, revocación
de asignación, retirada de scope, cambio de subject, pausa tras acuse y cambio de
preferencias durante validate-only. La activación de la fixture se siembra desde
la revisión real; no prueba el endpoint de activación ni autenticación/MFA.
Los modelos mínimos de leads/citas de esa fixture no acreditan todo su DDL real.

Las 560 pruebas del broker permanecen independientes del bootstrap del CRM:
la aprobación canónica cruzada se comprueba en el proceso backend con guardia
offline. Evidencia privada `google-workspace-broker/`. Sin DDL/despliegue,
proveedores reales ni nueva evidencia visual; cero consumidores reales migrados.
No retirar credenciales ni habilitar cohortes hasta completar consumidores,
pruebas reales autorizadas y recorrido visual autenticado.

La comprobación del informe real de Salud detectó y reprodujo un cierre legacy
incorrecto al finalizar el recorrido nativo. Se sustituyó por revalidación de
capacidades broker; el formato v1 también usa su contexto y metadata, sin token.
La prueba SQL recorre emisor→persistencia→Salud para v1, v2 y v3; el GET no llama
al broker/Google, no consulta contactos, descarta evidencia de un mandato antiguo
y distingue recibido de procesado. La suite de Salud/v2/nativo pasa69/69; diez
fallos iniciales del grupo v1 se reprodujeron con el servicio anterior: IDs de
cuenta cortos y registros Ads ficticios incompletos. Se corrigió esa fixture para
usar el resolutor y el cierre legacy reales, manteniendo sus casos de rechazo.
No se ha probado aún el panel renderizado con autenticación real ni el diagnóstico
automático de los recibos del broker.
