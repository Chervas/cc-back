# Alta operativa de WhatsApp a partir de un recibo

Contrato del 22/09/2026. Complementa [preparación automática](whatsapp-automatic-preparation.md),
[alta autenticada](whatsapp-onboarding-gateway.md) y [transporte](whatsapp-broker-messaging.md).
El consentimiento de Meta, por sí solo, no acredita registro del teléfono ni recepción.

## Recorrido y límites

`POST /api/whatsapp/onboarding/complete` recibe únicamente `requestId`. El gateway
verifica la sesión MFA actual, propietario del recibo, permisos sobre el ámbito,
conjunto completo de clínicas y ausencia de bloqueo. Puede retomar un recibo ya
confirmado aunque su ventana OAuth haya terminado; no convierte un intento sin
confirmar en una autorización válida. No acepta teléfonos, tokens, PIN ni ámbitos
nuevos desde el navegador.

El broker vuelve a comprobar identidad Meta, concesión, propietario y pertenencia
WABA/teléfono. El gateway crea una identidad independiente en `ClinicMetaAssets`
con `whatsappAuthorizationId`, sin fingir que pertenece al OAuth general de Meta.
`WhatsappPhoneActivations` conserva su estado y el corte temporal por número.
Los secretos permanecen en AWS.

Antes de suscribir el WABA, el broker registra la pertenencia de recepción y
publica una proyección sin secretos para el receptor. Registra el teléfono si
Meta confirma que está verificado y requiere registro; un teléfono ya conectado
con Cloud API no se vuelve a registrar. El PIN nuevo se conserva en una versión
inmutable separada de Secrets Manager, sin cambiar la versión de la credencial.
No se reinicia un PIN preexistente para forzar la conexión.

Una lease durable serializa la activación. Tras un timeout o error servidor de
resultado incierto se consulta el estado de Meta antes de decidir el siguiente
paso; no se repite ciegamente el registro. Se suscribe y verifica la aplicación
esperada en el WABA. Solo después se publica el estado activo y el remitente local.
La interfaz intenta completar el alta tras OAuth y permite retomarla mediante
«Completar conexión», sin repetir el consentimiento.

Si el registro agotó el plazo local, `registration_uncertain` no significa que
Meta lo haya rechazado: el proveedor puede haberlo completado. La consulta del
perfil permite distinguir `CONNECTED` del registro todavía pendiente. Retomar
el mismo recibo completa la suscripción y la proyección local, sin otro registro
cuando Meta ya lo da por conectado. Confirmar el rol elegido antes de activar un
alta clínica que pueda cambiar el primario efectivo.

El iframe libera su referencia a la ventana de Meta al recibir una autorización
completa, pero no la cierra: el usuario puede estar terminando pasos opcionales
de facturación. El cierre por cancelación, error o abandono de un intento aún
sin confirmar se conserva. Desmontar el iframe después del éxito no cancela el
recibo ni cierra la ventana de pago. La autorización no acredita que exista una
tarjeta válida ni que el teléfono esté operativo.

## Plazos y preparación de plantillas

El registro en Meta dispone de 60 segundos (antes 8). La activación completa
está limitada a 90 segundos, con lease de 120; el cliente del gateway espera
hasta 100 y el servidor del broker hasta 110. Las consultas ordinarias conservan
sus plazos cortos. Solo el perfil de transporte de alta puede ampliar el límite
y exclusivamente para `meta.whatsapp.onboarding.activate.v1`.

El frontend concede 150 segundos a `complete`, que incluye perfil y activación.
Nginx debe usar una ubicación exacta `/api/whatsapp/onboarding/complete` con
`proxy_read_timeout 180s`, conservando límites de cuerpo, cabeceras y ausencia de
logs del bloque de alta. El resto de ese bloque mantiene 35 segundos. Ningún
plazo amplía los 30 minutos de autorización ni permite repetir un registro incierto.

