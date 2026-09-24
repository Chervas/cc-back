# PUBLIC_MEDIA autorizado

## Estado

El contrato, el consumidor y el runtime DEV estan operativos desde el
24/09/2026. La unidad `clinicaclick-public-media@dev.service` sirve la identidad
`public-media-dev:8455`; la API DEV solo puede alcanzar ese puerto desde su UID
aislado y usa una clave Ed25519 propia. `PUBLIC_MEDIA_BROKER_REQUIRED=true`
mantiene el fallo cerrado. La API CRM no conserva access keys historicas ni
puede usar IMDS.

El primer caso admitido es `marketing_image`, usado por el editor de plantillas
de email. Lectura publica sigue en `https://media.clinicaclick.com`; la subida
usa una operacion broker distinta de SES, WhatsApp y auditoria.

## Recorrido

1. `POST /api/public-media/upload` autentica al usuario, resuelve clinica/grupo,
   exige `non_clinical_asserted`, cuota y finalidad.
2. `publicMediaStorage.service.js` decodifica la imagen con Sharp, la vuelve a
   codificar como WebP y elimina EXIF, GPS, XMP y bytes anexos.
3. `publicMediaBroker.service.js` firma
   `storage.public-media.email-image.put.v1` con el `requestId` estable.
4. El broker vuelve a comprobar scope, MIME, firma binaria, tamano y SHA-256.
5. El broker genera la key; el caller no puede elegir bucket, region, ARN, host
   CDN o ruta S3.
6. S3 recibe un unico `PutObject` con `If-None-Match: *`. El recibo broker guarda
   solo key, URL, MIME, tamano, hash y ETag; no persiste el binario.
7. CRM persiste `PublicMediaAsset` y devuelve la URL publica al editor.

## Limites fijos

- Bucket: `clinicaclick-public-media-eu-west-3`.
- Cuenta esperada: `137819318729`.
- CDN: `https://media.clinicaclick.com`.
- MIME: JPEG, PNG o WebP.
- Finalidad inicial: `marketing_image`.
- Tamano binario maximo broker: 8 MiB; el editor limita a 3 MiB.
- Dos peticiones concurrentes y 24 MiB maximos pendientes por proceso.
- Sin ACL publica, redirects, proxy generico, delete ni invalidacion.
- Keys inmutables bajo `marketing/email/{clinic|group}-N/YYYY/MM/UUID.ext`.

## Identidades e IAM

La unidad debe ejecutarse en la EC2 de seguridad con Node 24 y una identidad OS,
certificado TLS, clave Ed25519 y SQLite propios. La politica contiene un grant
exacto por `clinic:N` o `group:N`; no hay comodines. La API solo conserva la
clave cliente para invocar esos grants y nunca una credencial AWS.

La primera instalacion usa `public-media-dev` en `8455`, usuario/grupo
`cc-public-media-dev`, configuracion
`/etc/clinicaclick-public-media-dev/config.json`, estado privado
`/var/lib/clinicaclick-public-media-dev` y release
`/opt/clinicaclick-public-media/current`. El publicador y el firmante contienen
trece hojas de servidor; el estado sano completo contiene catorce filas al sumar
el cliente de mantenimiento.

