# Conversiones Google Data Manager por broker

Estado: contrato y runtime preparados y probados localmente. Sin instalación AWS,
activación de consumidores, migración de tokens ni aceptación funcional/UI real.
Este bloque forma parte de la migración completa Google; no permite cortar por
separado la conexión Google compartida mientras queden consumidores legacy.

## Operaciones y permisos

La cohorte explícita `google-ads-conversions-v1` incorpora las lecturas y controles
Ads existentes y cuatro operaciones tipadas. La conciliación histórica exige
su propio grant explícito; añadir código no lo incorpora a políticas existentes. `google-ads-read-v1` rechaza la configuración
Data Manager; instalar código nuevo no convierte una cohorte de lectura en escritura.

| Operación | Entrada específica | Resultado |
|---|---|---|
| `google.ads.conversion.validate.v1` | Acción, evento y origen registrados | `validated`, número de avisos; siempre `validateOnly=true` con datos ficticios |
| `google.ads.conversion.ingest.v1` | Selección y un evento tipado | Acuse `accepted`, UUID de envío, ID del proveedor y número de avisos |
| `google.ads.conversion.status.v1` | UUID de un envío propio con destino activo | UUID e ID de recibo originales, estado, cuenta/acción y códigos/conteos acotados |
| `google.ads.conversion.reconcile.v1` | UUID de un envío con recibo aceptado y autorización original registrada | Misma proyección de estado, aun después de retirar ese permiso; lectura explícita sin reenviar |

La política del broker fija cuenta, gestor, proyecto de cuota, acciones, eventos,
orígenes y autorización de señales mejoradas. Cada grant fija principal, clínica,
conexión y activo. Se mantienen las claves separadas de operación, revocación,
enrollment y OAuth. Ningún consumidor suministra tokens, URL, headers, GAQL ni ID
arbitrario de petición Google para consultar su estado.

Además de los destinos estáticos, está preparado el [registro explícito por recibo
aplicado](google-destinations-broker.md). Crear una acción o recuperar su plan no
lo autoriza. Los destinos dinámicos conservan identidad, evento/origen y revocación,
sin conceder señales mejoradas; diario humano/API/UI de esa decisión pendientes.

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

## Recibos después de retirar un permiso de destino

Primitiva broker y cliente CRM preparados, **sin consumidor administrativo ni
activación operativa**. `google.ads.conversion.reconcile.v1` permite leer un recibo
aceptado ligado al permiso original, activo o retirado. La consulta automática
existente mantiene `status` y su política de destino activo; no se cambia un job
por esta vía ni se usa como alternativa automática tras un error.

Cada ingesta nueva mediante permiso dinámico registra, en la misma transacción
SQLite que su intento, `google_data_manager_receipt_authorizations`:
`submission_id` (PK/FK del recibo), `authorization_id` y `authorization_digest`.
No añade contenido, clic, identificadores personales ni tokens. Es una tabla
aditiva del SQLite existente; no otro servicio ni una modificación de las columnas
del recibo previo. Si falla esta escritura, no hay llamada al proveedor.

La lectura acepta solo el UUID de envío. Busca recibo propio por principal,
clínica, conexión y activo; exige estado `accepted`, ID Google durable y prueba
del permiso original. Recupera ese permiso por PK y vuelve a comprobar su plan
aplicado, selección, identidad de firma, política, cuenta/manager y digest de
ámbito. Un permiso posterior, aunque use la misma acción, no puede sustituirlo.
La retirada permite esta lectura concreta; desconectar el activo, revocar la
conexión, cambiar identidad/ámbito/política o retirar el grant siguen denegando.

Usa exclusivamente `requestStatus:retrieve`, con ID obtenido del ledger. Valida
cuenta/acción, una sola conversión y proyección cerrada; una respuesta vacía no
prueba procesamiento. Revalida antes/después del proveedor y dentro de la
transacción final de auditoría, incluido que no cambie el ID del recibo. No
modifica permiso, targets ni recibo de ingesta. Registra auditoría técnica
`receipt_reconciled` y la operación exacta; un fallo de auditoría no libera el
resultado. La respuesta de lectura no se conserva como replay: cada consulta
explícita posterior usa otro UUID de lectura, nunca otro UUID de conversión.