La proyección activa y un `JobRequest` de creación de plantillas se guardan en
la misma transacción SQL. La clave estable depende del recibo de activación:
reabrirlo no duplica trabajos terminados, fallidos o cancelados. El gateway dirige
ese trabajo al namespace de negocio configurado (staging en el público actual),
no inicia un worker propio. El worker existente concilia y prepara el catálogo
por WABA con su lease; Meta decide la aprobación. El alta conectada no garantiza
que sus plantillas ya estén aprobadas. Los fallos del job conservan su recuperación
habitual y no desencadenan envíos de prueba.

Las imágenes públicas de ejemplo se descargan en AWS con el identificador HTTP
`Clinicaclick-Template-Media/1.0`. El CDN de medios devuelve 403 si falta esa
cabecera. No se reenvían tokens al origen de la imagen ni se relajan HTTPS,
fijación DNS, destinos públicos, tamaño o rechazo de redirecciones. Tras un fallo
se concilian las versiones Meta antes de preparar las familias aún ausentes;
los placeholders fallidos se conservan sin fingir aprobación.

## Identidades, recepción y enrutamiento

- AWS: `/var/lib/clinicaclick-whatsapp-capture-scopes/scopes.json` contiene solo
  aplicación, teléfono, WABA y pertenencias. Escritor `cc-wa-onboarding`, lector
  `cc-whatsapp-inbox`; directorio 2750 y fichero 0640. El receptor no obtiene
  acceso a la base privada de altas ni a Secrets Manager por esta proyección.
- Servidor: `/var/lib/clinicaclick-whatsapp-catalog/connections.json`, directorio
  `ubuntu:cc-wa-importer` 2750 y fichero 0640. Escritura atómica bajo lock SQL;
  CRM e importador leen el catálogo, DEV no obtiene grants operativos.
- La proyección se reconstruye desde SQL al retomar el alta. Una fila preparada
  permite identificar recepción, pero no autoriza envío. El corte de un activo
  ya aceptado no se mueve al reabrir el formulario.
- Un número nuevo de grupo queda disponible para sus clínicas. No sustituye sus
  números propios ni activa remitentes por herencia implícita. La clínica elige
  en `PUT /api/whatsapp/routing` su primario y secundario; una selección guardada
  es completa, por lo que secundario vacío significa ninguno.
- El guardado verifica sesión, permisos, pertenencia y grants antes de modificar
  bindings. Una transacción engloba selección y auditoría; un fallo revierte
  ambos. No cambia la adscripción del activo propio. En ámbito grupo se conserva
  la configuración particular de las clínicas.
- Auditoría v26: `integration.whatsapp.activate` y `integration.whatsapp.routing`,
  solo referencias de actor, sesión, ámbito, activos y motivo permitido.

La activación no libera comunicaciones retenidas ni modifica el corte de
recuperación del 22/09 a las 14:00:37.706955Z. No reproduce mensajes históricos,
no genera mensajes a pacientes y no cambia los flujos de confirmación de citas.

## Publicación y recuperación

Publicar lectores de auditoría antes de escritores v26; después recepción y
transporte, esquema/catálogo, importador y gateway. Flags: broker de alta y envío
`activationEnabled`; gateway `WHATSAPP_ACTIVATION_ENABLED=true`.

Migración `20260922153000-create-whatsapp-phone-activations.js`: columna nullable
para la conexión general, autorización única, triggers de identidad y journal.
MySQL con binary log requiere identidad de mantenimiento para crear esos triggers.
Usar la credencial administrativa local, sin dar SUPER a la aplicación ni cambiar
`log_bin_trust_function_creators`. La DDL no es transaccional: ante un fallo
conservar evidencia del punto alcanzado y retomar únicamente la misma migración
revisada. DEV usa plan, checksum y journal del operador, con su servicio detenido.

