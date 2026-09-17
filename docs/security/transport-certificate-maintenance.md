# Mantenimiento de certificados entre ClinicaClick y AWS

> **Tipo:** runbook.
> **Fuente de verdad:** preparación, verificación y recuperación de certificados de transporte; no tokens de Meta/Google.
> **Última revisión:** 2026-09-17.
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