Un intento sin ACK durable, un recibo anterior sin esta prueba o un destino
estático sin autorización dinámica permanece `outcome_unknown` en esta vía.
No se reconstruyen referencias desde el digest ni desde los grants actuales.
El estado normal de destinos estáticos conserva su contrato previo.

El cliente `googleAdsBroker.conversion(...,'reconcile',...)` añade el gate
`GOOGLE_ADS_RECEIPT_RECONCILIATION_BROKER_ENABLED=true`, cerrado por defecto y
adicional a Ads/conversiones. Exige UUID de lectura, `expectedActionId` y guard
explícitos, contexto opaco y permisos vigentes comprobados alrededor de la
llamada. El consumidor HTTP humano, la admisión/auditoría v19 y la actualización CRM
están preparados en DEV; no cambia el coordinador automático. Publicación y
recorrido visual autenticado con proveedor real siguen pendientes.

Consulta por claves únicas, sin barrido histórico. Una referencia SQLite por
ingesta dinámica; cada conciliación implica una consulta al proveedor y auditoría
por el outbox técnico existente. No hay medición de coste incremental ni nuevos
recursos contratados. Para revertir, cerrar gate/grant de conciliación y conservar
ambas tablas, permisos retirados, intentos y recibos. No eliminar ni completar
retroactivamente las referencias; una versión anterior no producirá esa prueba
en nuevas ingestas y no debe seguir creando envíos si se requiere recuperarlas
posteriormente por esta vía.

## Verificación y trabajo necesario antes del corte

Las pruebas del contrato cubren consentimiento, política, aislamiento, scopes
OAuth, revocación concurrente, ACK perdido, transacciones, transporte y reinicio
real del servidor HTTPS con SQLite reabierto. Usan AWS/Google/S3 ficticios y una
guardia de red offline. La comparación contra el constructor actual del CRM
incluye 54 combinaciones WEB/OTHER, gclid/gbraid/wbraid y las dos señales de
consentimiento. No acredita entrega real a Google ni una interfaz autenticada.

La evidencia histórica del motor conserva 560/560 Node24 del tramo workspace.
La regresión de destinos, posterior, se registra en 99 y en el inventario de
este tramo; no sumar suites solapadas. El lote de Salud/autorización/nativo,
adaptador y cliente pasa82/82 Node18; los scripts de contrato Data Manager y
cadencia pasan. MySQL aislado verifica52 grupos. Las suites previas (36 y84)
son evidencia de sus cortes, con casos solapados; no sumar como casos únicos.

El emisor común de conversiones y su resolutor por mapping ya seleccionan el
camino broker cuando el registro Ads lo exige. Ya están conectados los mandatos
workspace v2, los hitos CRM nativos y su preparación validate-only. Siguen
pendientes la aceptación integrada de destinos, bootstrap y recepción/sync de leads.
La autorización humana ya tiene diario/API/UI y retirada anticipada preparados;
la recuperación sin referencia local también está preparada. Faltan compatibilidad
AWS v18 y aceptación integrada.
Planes de acciones ya preparados con diario/API/UI, todavía sin aceptación real.
Los dos validadores onboarding ya están adaptados, como se describe al final.
El diagnóstico de recibos está conectado
y probado aisladamente, como se describe al final.
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
En ese corte no se probó el diagnóstico automático, conectado en el tramo
siguiente. El panel renderizado con autenticación real sigue pendiente.


## Diagnóstico de recibos propios, 18/09/2026

`googleDataManagerDiagnostics` conserva la consulta legacy para conexiones sin
migrar y selecciona además pendientes marcados, aunque no tengan ID de Google.
Los intentos marcados usan siempre `googleConversionDiagnosticsBroker`, incluido
un error o UUID ausente; nunca pasan al transporte antiguo. Una consulta SQL
estática de presencia JSON evita seleccionar pendientes legacy sin marca. La
frecuencia/límite anteriores se conservan; no se crea ni activa un job nuevo.

