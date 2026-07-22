# Buscador Comercial

PWA (Progressive Web App) para consultar precios y catálogo por código de producto, con escáner de código de barras y alertas de alzas/bajas de precio. Los datos se sirven desde un Google Apps Script.

## Estructura

```
index.html    Estructura de las 3 pantallas (buscador, detalle, listado)
style.css     Estilos
app.js        Lógica de la app (fetch a la API, render, escáner, toasts)
manifest.json Metadata de instalación como PWA
sw.js         Service worker: cachea el app shell para uso offline
icons/        Íconos de la PWA
fotos/        Fotos de producto por código (ej. 0012345.jpg)
```

## Cómo correrla localmente

Es una app estática, basta con servirla con cualquier servidor HTTP (no abrir el `index.html` con `file://`, porque el service worker y los fetch no funcionan así):

```bash
npx serve .
# o
python -m http.server 8080
```

## Configuración

La URL del Google Apps Script que sirve los datos está en `app.js` (constante `urlAPI`). El backend debe exponer:

- `?action=buscarCodigo&codigo=XXXXXXX` → detalle de un producto
- `?action=listarCategoria&categoria=SUBE|BAJA|MANTIENE` → listado por categoría

## Al desplegar un cambio

Si modificas `index.html`, `style.css`, `app.js` o `manifest.json`, **sube el número de `CACHE_VERSION` en `sw.js`**. El service worker cachea el app shell de forma agresiva (cache-first); sin ese cambio de versión, los usuarios que ya instalaron la PWA pueden seguir viendo la versión vieja hasta que limpien el caché manualmente.

## Ideas de mejora a futuro

- **Seguridad**: la URL del Apps Script queda visible en el cliente. Vale la pena revisar en el propio script qué controles de acceso tiene (autenticación, límite de requests, CORS) para evitar que se use para raspar el catálogo completo.
- **Búsqueda por texto en los listados**: hoy los filtros de "Alzas/Bajas/Sin Cambios" solo permiten filtrar por marca, género y tipo; un campo de búsqueda libre ayudaría en categorías grandes.
- **Manejo de "sin conexión"** más explícito, más allá de los toasts de error (por ejemplo detectar `navigator.onLine` y mostrar un banner persistente).
- **Íconos propios**: actualmente se usa un ícono genérico (`icons/icon-192.png` y `icons/icon-512.png`), conviene reemplazarlo por el logo real de la marca en ambas resoluciones.
- **Tests**: no hay ninguno. Si la lógica de parseo de precios/descuentos (`app.js`) crece, conviene testearla por separado (por ejemplo extrayéndola a un módulo con Vitest/Jest).
