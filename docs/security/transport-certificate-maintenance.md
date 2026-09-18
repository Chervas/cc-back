# Mantenimiento de certificados entre ClinicaClick y AWS

> **Tipo:** runbook.
> **Fuente de verdad:** preparación, verificación y recuperación de certificados de transporte; no tokens de Meta/Google.
> **Última revisión:** 2026-09-18.
> **Estado y prioridad:** manual central [19](https://github.com/Chervas/cc-front/blob/dev/src/Documentacion/19-estado-actual.md#seguridad-de-acceso-e-integraciones) y [16](https://github.com/Chervas/cc-front/blob/dev/src/Documentacion/16-roadmap.md#seguridad-de-acceso-e-integraciones).

## Límites

- No genera, renueva, sustituye ni revoca credenciales de proveedores.
- No envía mensajes ni repite operaciones de negocio. El probe usa una ruta inválida del inbox: exige TLS válido y `403 operation_denied`, que demuestra reconocimiento de la identidad. `scope_denied`, timeout o cualquier otra respuesta son fallo.
- No desplaza la clave privada de la autoridad ni las de clientes/servidores. La CA permanece en el host de ClinicaClick, bajo root. Nunca copiarla al repositorio, al frontend ni a la EC2 de negocio.
- El publicador conserva sujetos, claves, roles, CA, destinos y permisos de ficheros. Renovar la fecha de un certificado no cambia el ámbito de una clínica.
- La renovación local de clientes no equivale a renovar los certificados de los servidores AWS ni la CA. Estos requieren su propio despliegue y evidencia; no presentar el temporizador local como cobertura completa.

## Recarga en servidores

Los entrypoints de auditoría, Google y WhatsApp admiten de forma opcional:

```json
{"tlsRenewal":{"issuerCaFile":"/ruta/privada/ca.crt"}}
```

No habilitarlo sin comprobar CA, firma, vigencia y correspondencia con el certificado inicial. El módulo lee un fichero privado fijo cada minuto o al recibir `SIGHUP`. Solo instala una hoja firmada por la CA fijada al arrancar, con la misma clave pública, sujeto, SAN y usos. No acepta cambios de CA ni claves a través de esta vía. Una hoja con menos de un día de vigencia restante se rechaza como reemplazo.

La recarga modifica los nuevos handshakes TLS sin cerrar peticiones abiertas. Si falla la lectura/validación se conserva el contexto anterior y se escribe un evento saneado `tls_certificate_maintenance`, deduplicado mientras el estado no cambia. Esto por sí solo es diagnóstico de journal, no una notificación de producto: se necesita un comprobador externo de vigencia y entrega de alertas.

`services/integrations-broker/src/tls-reload.js` es la fuente del módulo. Su copia byte a byte en `services/platform-audit/src/tls-reload.js` permite instalar artefactos independientes; una prueba impide divergencia. Al editar el módulo, sincronizar ambas copias y ejecutar las pruebas.

Los certificados autofirmados originales de auditoría requieren preparar primero la confianza de sus clientes antes de cambiarlos a una CA. No apuntar `issuerCaFile` a una CA distinta esperando que el módulo acepte automáticamente esa migración.

Los clientes HTTPS de escritura, consulta y reconciliación vuelven a leer su
fichero privado de confianza antes de cada conexión. Conservan en memoria el
destino y la identidad de firma iniciales. Un fichero ausente, con permisos
abiertos o enlazado simbólicamente impide la petición; no hay reintento ni
desactivación de la validación TLS. Las peticiones ya abiertas conservan su
contexto. Esta capacidad requiere publicar el cliente nuevo: modificar el
fichero en un proceso anterior no actualiza la confianza guardada en memoria.

Para la primera transición de auditoría, publicar primero una confianza doble
(certificado autofirmado anterior y CA nueva) en cada consumidor real. Emitir
una hoja de servidor `CA:FALSE`, `serverAuth`, conservando clave, sujeto y SAN;
las hojas originales `CA:TRUE` no deben convertirse en autoridades subordinadas.
Ese cambio de usos es una migración inicial revisada, no una renovación ordinaria.
Después de validar servicios, reconciliación y recepción de auditoría, retirar
la confianza antigua; conservarla como respaldo para una recuperación explícita.
No retirar un certificado del fichero y asumir que un cliente antiguo dejó de
aceptarlo. El ensayo `audit_client_trust_transition.test.js` verifica con TLS real
local ambas fases, renovación, vuelta atrás, peticiones en curso y rechazos para
los tres usos. No acredita por sí solo el despliegue AWS ni la interfaz autenticada.

## Identidades mTLS del inbox

El formato existente de `principals` mantiene `certificateSha256`. Puede añadir `publicKeySha256`, calculado exclusivamente desde el certificado ya autorizado, como SHA-256 del SPKI DER.

Cuando está configurado, se autentica la clave pública junto con la cadena TLS, vigencia y propósito de cliente. Esto permite renovar el certificado usando esa misma clave sin reconfigurar el rol. Sin ese campo se mantiene la huella exacta anterior. Se rechazan claves compartidas entre roles, identidades ambiguas, nuevas claves no autorizadas y peticiones de gateway a rutas del importador, y viceversa.

Antes de activar la renovación:

1. Contrastar los dos certificados del host con las huellas que AWS tiene autorizadas.
2. Añadir sus SPKI exactos al inbox y publicar el servidor compatible, conservando ámbitos, consumidores y límites.
3. Publicar `whatsappInboxClient.js` en gateway y en la release aislada del importador. El cliente lee el nuevo certificado sin reiniciarse; conserva la CA y clave iniciales y drena las peticiones del agente anterior.
4. Probar las dos identidades y sus rechazos cruzados. No cambiar todavía certificados si alguno falla.

## Renovación local de clientes

`ops/security/transport-certificates.py` funciona sin sesión SSO ni permisos AWS. Se ejecuta como root con configuración privada y destinos fijos de recepción. El modo ordinario comprueba ambos clientes y renueva únicamente cuando faltan diez días o menos. Firma por 30 días y rechaza una autoridad a la que le quedan menos de 31 días.

El despliegue debe fijar:

- CA y clave de firma locales; huella DER de la CA esperada.
- Para gateway y staging: rutas `client.crt`/`client.key`, CN exacto y SHA-256 del SPKI.
- Directorio de estado root `0700` para lock, candidatos y respaldos de certificados públicos.
- Fichero `/var/lib/clinicaclick-transport-health/status.json`, root `0640`, grupo del monitor. El directorio de publicación no debe ser escribible por la aplicación.
- Temporizador systemd persistente de doce horas, con exclusión mutua y timeout. Un fallo no cambia automáticamente autorizaciones ni detiene clínicas.

Ejecutar primero con los certificados actuales y comprobar estado `healthy`. Para QA de una renovación real, `--force-role gateway|staging` permite renovar solo el rol escogido. No sustituye validaciones: comprueba el candidato contra el inbox antes de publicar, comprueba otra vez tras el reemplazo atómico y restaura el anterior si falla. Guarda respaldo por huella; nunca lo elimina automáticamente.

La publicación de esta herramienta no instala ni activa el temporizador. Comprobar explícitamente unidad, timer, última ejecución y fichero de salud en el host destino.

Las unidades versionadas están en `ops/security/systemd/clinicaclick-transport-certificates.{service,timer}`. El enlace root `/opt/clinicaclick-transport-certificates/current` fija una release revisada; no apunta a un checkout escribible por el CRM. El timer ejecuta a las 00:00 y 12:00 UTC con hasta cinco minutos de dispersión y recupera ejecuciones perdidas. El servicio solo puede escribir los dos directorios de clientes, su estado y la metadata de salud; el filtro de red permite únicamente la IP del inbox. No lee una sesión SSO. Ejecutar una vez la unidad endurecida y verificar `Result=success` antes de habilitar el timer.

Gateway sigue ejecutando Node 18 y el importador Node 22. El cliente común usa las fechas X.509 compatibles con ambos; probar solo con Node 24 del broker no acredita la recarga de gateway. El evento `whatsapp_inbox_client_certificate` debe mostrar `reloaded` después de una renovación real. `reload_failed` conserva el certificado anterior en memoria, pero exige corregir el problema antes de su caducidad.

## Avisos y diagnóstico

El monitor de aplicación solo lee metadata saneada. Con `TRANSPORT_CERTIFICATE_MONITOR_ENABLED=true`, el activador **Certificados de comunicación** avisa de fallo, menos de siete días de vigencia o comprobación ausente/caducada (36 horas). Se integra con la notificación configurable `security.activity_detected`, sin pausa automática y sin ofrecer pausar una clínica.

El aviso conserva el certificado anterior; no garantiza que siga válido indefinidamente. Un fichero de estado inseguro, ilegible o con esquema incorrecto también produce alerta. La ausencia de alertas no acredita todos los certificados de AWS: este estado cubre los dos clientes mTLS del inbox.

Orden de diagnóstico: unidad/timer → fecha del estado → journal saneado → vigencia de CA y hoja → huella pública y rol del inbox → red/TLS. Nunca pegar `.key`, `.env`, configuración con secretos ni cuerpos de mensajes en tickets.

## Recuperación

- Si falla el probe previo, el certificado instalado no cambia.
- Si falla el probe posterior, se restaura el certificado anterior con sus permisos originales.
- Para volver a una release sin SPKI, restaurar primero los certificados cuya huella figura en la configuración anterior. De lo contrario, un rollback de código podría cortar la recepción.
- Restaurar un certificado aún válido y la configuración/release respaldadas; comprobar reconocimiento de ambas identidades antes de dar por recuperado el servicio.
- No borrar el inbox ni las colas y no reenviar mensajes para probar certificados.

## Pruebas reproducibles

Node 24, desde `services/integrations-broker`:

```sh
node --require ./test/offline-guard.cjs --test --test-concurrency=1 test/tls-reload.test.js test/whatsapp-inbox-runtime.test.js test/whatsapp-inbox-gateway.test.js
```

Desde la raíz backend:

```sh
sudo python3 ops/security/test-transport-certificates.py
node --test src/scripts/tests/transport_certificate_health.test.js src/scripts/tests/security_monitoring_pricing.test.js
node --test src/scripts/tests/whatsapp_inbox_client_tls.test.js
```

La prueba Python usa únicamente una CA y claves ficticias en `/tmp`; necesita root para probar las mismas restricciones de propietario del firmante. No usa AWS, Meta ni BD. La revisión visual del panel debe comprobar que el aviso lleva a Seguridad y que nunca ofrece pausar una clínica por este motivo.

Para clientes de auditoría, ejecutar también desde la raíz backend:

```sh
node --test src/scripts/tests/audit_client_trust_transition.test.js
```

## Certificados de servidores AWS

`server-certificates.py` firma únicamente hojas de las identidades fijadas en
su configuración root. La clave de cada servidor permanece en AWS; se obtiene
su certificado público por TLS validado y se conserva sujeto, SAN, clave y usos.
El firmante tiene un certificado mTLS propio, separado de gateway y CRM. Lo
renueva antes del vencimiento y comprueba su aceptación antes y después del
reemplazo local. La autoridad se comprueba por huella y correspondencia de clave
incluso cuando todavía no toca renovar ninguna hoja.

`server-certificate-publisher.py` recibe por HTTPS/mTLS exclusivamente el
identificador de un servidor autorizado y su nueva hoja pública. No acepta
claves privadas, rutas, comandos, nuevas identidades, certificados de otra CA,
retrocesos de vigencia ni peticiones del certificado de gateway. Usa el puerto
8450, restringido al host de ClinicaClick por SG y systemd. Tiene la CA pública;
no dispone de la clave de firma. Sus escrituras se limitan al directorio de
hojas enroladas y a respaldos de certificados públicos.

El publicador espera hasta 70 segundos a que el servidor presente la hoja nueva.
Si no ocurre, restaura la anterior. El firmante vuelve a comprobar el certificado
servido desde el host de ClinicaClick. Una respuesta perdida o discrepancia no
se presenta como éxito ni causa reenvíos de negocio. El propio publicador recarga
su contexto TLS al renovar; la verificación externa del firmante acredita el
nuevo handshake. Las claves y permisos permanecen sin cambios.

### Instalación y promoción

1. Preparar una identidad mTLS de mantenimiento independiente. Generar la clave
   del publicador en AWS y firmar únicamente su CSR público en el host de la CA.
2. Fijar por servidor su SPKI e identidad, puerto e IP. Copiar las hojas públicas
   a `/etc/clinicaclick-server-certificates/targets/<id>/server.crt`: directorios
   root `0711`, certificado `0600` del UID del servicio. La aplicación no debe
   poder sustituir el directorio de publicación.
3. Preparar cada release desde la que está realmente ejecutándose, preservando
   contrato, políticas, grants, ledger y versión de dependencias. Añadir recarga
   TLS y actualizar también los validadores que consumen configuraciones de otro
   servicio: `whatsapp-authorized` lee la configuración de `whatsapp-onboarding`.
4. Verificar `systemctl show ... -p WorkingDirectory -p ExecStart` **después** de
   `daemon-reload` y antes de cambiar el fichero de configuración/reiniciar.
   Un drop-in antiguo puede sobrescribir otro nuevo. Los cortes de servidor usan
   `zz-current-release.conf`; las promociones posteriores deben actualizar esa
   selección, con respaldo, y comprobar el valor efectivo. No acumular sufijos
   `99-zz...` ni asumir que el nombre del fichero determina la release activa.
5. Activar secuencialmente, comprobar TLS desde ambos hosts y probar renovación
   real antes de habilitar el timer. Si falla, restaurar configuración y selector
   de release; conservar el ledger, credenciales y colas.
6. El timer `clinicaclick-server-certificates.timer` comprueba a las 00:15/12:15
   UTC y publica `/var/lib/clinicaclick-transport-health/servers.json`. Su lista
   `expectedIds` debe coincidir con todas las identidades enroladas. El monitor
   con `SERVER_CERTIFICATE_MONITOR_ENABLED=true` alerta por un servidor fallido,
   próximo a vencer, ausente o un fichero de estado inválido/caducado.

No habilitar renovación sobre los certificados autofirmados de auditoría sin
migrar primero la confianza de todos sus clientes. Los nuevos servicios Google,
IA y correo deben enrolarse al desplegarse. La CA requiere su propio plan de
sustitución de confianza antes de vencer; este mecanismo no cambia esa raíz.
El estado publicado y los servidores realmente cubiertos se registran en 19;
esta sección define el procedimiento, no acredita un despliegue por sí sola.

Los puertos nuevos8451 y8452 quedan ligados respectivamente a `email-staging`
y `email-dev`, tanto en el firmante como en el publicador. Un identificador
ajeno, intercambio de puertos o destino nuevo8453 se rechaza. Estos nombres,
`ai-staging` y `bedrock-staging` también deben figurar en la lista cerrada del
lector de salud del CRM; de lo contrario una hoja válida produce una alerta
genérica de estado inválido. El lector conserva el rechazo de identidades
desconocidas y las alertas individuales de fallo/caducidad. El corte SES del
18/09 acredita dos renovaciones nuevas y nueve identidades sanas; no acredita
por ello la entrega de notificaciones dentro de una sesión autenticada.

Pruebas adicionales (CA ficticia, sin AWS ni proveedores):

```sh
sudo python3 ops/security/test-server-certificates.py
sudo python3 ops/security/test-server-certificate-publisher.py
```

### Sustitución planificada de la autoridad

La autoridad actual vence el **15/09/2027 a las 04:04:15 UTC**. El firmante
rechaza una autoridad con menos de 31 días de vigencia, pero esa protección no
la sustituye. Preparar la transición con al menos 90 días de margen; no esperar
al aviso de caducidad de una hoja. La huella fijada, el fichero de salud y los
recibos del publicador deben seguir correspondiendo a la autoridad realmente
instalada durante todo el corte.

1. Inventariar consumidores efectivos, incluidos workers y unidades aisladas,
   sus rutas de confianza, identidades mTLS, SPKI y recargas. Los entrypoints
   de servidor fijan la CA al arrancar: sustituir su fichero no cambia la CA
   en memoria. Tampoco cambia la huella de autoridad del firmante/publicador.
2. Crear la nueva autoridad exclusivamente bajo root en el host firmante.
   Distribuir solo su certificado público y preparar confianza doble en todos
   los clientes de servidores y validadores mTLS. Verificar que la identidad
   anterior sigue funcionando y que otra clave/rol sigue siendo rechazada.
3. Emitir hojas con los mismos SPKI, sujetos, SAN y usos. Preparar las nuevas
   configuraciones fijadas y sus respaldos; desplegar servidor por servidor,
   manteniendo las identidades antiguas aún válidas como recuperación. Probar
   recepción, consulta y operaciones tipadas con cada consumidor real.
4. Probar renovación por el temporizador, comprobación externa y alertas antes
   de retirar la confianza anterior. Confirmar qué procesos recargaron o se
   reiniciaron: un fichero actualizado no prueba el estado TLS en memoria.
5. Retirar la antigua autoridad únicamente al verificar todo el inventario y
   cerrar las conexiones anteriores. Documentar nueva huella, vencimiento y
   recuperación. Conservar los respaldos protegidos; no rotar por esta vía
   credenciales de proveedores ni repetir operaciones de negocio.

Este procedimiento no acredita una sustitución de la CA raíz. La transición de
los dos certificados autofirmados de auditoría a la CA ya existente es un corte
distinto; tampoco equivale a renovar credenciales de proveedores.

### Corte verificado de auditoría, 18/09/2026

Clientes DEV `4fbf4bda` y staging `2cb6a65c` publicados; candidata IA conserva el
arreglo en `88351630`. Los cuatro ficheros de confianza de staging/worker DEV
pasaron por confianza doble y terminaron con solo la CA existente. API DEV no
puede leerlos. Servidores AWS parten de sus respectivas releases reales:
`release-writer-tls-4fbf4bda` y `release-reader-tls-4fbf4bda`; solo se añade el
hook/módulo de recarga. Dependencias, grants, protocolos, claves y estado se
conservan. Cada reinicio inicial y comprobación duró aproximadamente tres
segundos. Posteriormente ambos renovaron realmente sin cambiar PID.

El publicador/firmante tiene diez servidores y la identidad de mantenimiento:
once estados sanos, unidad root `Result=success` y temporizador activo. Dos
rechazos de login visuales en DEV, más el del ensayo cuyo capturador agotó el
plazo esperando animaciones, produjeron tres eventos anónimos. El worker los
entregó por el escritor renovado y el lector verificó sus recibos; HEAD S3
independiente contrastó las tres versiones, SHA256 y clave KMS. No aumentaron
correos, desafíos MFA ni sesiones. Capturas 1440/390px inspeccionadas; no equivale
a una sesión autenticada ni al panel de actividad/automatizaciones.

Evidencia privada: `qa-evidence/security-resume-20260917/audit-certificates/`;
respaldos AWS: `/var/lib/clinicaclick-audit-tls-20260918/`. Para recuperar el
certificado autofirmado, restaurar **primero** la confianza doble en todos los
clientes y comprobarla; luego restaurar configuración/selector del servidor.
Restaurar también las listas del publicador/firmante para retirar exclusivamente
los destinos revertidos. No reemplazar SQLite, recibos, permisos ni claves. Una
recuperación entre hojas firmadas por la misma CA no exige volver al certificado
autofirmado. Los nuevos registros ya entregados se conservan siempre.