El adaptador carga UUID y mapping del journal, exige la identidad de firma y el
corte originales, prepara un contexto Ads actual y llama exclusivamente a
`coordinator.reconcile`. No reserva, reconstruye payload ni invoca ingesta.
La política de lectura vuelve a comprobar clínicas activas, conexión/scopes,
instalación y destino habilitados, mandatos y fingerprints v1/v2/v3, y autorización
mejorada vigente si se enviaron hashes. También cubre conversiones configuradas
sin mandato. En nativos verifica identidad publicitaria persistida y receptor
actual sin consultar contactos o el cuerpo del lead. Una política distinta
durante la consulta impide guardar el resultado; los grants y configuración de
firma se revalidan alrededor de la operación.

Un ACK perdido puede recuperarse por el UUID propio y obtener el ID Google sin
volver a enviar. Sin recibo durable, permanece desconocido. Una reserva que no
llegó a enviarse permanece `prepared`: diagnóstico no la despacha ni consulta a
Google. El resumen expone `unconfirmed`; no suma esos casos como recibidos,
procesados o saltados. Un marcador sin journal/UUID necesita revisión, no un UUID
nuevo ni adopción de historia. La consulta normal no selecciona resultados
terminales; una llamada repetida autorizada devuelve su estado sin transporte.

`repository.diagnosticError` bloquea las mismas filas y comprueba digests de
identidad/auditoría antes de guardar un código acotado y mensaje fijo. No cambia
el estado ni habilita reintentos. Un fallo tardío nunca sobrescribe éxito,
metadata, fecha o historial terminales confirmados por otra consulta. Una
conciliación exitosa limpia el error previo. Ningún error de proveedor, token,
URL, contacto o payload se copia a esa metadata.

QA:52 grupos con MySQL8.0.42 propio, servicio de lote real, resolutores actuales,
coordinador SQL y broker firmado con SQLite.21 ingestas ficticias,51 comandos
firmados,25 journals,0 lecturas SQL de tokens y cierre limpio de todas las
instancias. Incluye selección por antigüedad, ACK perdido, ausencia de recibo,
reserva sin envío, v1/v2/v3/sin mandato, destino deshabilitado, pausas, revocación,
firmante ajeno, UUID intercambiado, cambios durante status y fallo concurrente
posterior al éxito. Salud consume la conciliación real; no hay UI autenticada.

Se preservan los fallos iniciales: reconstrucción incompleta de identidad nativa,
JSON path escapado incorrectamente por Sequelize y fixture de antigüedad que no
modificaba timestamps. La prueba legacy también dependía de modelos y proyecto
de cuota del entorno; ambos fallos se reprodujeron con el servicio anterior. La
fixture ahora declara identidad/registros vacíos y proyecto ficticio, conserva
el comprobador real y pasa sin leer `.env` o red operativa.

No se ejecutó `sync.jobs` completo: combina diagnóstico con reconciliación y
activación que aún requieren revisión. Sin DDL, despliegue, cambio de cohortes,
credenciales o tráfico real. Evidencia privada: `google-conversion-diagnostics/`.
Antes del corte: completar onboarding/acciones/leads e inventario Google
compartido, plan exacto del journal, despliegue completo, prueba autorizada del
proveedor y recorrido visual con sesión/MFA. Mantener ledger y UUID; nunca borrar
historia ni reactivar campañas, leads o jobs clínicos para intentar recuperar un
resultado desconocido.


## Validación de onboarding por broker, 18/09/2026

