#!/usr/bin/env bash

# Plantilla local de diagnóstico Meta para la clínica 19.
# Nunca guardar tokens reales en Git. Defínelos en el entorno o en un gestor
# de secretos antes de cargar este archivo.
export PAGE_ID="${PAGE_ID:-1268743159969545}"
export IG_ID="${IG_ID:-17841402810165989}"
export IG_ID_ALT="${IG_ID_ALT:-17841471435861700}"
: "${PAGE_TOKEN:?Define PAGE_TOKEN fuera del repositorio}"
: "${IG_USER_TOKEN:?Define IG_USER_TOKEN fuera del repositorio}"
export PAGE_TOKEN
export IG_USER_TOKEN
export SINCE="${SINCE:-2025-09-05}"
export UNTIL="${UNTIL:-2025-09-06}"

echo "Entorno Meta cargado para PAGE_ID=${PAGE_ID} e IG_ID=${IG_ID}"
