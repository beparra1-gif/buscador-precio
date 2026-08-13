# Buscador Comercial

PWA (Progressive Web App) para consultar precios y catálogo por código de producto, con escáner de código de barras y alertas de alzas/bajas de precio. Los datos se sirven desde un Google Apps Script.

## Estructura

```
index.html          Estructura de las 3 pantallas (buscador, detalle, listado)
style.css           Estilos
app.js              Lógica de la app (fetch a la API, render, escáner, toasts)
manifest.json       Metadata de instalación como PWA
sw.js               Service worker: cachea el app shell para uso offline
icons/              Íconos de la PWA
fotos/              Fotos de producto por código (ej. 0012345.jpg)
apps-script/Codigo.gs  Copia de referencia del backend de Google Apps Script (ver abajo)
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

- `?action=buscarCodigo&codigo=XXXXXXX` → detalle de un producto (hoja BASE PRECIOS)
- `?action=listarCategoria&categoria=SUBE|BAJA|MANTIENE|OBSOLESCENCIA&tienda=estandar|outlet` → listado por categoría. `OBSOLESCENCIA` filtra por la columna "Obsolescencia final" (= 50 o 100), ignora `tienda`. Las demás categorías filtran por `OBSERVACION STANDAR` u `OBSERVACION OUTLET` según el valor de `tienda` — el estado sube/baja/mantiene puede ser distinto entre canales para el mismo producto.
- `?action=listarTiendasEvento` → nombres de tienda distintos en la hoja Evento Outlet (columna A), para poblar el selector de "cuál tienda soy"
- `?action=buscarCodigoEvento&codigo=XXXXXXX&tiendaEvento=YYY` → detalle de un producto dentro del stock de una tienda de evento
- `?action=listarEvento&tiendaEvento=YYY` → todo el stock de esa tienda de evento (hoja Evento Outlet)

El código fuente de ese backend vive en Google Apps Script (fuera de este repo), no aquí. [`apps-script/Codigo.gs`](apps-script/Codigo.gs) es una **copia de referencia** para tenerlo versionado — pero **no se despliega solo**; cada vez que lo cambies, tienes que copiarlo y pegarlo manualmente en el editor de Apps Script (Extensiones → Apps Script desde el Sheet) y volver a implementar (Implementar → Administrar implementaciones → ✏️ → Nueva versión → Implementar). Si editas el script directo en Apps Script, trae la copia de vuelta a este archivo para que no queden desincronizados.

### Contrato de datos (campos que debe devolver el Apps Script)

La app trabaja con 2 canales de precio (el usuario elige uno al entrar: Tienda Estándar / Outlet) y calcula el % de descuento en el frontend contra el precio base. Cada producto (tanto en `buscarCodigo` como en cada item de `listarCategoria`) debe incluir estos campos, mapeados desde las columnas de la hoja **BASE PRECIOS**:

| Campo JSON        | Columna del Sheet     | Uso |
|--------------------|------------------------|-----|
| `fullPriceRetail`  | Full Price Retail      | Precio base para calcular el % de descuento de cada canal |
| `precioAntes`      | Precio Antes            | Se muestra como referencia tachada junto al precio base |
| `precioTienda`     | Nuevo Precio Final      | Precio cuando el usuario elige "Tienda Estándar" |
| `precioOutlet`     | Precios Outlet          | Precio cuando el usuario elige "Outlet" |
| `precioPiloto`     | Precio 30 tiendas       | Ya no se usa en la UI (canal Piloto oculto), pero el backend lo sigue exponiendo por si se reactiva |
| `obsolescencia`    | Obsolescencia final     | `"50"`, `"100"` o vacío — dispara la alerta y el borde de color en la tarjeta del producto |
| `fechaActualizacion` | (columna de fecha, si se agrega) | Opcional. Fecha del último cambio de precio |

El % de descuento por canal, y si el precio subió/bajó/se mantuvo en el **detalle de un producto**, **lo calcula el frontend** comparando el precio real del canal contra `fullPriceRetail` — no depende de ninguna columna de observación. Para los **listados** (Alzas/Bajas/Sin Cambios) sí importa la observación: cada canal tiene su propia columna (`OBSERVACION STANDAR` / `OBSERVACION OUTLET`) y el backend filtra por la que corresponda según el parámetro `tienda` que manda `app.js`.

Todos estos campos son opcionales por compatibilidad hacia atrás: si faltan, el frontend cae de vuelta a los campos antiguos (`precioInicial`, `nuevoPrecio`) para no romper mientras se actualiza el script.

En Apps Script, donde arman el objeto de respuesta (algo como `{ codigo: row[0], marca: row[1], ... }`), agreguen las líneas correspondientes a estos nuevos campos usando el índice de columna real de cada uno en la hoja.

### Selector de tipo de tienda

Al abrir la app por primera vez, se pide elegir el canal (Estándar / Outlet / Evento). La elección se guarda en `localStorage` (`tiendaSeleccionada`) y se reutiliza en visitas futuras; se puede cambiar en cualquier momento tocando el chip que aparece arriba del buscador. Todos los precios mostrados (detalle y listados) corresponden al canal activo. Si un usuario tiene guardado un canal que ya no existe (ej. `piloto`, de una versión anterior), la app lo ignora y vuelve a mostrar el selector.

### Tienda Evento (liquidaciones por tienda física)

Es un canal aparte de Estándar/Outlet, con su propia hoja del Sheet ("Evento Outlet", detectada por cualquier pestaña cuyo nombre contenga "EVENTO"). A diferencia de BASE PRECIOS, esa hoja se lee por **posición de columna** (A=Tienda, B=Código, C=Marca, E=Género, F=Categoría, G=Subcategoría, J=Precio Inicial, K=Precio Antes, L=Precio Oferta Ahora, M=Stock — ver `COL_EVENTO` en `apps-script/Codigo.gs`), no por nombre de encabezado, porque no se conoce el texto exacto de esos encabezados.

Al elegir "Tienda Evento" aparece una pantalla extra para elegir la tienda física (`view-0-evento`), con un `<select>` poblado en vivo desde `listarTiendasEvento` — así cada tienda ve solo su propio stock y códigos, sin poder escribir mal el nombre. Esa elección se guarda en `localStorage` (`tiendaEventoSeleccionada`).

En este canal, el apartado "Oportunidades y Alertas" de la pantalla principal cambia: en vez de Alzas/Bajas/Sin Cambios/Obsolescencia (que dependen de columnas que esta hoja no tiene), se muestra un único botón "Ver Stock de mi Tienda" que trae todo el inventario de esa tienda, filtrable por Marca/Género/Categoría/Subcategoría y por **Punta de Precio** (coincidencia exacta contra 990/1000/5000/7000/10000/15000/20000, a diferencia del Rango de Precio que agrupa por tramos) — o se puede seguir consultando un código directo con el buscador normal.

Los items de evento se devuelven con la misma forma que los de BASE PRECIOS (`tipoProducto` = Categoría, `precioInicial`/`precioAntes` con el mismo nombre, y `precioOferta` mapeado en `CAMPO_PRECIO_CANAL.evento`), así que toda la lógica de precios, tarjetas, filtros y paginación se reutiliza sin duplicar código — el frontend no sabe ni le importa si el item vino de BASE PRECIOS o de Evento Outlet.

### Filtros y orden en los listados

Los filtros (Marca, Género, Tipo, Rango de Precio, Nivel de Descuento, y Nivel de Obsolescencia — este último solo visible dentro del apartado "Obsolescencia") viven en una ventana modal (`#filtros-modal`), abierta con el ícono de embudo en el encabezado del listado, en vez de una barra horizontal con scroll (poco descubrible en pantallas chicas). También se puede ordenar por precio de menor a mayor o viceversa. Los cambios en los `<select>` del modal no se aplican solos — hay que tocar "Aplicar Filtros"; al aplicar, se cierran el modal y quedan chips en la pantalla del listado mostrando qué filtros están activos, cada uno con su propia "✕" para quitarlo individual, más un chip "Borrar todo".