El listado público de acciones, el validador individual de Data Manager y la
comprobación compartida por onboarding/estrategias/auditoría interna ya admiten
runtime gestionado. `googleAdsOnboardingBroker` sólo expone listar, validar y
recomprobar autorización; no recibe cuerpo de conversión, clic, contacto, token
ni opciones de ingesta o mutación. El catálogo se obtiene por lectura tipada y
se conserva internamente: modificar la copia devuelta no autoriza otra acción.
Se mantienen nombre canónico único, dueño/resource, tipo, categoría, estado,
recuento y condición secundaria antes de validar WEB con datos ficticios.

Alrededor de cada lectura/página/validación se revalidan contexto opaco, identidad,
scopes, clínica activa y pertenencia al grupo, además del ámbito y ACL actual del
usuario. Una clínica con grupo padre sigue siendo un ámbito clínico: resolverla
no puede ampliar el conjunto de clínicas a todo el grupo. Las auditorías internas
sin sesión mantienen su grant durable y política clínica, no una credencial de
usuario simulada. El resultado final de la comprobación compartida vuelve a
invalidar evidencia de cualquier cuenta cuyo ámbito haya cambiado.

El proceso CRM no necesita declarar el proyecto de cuota del broker: sólo lo da
por confirmado tras una respuesta tipada positiva sin avisos. La comprobación
legacy también exige respuesta válida y sin avisos; antes podía marcar como
validada cualquier respuesta que no lanzara excepción. Un error managed jamás
recurre al transporte con token. La pérdida de ACL se comunica como403 y un
binding cambiado como409 en la lectura pública, sin confundirlos con un fallo
remoto ni revelar detalles de proveedor.

QA de este corte:49 pruebas Node (adaptador, código real del endpoint/ACL,
preparación y normalización), scripts legacy Data Manager y readiness PASS.
MySQL real propio pasa56 grupos, incluidos cuatro nuevos del controlador real
con broker firmado/SQLite: validación sin cuota local, acción ausente con creación
solicitada, clínica pausada y pausa concurrente con recuperación. El conjunto
mantiene21 ingestas ficticias,58 comandos,25 journals y cero lecturas SQL de tokens;
los nuevos casos de onboarding no ingieren eventos. Instancia cerrada0. El primer
ensayo del endpoint reveló un502 indebido para revocación de permisos; corregido,
fallo conservado en evidencia. Estas pruebas no incluyen sesión/MFA ni UI real.

La [base tipada de creación/normalización](google-action-management-broker.md)
ya está preparada y probada en broker/cliente, con planes y bloqueos durables.
Su conexión a los endpoints con permisos globales de cuenta y propiedad durable
en CRM conserva su aceptación operativa pendiente. El enriquecimiento y bootstrap
ya están preparados en el corte del 19/09 descrito debajo, sin publicar.
Si se solicita crear una acción que
falta, el nuevo recorrido devuelve una necesidad de revisión explícita y no
intenta OAuth local ni afirma estar listo. Este límite es temporal y bloquea el
corte de Google: hay que conservar esas funciones con operaciones tipadas antes
de activar el nuevo runtime. También faltan sync tipado de leads, revisión del
job mixto y el inventario completo de la identidad compartida. No se ha publicado,
aplicado DDL, alterado un grant/token/flag ni llamado a un proveedor real.
Evidencia privada: `google-onboarding-validation/`; recuperación operativa sigue
siendo conservar runtime/flags actuales, journal e historial sin replay.


## Consumidor humano de revisión de recibos