El proceso verifica primero el rol de instancia conocido y despues asume
`arn:aws:iam::137819318729:role/clinicaclick-public-media-prod-writer-role`.
Ese rol solo necesita:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": "s3:PutObject",
    "Resource": "arn:aws:s3:::clinicaclick-public-media-eu-west-3/marketing/email/*"
  }]
}
```

La confianza debe admitir solo el rol de instancia fijado en
`public-media-main.js`. Auditoria usa el rol writer de auditoria existente y no
comparte permisos con el bucket de medios.

## Configuracion del consumidor

Variables no secretas/sensibles de ruta:

```text
PUBLIC_MEDIA_BROKER_ENABLED=true
PUBLIC_MEDIA_BROKER_REQUIRED=true
PUBLIC_MEDIA_BROKER_ENVIRONMENT=dev|staging|prod
PUBLIC_MEDIA_BROKER_ORIGIN=https://HOST:PUERTO
PUBLIC_MEDIA_BROKER_CONNECTION_REF=public-media:ENTORNO
PUBLIC_MEDIA_BROKER_AUDIENCE=clinicaclick:public-media:ENTORNO:v1
PUBLIC_MEDIA_BROKER_KEY_ID=IDENTIDAD_APROVISIONADA
PUBLIC_MEDIA_BROKER_KEY_FILE=/ruta/privada/cliente-ed25519.pem
PUBLIC_MEDIA_BROKER_CA_FILE=/ruta/privada/ca.pem
```

`PUBLIC_MEDIA_BROKER_REQUIRED=true` se activa al cortar cada entorno. Impide que
un error de configuracion restaure silenciosamente el SDK AWS directo. Las rutas
legacy de otras finalidades deben migrarse expresamente antes de retirar su
transporte; no ampliar este grant para cubrirlas por conveniencia.

## Aceptacion

1. Ejecutar con Node 24:
   `node --require ./test/offline-guard.cjs --test --test-concurrency=1 test/public-media-runtime.test.js`.
2. Ejecutar la suite completa del paquete broker.
3. Validar arranque con politica DEV y sin variables `AWS_ACCESS_KEY_ID` o
   `AWS_SECRET_ACCESS_KEY` en CRM.
4. Comprobar desde DEV que `8455` es accesible y que `8454`, otros puertos y el
   proveedor directo siguen rechazados.
5. Subir una imagen inocua desde el editor, comprobar objeto/key/metadata y
   `PublicMediaAsset` del mismo scope.
6. Repetir el mismo `requestId` y acreditar un solo `PutObject`.
7. Probar scope ajeno, MIME falso, hash alterado, exceso de tamano, broker caido
   y auditoria llena; todos deben fallar antes de una URL utilizable.
8. Verificar carga CDN y render en la previsualizacion del email.

Rollback: desactivar la UI de subida o mantener fallo cerrado. No restaurar
credenciales AWS en API, worker, navegador o `.env` historico.

## Corte DEV verificado, 24/09/2026

- CloudFormation termino `UPDATE_COMPLETE` al crear exclusivamente el rol
  `clinicaclick-public-media-prod-writer-role`, su permiso de asuncion desde el
  rol EC2 fijado y la regla `sgr-0146d3df108e7d7f6` para
  `51.44.225.192/32:8455`.
- La simulacion IAM permite solo `s3:PutObject` bajo `marketing/email/*`;
  `GetObject`, `DeleteObject`, `PutObjectAcl` y `ListBucket` siguen denegados.
- El servicio ejecuta Node 24 como `cc-public-media-dev`, sin access keys y con
  estado/configuracion/certificado propios. Asumio los roles writer de medios y
  auditoria, mantiene `NRestarts=0` y drena auditoria a cero pendientes.
- La hoja inicial se firmo sin exportar la clave privada de AWS. Una renovacion
  real cambio la huella a
  `c6b6bff79c31af2fe62f2f9b77c5597a0647492f5430889c78cdd023a58e12b8`
  mediante recarga TLS, conservando el PID. El inventario final quedo `14/14`.
- Una subida autenticada desde el editor devolvio `201`, creo
  `PublicMediaAssets.id=1775` para `clinic:1`, recodifico PNG a WebP y se sirvio
  por CloudFront con hash y metadata S3 coincidentes. La previsualizacion real
  termino sin spinner ni snackbar y cargo la imagen.
- Repetir un `requestId` devolvio el mismo objeto con `replayed=true`. Un scope
  `clinic:2` devolvio `scope_denied` y un WebP declarado como PNG devolvio
  `invalid_request`.

Este corte acredita solo `marketing_image` en DEV. Las demas finalidades legacy
siguen fuera del broker y no heredan este grant.