### Exportar a PDF

Los listados de **Alzas de Precio** y **Bajas de Precio** (no "Sin Cambios", "Obsolescencia" ni el stock de Evento) tienen un botón "Exportar PDF" que genera un PDF tamaño carta con foto, código, marca, género, tipo de producto, precio inicial, precio antes, % de variación y precio final — respetando los filtros aplicados en ese momento. Usa `jsPDF` + `jspdf-autotable` cargados por CDN en `index.html`. Por rendimiento (cargar cientos de fotos en el navegador es lento/pesado, sobre todo en el celular), hay un tope de `LIMITE_EXPORTACION_PDF` (150) productos en `app.js`; si se supera, se le pide al usuario filtrar más en vez de intentar exportar igual.

## Al desplegar un cambio

Si modificas `index.html`, `style.css`, `app.js` o `manifest.json`, **sube el número de `CACHE_VERSION` en `sw.js`**. El service worker cachea el app shell de forma agresiva (cache-first); sin ese cambio de versión, los usuarios que ya instalaron la PWA pueden seguir viendo la versión vieja hasta que limpien el caché manualmente.

## Ideas de mejora a futuro

- **Seguridad**: la URL del Apps Script queda visible en el cliente. Vale la pena revisar en el propio script qué controles de acceso tiene (autenticación, límite de requests, CORS) para evitar que se use para raspar el catálogo completo.
- **Búsqueda por texto en los listados**: los filtros actuales son por selección (marca/género/tipo/precio/descuento/obsolescencia); un campo de búsqueda libre por código o nombre ayudaría en categorías grandes.
- **Manejo de "sin conexión"** más explícito, más allá de los toasts de error (por ejemplo detectar `navigator.onLine` y mostrar un banner persistente).
- **Íconos propios**: actualmente se usa un ícono genérico (`icons/icon-192.png` y `icons/icon-512.png`), conviene reemplazarlo por el logo real de la marca en ambas resoluciones.
- **Tests**: no hay ninguno. Si la lógica de parseo de precios/descuentos (`app.js`) crece, conviene testearla por separado (por ejemplo extrayéndola a un módulo con Vitest/Jest).
