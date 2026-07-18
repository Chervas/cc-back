# Adaptador offline ModSuite a WebDocument v1

## Finalidad y alcance

Este adaptador permite evaluar y trasladar una exportación JSON de ModSuite al contrato canónico `WebDocument v1` sin ejecutar el backend legacy ni depender de él en runtime.

Es una herramienta de migración offline y controlada. No publica, no despliega, no escribe en base de datos, no llama a Internet y no descarga medios. La salida queda en `noindex` y en modo previo hasta que una persona resuelva las revisiones, los medios, el consentimiento, la configuración legal y la captación.

La implementación es una reescritura limpia. El repositorio de ModSuite solo se utilizó como fuente de observación del formato de datos. No se ha copiado código, HTML, CSS, clases ni assets legacy.

## Formatos de entrada reconocidos

El módulo acepta valores JSON planos con uno de estos envoltorios:

- configuración directa con `pages`, `header` y `footer`;
- una página o bloque con `content`;
- un catálogo JSON en forma de array;
- un objeto con `configuration` que contenga JSON serializado;
- un objeto con `wp_cast`.

`--page` permite seleccionar una página por su nombre visible o por su identificador nominal legacy, por ejemplo `Equipopage`. La selección no depende de los identificadores numéricos legacy.

La entrada completa está limitada a 5 MiB, 40 niveles y 100.000 propiedades. Solo se admiten objetos JSON planos; se rechazan ciclos, getters, setters, valores no finitos y prototipos ejecutables.

## Mapeo permitido

El adaptador usa una allowlist cerrada:

| Nodo ModSuite | Resultado WebDocument | Tratamiento |
| --- | --- | --- |
| `container` | `section` | Estructura aproximada; estilos y clases se descartan. |
| `row` | `section` | Se aproxima a fila o grid, con un máximo de cuatro columnas. |
| `col` | `section` | Se conserva la jerarquía segura, no su presentación. |
| `text` | `heading` o `text` | El HTML se convierte en texto plano; nunca se conserva markup. |
| `image` | `image` | Se crea un placeholder de asset nuevo; no se conserva la URL del medio. |
| `button` | `button` | Solo se conservan destinos seguros y reconocibles. |
| `contacto` | `intake_form` | Se aproxima al contrato de captación y siempre exige revisión. |

Los wrappers desconocidos se omiten, pero sus hijos allowlisted se recorren y se conservan. Los widgets dinámicos conocidos —mapas, reseñas, sliders, menús, vídeo, contenido de WordPress y similares— se marcan para revisión hasta que exista un bloque nativo equivalente. Cada nodo origen produce una entrada en el informe; no hay pérdidas silenciosas.

## Estados del informe

Cada entrada de `report.nodes` usa uno de estos estados:

- `migrado`: existe equivalencia segura sin decisiones pendientes;
- `aproximado`: se conserva el contenido o estructura, pero se descarta presentación legacy o se aplica una aproximación;
- `omitido`: no existe equivalencia allowlisted o el valor queda vacío/no seguro;
- `requiere_revision`: hay una salida parcial o una decisión manual imprescindible.

Cada entrada contiene únicamente la ruta estructural de origen, un tipo normalizado, los IDs nuevos de destino y códigos de incidencia. El informe no copia contenido, secretos, CSS, clases ni URLs de medios. Cuando ayuda a reconciliar un asset, incluye como máximo su huella SHA-256.

## Invariantes de seguridad

- El HTML visible se decodifica y convierte en texto plano.
- Se eliminan bloques `script`, `style`, `iframe`, `object`, `embed`, `svg`, `math`, templates y variantes incompletas o codificadas como entidades.
- No se importan campos de CSS, clases, estilos responsive, animaciones ni handlers legacy.
- No se aceptan URLs `javascript:`, `data:text/html`, HTTP, URLs con credenciales, puertos distintos de 443, hosts locales, IPs literales ni queries con claves sensibles.
- Las imágenes se representan como placeholders; su importación real debe validar derechos, MIME, tamaño y scope de clínica/grupo por el flujo de medios nativo.
- Los IDs se regeneran de forma determinista mediante SHA-256 a partir de la entrada canónica y de la ruta estructural. Los IDs legacy no se conservan.
- La salida pasa por `assertValidWebDocument`; si no cumple el contrato, no se genera ningún resultado válido.
- El adaptador en memoria no usa filesystem ni red. El CLI solo admite rutas locales.

## CLI local

```bash
node src/scripts/migrate_modsuite_web_document.js \
  --input /ruta/local/export.json \
  --output /ruta/local/web-document.json \
  --report /ruta/local/migration-report.json \
  --page Equipopage \
  --fail-on-review
```

Opciones relevantes:

- `--page <nombre>` se puede repetir;
- `--title` y `--slug` solo sobrescriben una selección de una página;
- `--locale` usa `es-ES` por defecto;
- `--force` sustituye únicamente ficheros regulares existentes;
- `--fail-on-review` escribe las dos salidas y termina con código 2 si hay nodos omitidos o pendientes de revisión.

La entrada y las dos salidas deben ser rutas distintas. No se sigue un enlace simbólico como entrada ni se sustituye un enlace simbólico de salida. Las salidas se escriben de forma atómica, con permisos `0600`. El proceso solo imprime el resumen; nunca imprime el documento o el informe completos.

## Resultado seguro por defecto

El `WebDocument` generado mantiene deliberadamente:

- SEO global en `noindex` y páginas con `index=false` y `follow=false`;
- consentimiento en `preview_mode=true`, sin URL ni versión legal;
- integraciones de captación, chat, WhatsApp y teléfono sin activar;
- assets legacy como referencias pendientes, no como medios publicados.

Por tanto, una migración técnicamente válida no equivale a una publicación aprobada. Los warnings del informe indican los gates que deben resolverse antes de permitir revisión final o publicación.

## Auditoría del formato real

La auditoría de solo lectura sobre el catálogo seleccionado confirmó la jerarquía `page/container/row/col/widget` y los tipos dinámicos esperados. Las cinco páginas de referencia produjeron documentos válidos sin persistir sus datos ni añadirlos como fixtures al repositorio:

| Selección legacy | Nodos origen informados | Nodos WebDocument |
| --- | ---: | ---: |
| `talaverapage` | 85 | 83 |
| `AbonoDentalpage` | 60 | 59 |
| `Equipopage` | 47 | 46 |
| `Tratamientospage` | 52 | 49 |
| `Postpage` | 28 | 25 |

La diferencia corresponde a widgets sin equivalente nativo o destinos/medios que requieren revisión; queda explicitada nodo a nodo en el informe.

## Pruebas

Los fixtures versionados son completamente sintéticos: uno representa el camino seguro y otro intenta introducir HTML ejecutable, CSS, clases, URLs locales, destinos `javascript:` y un secreto ficticio.

```bash
node -c src/lib/modSuiteOfflineAdapter.js
node -c src/scripts/migrate_modsuite_web_document.js
node -c src/scripts/tests/modsuite_offline_adapter.test.js
node src/scripts/tests/modsuite_offline_adapter.test.js
node src/scripts/tests/web_document_contract.test.js
```

Las pruebas cubren validez del contrato, determinismo, IDs nuevos, selección de páginas, envoltorios legacy, ausencia de fugas, política de URLs, rechazo de objetos ejecutables y seguridad de escritura del CLI.