El contrato HTTP, controles y rollback vigentes se describen en
[13-backend](../../src/Documentacion/13-backend.md#revisión-humana-de-recibos-de-google-18092026).
`googleConversionReceiptReview.service` utiliza el diario SQL existente y dos
capturas del outbox por lectura completada; no añade otra cola ni servicio.
Revisar envíos, desde el diálogo de conversiones, lista páginas de 20, muestra
observaciones guardadas y consulta solo por acción explícita. Sin polling,
resend, datos de pacientes ni tokens. El backend permite la consulta de recibos
con sesión renovada y escritura vigente sobre toda la cuenta, sin depender de
quién inició el envío original. No amplía el acceso a bindings desconectados.

QA: MySQL real aislado para diario, permisos, transacciones y EXPLAIN; proveedor
y sesiones ficticios. Las respuestas remotas de este consumidor se simulan con
el contrato real Data Manager; la primitiva firmada/SQLite/HTTPS conserva su QA
separada. Chromium ejecuta los componentes Angular y HTTP reales con API ficticia,
escritorio/móvil, pérdida de acceso, respuesta sustituida y doble clic. El visor
v19 se prueba además con SQL y lectura firmada/versionada de objetos ficticios.
No demuestra aún el recorrido con proveedor real y sesión pública en AWS.
El 19/09 se añadió un recorrido unido de Angular, API HTTP, sesión SQL real y
broker HTTPS/SQLite: autorización, cuatro ingestas ficticias, retirada, reinicio,
consulta con sesión renovada y resultados SUCCESS/PARTIAL_SUCCESS. La UI consume
esa misma API, no una API simulada. Un ACK perdido se recupera por otra lectura;
revocar la sesión durante SUCCESS conserva la fila CRM y devuelve 401.
El consumidor revalida acceso tras un error saneado del cliente, sin reintento.
Cero tokens OAuth hidratados desde MySQL, proveedor/Secrets Manager/S3 ficticios.
Evidencia adicional: `qa-evidence/security-resume-20260917/audit-v19-preparation/`.
Evidencia privada: `qa-evidence/security-resume-20260917/google-receipt-review-20260918/`.


## Bootstrap y ajustes de cuenta por broker (19/09/2026)

Contrato vigente en [13-backend](../../src/Documentacion/13-backend.md#bootstrap-google-sin-credenciales-locales-19092026).
`conversion_settings.read.v1` es una lectura de una cuenta, sin paginación ni
mutación. Campos del proveedor contrastados con [Customer v24](https://developers.google.com/google-ads/api/fields/v24/customer)
y [ConversionTrackingSetting](https://developers.google.com/google-ads/api/reference/rpc/v24/ConversionTrackingSetting).
La cuota es metadata del binding propio: una respuesta Google no puede activarla.
En cohorte Ads de solo lectura se devuelve false; un proyecto local no lo suple.
No se ha añadido el permiso a ninguna política operativa ni migrado una cuenta.

Pruebas: 621/621 broker Node24; 49/49 lector/adaptador Node18 (58/58 incluyendo ámbito); scripts legacy
Data Manager y activación mejorada offline. Siete grupos integrados MySQL/HTTP/TLS,
22 comandos de lectura y cuatro capturas Chromium del asistente real/tarjeta Web;
cero ingestas, mutaciones Google, hidrataciones OAuth locales o accesos externos.
La tarjeta Web usa la plantilla exacta y el resultado del asistente; no es una
prueba de toda la navegación Web ni aceptación pública/MFA/Google real.
Las comprobaciones de configuración no sustituyen validate-only ni autorización.

Rendimiento: la primera apertura pasó de 198 a 105 sentencias SQL (−47 %),
de 539 a 208 ms en MySQL propio. El lector comparte sus dos comprobaciones
frescas por consulta de ajustes con el adaptador; conserva identidad del mapping,
ACL/sesión/scopes/estado clínico y revalidación final, sin caché entre peticiones.
Ocho aperturas simultáneas con 100 ms de latencia ficticia: 840 sentencias,
mediana 641 ms, máximo 813 ms, ocho lecturas firmadas y pool sin ocupación/esperas
al terminar. Casos de revocación y las cuatro capturas repetidos correctamente.
No acredita carga sostenida, cardinalidad ni latencia de proveedor reales.
El límite de concurrencia/plazo evita una ráfaga ilimitada al broker por petición;
no garantiza CPU, aislamiento entre peticiones ni una cuota global de proveedor.

Antes del corte: publicar operación y consumidor conjuntamente, revisar grants,
conservar las comprobaciones frescas compartidas, medir carga con cardinalidad
y latencia reales, completar leads/job combinado/identidad compartida y
aceptación autenticada. No activar envíos por el resultado de este GET. AWS v19
para recibos sigue siendo otro requisito pendiente, con sus candidatos conservados.
Rollback: conservar las releases actuales mientras no haya corte. Tras un corte,
retirar el grant de esta lectura o cerrar la cohorte afectada; preservar registro,
revocaciones, journals y auditoría. Nunca restaurar tokens locales o ejecutar una
versión legacy sobre una cuenta ya gestionada. No hay DDL propio de este tramo.
Evidencia privada: `qa-evidence/security-resume-20260917/google-bootstrap-settings-20260919/`.

## Job combinado: preparación integrada (19/09/2026)

Contrato en [13](../../src/Documentacion/13-backend.md#job-combinado-google-data-manager-preparado-19092026).
Se mantienen las cuatro fases y sus restricciones. Inventario sin tokens para
Enhanced/readiness; cuota del binding remoto; guards transaccionales después del
I/O, consentimiento y huella del IntakeConfig/HMAC vigentes. `stale_retry` no
devuelve readiness verdadero. El gate del broker se comprueba también al guardar.
No se activa cron ni se cambia la planificación de CRM.

La prueba `google_combined_diagnostics_mysql.integration.js` ejecuta el método
real del job con MySQL/SQLite y HTTPS firmados, Google/Secrets/S3 ficticios.
Incluye la primera pasada, consulta de un recibo previamente aceptado,
continuación de ese sondeo si fallan los ajustes, revocación en ambas fases que
persisten, pausa clínica, cierre del gate, cambios concurrentes de configuración
y HMAC, fallo de la segunda escritura con rollback de la primera e idempotencia.
El único envío ficticio lo crea expresamente el fixture para obtener el recibo:
ninguna ejecución del job ni recorrido visual reenvía o ingiere conversiones.

Chromium usa el asistente Angular real y la tarjeta exacta de Marketing Web con
la misma API/sesión MySQL/broker. Cuatro capturas en 1440/390 px; ocho peticiones
`validateOnly` nuevas en el navegador, sin otras escrituras ni llamadas externas.
No es una prueba de toda la navegación Web ni aceptación de MFA/proveedor públicos.
La UI del bootstrap mantiene consultas legacy de Meta; se contabilizan aparte
y no se atribuyen al job. Google conserva cero hidrataciones locales de OAuth.

El job realiza bastantes comprobaciones SQL de identidad/ámbito, especialmente
en la primera pasada. Las cifras en 99 separan primera preparación y sondeo de
un recibo. Pool drenado al terminar y ningún I/O de proveedor bajo transacción;
no demuestra capacidad con muchas estrategias/cuentas, carga concurrente real
ni aislamiento de CPU. Las fases siguen secuenciales y el barrido histórico de
estrategias activas necesita una medición con cardinalidad real.

Antes de publicar: conservar gates/pausas actuales, verificar el esquema de todos
los consumidores y publicar operaciones de ajustes/validate/status compatibles.
Revisar la política Enhanced del binding, sus digests y autorizaciones originales:
que el job complete su configuración local no habilita por sí solo identificadores
en el broker. Continúan pendientes leads, identidad compartida, publicación AWS
v19 de auditoría y aceptación con sesión/proveedor reales. Cero cohortes operativas
migradas. Sin DDL nuevo ni variables nuevas en este tramo.

Recuperación: una carrera deja explícito `stale_retry`/bloqueo/fallo; revisar el
estado actual y solicitar otra conciliación solo cuando la causa esté resuelta.
No restaurar una instantánea vieja de config/HMAC/estrategias para forzar éxito.
Tras un eventual corte, cerrar la cohorte/job afectado conservando el último
runtime compatible y todos los journals/recibos. No reactivar OAuth local ni
usar rollback que omita las comprobaciones al guardar. Mientras no se despliegue,
las releases operativas previas permanecen como baseline.

Evidencia privada: `qa-evidence/security-resume-20260917/google-combined-diagnostics-20260919/`.