Rollback de código conserva catálogos, secretos y recepción. La migración rechaza
su retirada si hay activos independientes o activaciones; no desregistrar el
número ni eliminar la candidata como rollback. Si la publicación del catálogo
falla después del commit SQL, retomar el mismo recibo para reconstruirla.

## Verificación

Pruebas aisladas: SQL real propio, restricciones de identidad, reanudación sin
segunda activación, corte inmutable, atomicidad del enrutamiento, fallo de auditoría,
sesión/pertenencias; broker TLS y PIN separado; rechazo de registro incierto.
Chromium con componentes reales: diálogo en escritorio/móvil, reanudación y
selección del número de grupo conservando el propio. Las pruebas sintéticas no
acreditan entrega externa. Registrar por separado aceptación Meta real, lectura
de la tarjeta y prueba de envío/recepción con un destinatario de pruebas autorizado.

## Actualización del catálogo y destino compartido

El importador lee la configuración y el catálogo al comienzo de cada ciclo. Una
nueva activación no requiere reiniciar el proceso. Si esa configuración deja de
ser legible, no se reutiliza una copia antigua ni se vuelve al piloto. La misma
instantánea se contrasta antes de guardar cada hijo del lote; si cambia, se aplaza
sin ACK y el siguiente ciclo parte de la configuración vigente.

El número compartido resuelve el contacto mediante una vinculación existente en
`WhatsappInboxContactKeys`, específica de teléfono receptor, contacto y clínica.
Si no existe, admite evidencia de una única clínica que haya enviado desde ese
mismo número; después, una única conversación coincidente. Múltiples candidatos,
vinculaciones contradictorias o ausencia de destino quedan como `review_required`.
No elegir la clínica más reciente ni crear vinculaciones para hacer pasar una prueba.
Un destino explícito requiere decisión del titular y validación de pertenencia;
la resolución manual desde interfaz todavía no está aceptada. Los eventos
retenidos siguen participando en la salud de recepción y pueden retener acciones
por falta de respuesta en sus clínicas; nunca confirmar un recibo para ocultarlos.

La proyección de captura usa `fchmod(0640)` antes del rename, también bajo UMask
0077. La auditoría de la activación acepta el ejecutor de control anterior que
no pasa política por invocación, utilizando su política validada al construirlo.
Pruebas específicas verifican ambos contratos de despliegue.

La UI distingue metadatos de Meta no facilitados de fallos confirmados: los
primeros no son acciones pendientes y no generan una barra porcentual engañosa.
El estado de registro comprobado se conserva. Aceptación real y límites actuales
en el manual central, documento 19; capturas y publicaciones en 99.


## Secundario común sin sustituir primarios

`PUT /api/whatsapp/routing/secondary` recibe ámbito, activo secundario, usos y
conducta ante fallo. Exige sesión, permisos sobre todas las clínicas y grants
actuales para el teléfono. En ámbito grupo actualiza los bindings secundarios de
sus miembros en una sola transacción con la auditoría v26; en ámbito clínica
solo modifica esa sede. No acepta `primaryAssetId`: conserva explícitamente los
primarios actuales, incluidos los heredados y la ausencia de primario.

Si el activo elegido ya es primario explícito o efectivo por herencia, rechaza
la operación antes de escribir. Los candidatos se contrastan bajo bloqueo SQL.
Una repetición actualiza las mismas selecciones sin duplicarlas. No cambia OAuth,
registro de Meta, corte temporal, pausas clínicas ni colas. El contrato completo
`PUT /routing` sigue permitiendo cambiar primario y secundario juntos.

Prueba aislada de la API pública: `WHATSAPP_ROUTING_ONLY_TEST=true CAMPAIGN_OPTIMIZATION_MYSQL_TEST=1 node src/scripts/tests/whatsapp_activation_mysql.integration.js`. El modo completo
se ejecuta en DEV, donde está disponible el servicio de activación. Ninguna
modalidad utiliza la BD clínica real ni carga workers del runtime público.
