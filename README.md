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
- `?action=listarCategoria&categoria=SUBE|BAJA|MANTIENE|OBSOLESCENCIA&tienda=estandar|outlet` → listado por categoría. `OBSOLESCENCIA` filtra por la columna "Obsolescencia final" (= 50 o 100), ignora `tienda`. Las demás categorías se calculan comparando el precio del canal contra el **Precio Antes** (o el Full Price Retail si no hay Precio Antes) — ver "Criterio de alza/baja" más abajo.

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

### Criterio de alza/baja

Los tres canales muestran **Precio Inicial (FPR)**, **Precio Antes** (columna W) y el precio del canal (Estándar `precioTienda`, Outlet `precioOutlet`, Evento `precioEvento`). Hay dos comparaciones:

- **Etiqueta Alza / Baja / Sin Cambios** (listados, badge "Alza", detalle): precio del canal vs **Precio Antes**. Si el producto no tiene Precio Antes, se compara vs FPR. Si falta el precio del canal o la referencia, el producto no entra en esos listados.
- **% de descuento** (badge, filtro de descuento, detalle, PDF): siempre precio del canal vs **FPR**. Puede convivir con una Alza (ej. FPR 49.990, Antes 35.990, Tienda 39.990 → Alza y -20%).

El backend lo calcula en `categoriaPrecio` (`Codigo.gs`) y el frontend en `compararPrecioCanal` (`app.js`) — si se cambia uno, hay que cambiar el otro.

### Caché del backend

Leer las ~17 mil filas de BASE PRECIOS toma varios segundos, así que `Codigo.gs` guarda en `CacheService` la tabla de productos y el stock de cada tienda por 10 minutos (`CACHE_TTL_SEG`). La caché se invalida sola al editar el Sheet a mano (disparador simple `onEdit`) y al subir stock. Cambios que no son ediciones manuales (fórmulas que dependen de otros archivos, importaciones) se ven a más tardar al vencer los 10 minutos.

### Selector de tipo de tienda

Al abrir la app por primera vez se pide el EDP de la tienda (el canal Estándar / Outlet / Evento Outlet viene con la tienda; al abrir la app se vuelve a consultar en segundo plano, así un cambio de canal o de nombre llega sin pedir la EDP otra vez). La elección se guarda en `localStorage` (`tiendaSeleccionada`) y se reutiliza en visitas futuras; se puede cambiar en cualquier momento tocando el chip que aparece arriba del buscador. Todos los precios mostrados (detalle y listados) corresponden al canal activo. Si un usuario tiene guardado un canal que ya no existe (ej. `piloto`, de una versión anterior), la app lo ignora y vuelve a mostrar el selector.

### Tienda por EDP y stock por tienda

Al entrar, el usuario **digita el EDP de su tienda** (`view-0`) y la app arma todo a partir de él, usando el maestro `BASE.xlsx` → hoja "DM+BASE DATOS TIENDA":

- El header muestra la **GLOSA TIENDA** y la **cadena townhall** (BATA, BUBBLE GUMMERS, CORNERS, WEINBRENNER, NORTHSTAR, OUTLET…).
- El canal de precios es automático: cadena `OUTLET` (o "OUTLET" en el nombre) → precios Outlet; todas las demás → precio Estándar.
- Alzas / Bajas / Sin Cambios / Obsolescencia muestran **solo los artículos con stock > 0 en esa tienda**, con una pastilla "Stock: N". El detalle de un código muestra el apartado "Stock en <tienda>" (o "Sin stock en esta tienda").
- El cruce es `articulo` del archivo de stock contra la columna **Cod Art Numero** de BASE PRECIOS.
- **Tiendas evento outlet**: las EDP listadas en [`scripts/tiendas_evento.txt`](scripts/tiendas_evento.txt) (una por línea) usan la columna **"Precio eventos outlet"** (AA de BASE PRECIOS) sin importar su cadena, con el mismo criterio de alza/baja que los demás canales. Para agregar o quitar una tienda basta editar ese archivo; la próxima carga diaria lo aplica. El resto de las tiendas usa el canal de su cadena townhall.
- En los listados el código se muestra siempre con guion tras el 3er dígito (ej. 589-8773), con la pastilla de stock justo al lado; el filtro "Punta de Precio" aparece solo en tiendas Outlet.

El stock sale de `Obsolescencia_Unido_<año>.txt` (SharePoint, ~1,7 GB, se regenera todos los días a las 8:00). Apps Script no puede leerlo, así que [`scripts/actualizar_stock.py`](scripts/actualizar_stock.py) lo procesa en el PC:

- Toma el `Obsolescencia_Unido_*.txt` más reciente, se queda **solo con la semana máxima** (`semana_key`, ej. 202642) y la ubicación `EN TIENDA`, suma por tienda + artículo y descarta los ≤ 0.
- Cruza con el maestro de tiendas (sube solo las EDP que están en él; deja fuera bodegas/CD) y lo envía por `doPost` al Apps Script, que lo escribe en las pestañas `STOCK TIENDAS` y `STOCK META` del Sheet.
- Endpoints: `?action=listarTiendasStock`, y el parámetro `&tiendaStock=<EDP>` en `buscarCodigo` y `listarCategoria`.

Configuración (una sola vez):

1. En Apps Script: Configuración del proyecto → Propiedades del script → agregar `STOCK_TOKEN` con un valor secreto. Pegar el nuevo `Codigo.gs` y volver a implementar (Nueva versión).
2. `pip install openpyxl`. Copiar `scripts/stock_config.example.json` a `scripts/stock_config.json` (ignorado por git) y completar URL `/exec`, el mismo token, la carpeta del stock y la ruta de `BASE.xlsx`.
3. Probar: `python scripts/actualizar_stock.py` (o `--dry-run` para solo ver el resumen).
4. Automatizar: `powershell -ExecutionPolicy Bypass -File scripts\instalar_tarea.ps1` registra una tarea de Windows diaria a las 08:45 (log en `scripts/actualizar_stock.log`). Corre en este PC: si está apagado, corre al encenderlo.

### Filtros y orden en los listados

Los filtros (Marca, Género, Tipo, Rango de Precio, Nivel de Descuento, y Nivel de Obsolescencia — este último solo visible dentro del apartado "Obsolescencia") viven en una ventana modal (`#filtros-modal`), abierta con el ícono de embudo en el encabezado del listado, en vez de una barra horizontal con scroll (poco descubrible en pantallas chicas). También se puede ordenar por precio de menor a mayor o viceversa. Los cambios en los `<select>` del modal no se aplican solos — hay que tocar "Aplicar Filtros"; al aplicar, se cierran el modal y quedan chips en la pantalla del listado mostrando qué filtros están activos, cada uno con su propia "✕" para quitarlo individual, más un chip "Borrar todo".

### Exportar a PDF

Los listados de **Alzas de Precio** y **Bajas de Precio** (no "Sin Cambios" ni "Obsolescencia") tienen un botón "Exportar PDF" que genera un PDF tamaño carta con foto, código, marca, género, tipo de producto, precio inicial, precio antes, % de variación y precio final — respetando los filtros aplicados en ese momento. Usa `jsPDF` + `jspdf-autotable` cargados por CDN en `index.html`. Por rendimiento (cargar cientos de fotos en el navegador es lento/pesado, sobre todo en el celular), hay un tope de `LIMITE_EXPORTACION_PDF` (150) productos en `app.js`; si se supera, se le pide al usuario filtrar más en vez de intentar exportar igual.

## Al desplegar un cambio

El service worker sirve el app shell con *stale-while-revalidate*: carga al tiro desde caché y trae la versión nueva en segundo plano, así que un cambio en `index.html`, `style.css`, `app.js` o `manifest.json` llega a los usuarios en la **siguiente apertura** de la app, sin hacer nada. Subir `CACHE_VERSION` en `sw.js` solo hace falta para forzar una limpieza completa del shell. Las fotos (`buscador-fotos-v1`, tope de 400) y las librerías de CDN (`buscador-libs-v1`) van en cachés aparte que no se borran al subir la versión. Si cambias la versión de una librería en `index.html`, actualiza también la lista `LIBS` de `sw.js`.

## Ideas de mejora a futuro

- **Seguridad**: la URL del Apps Script queda visible en el cliente. Vale la pena revisar en el propio script qué controles de acceso tiene (autenticación, límite de requests, CORS) para evitar que se use para raspar el catálogo completo.
- **Búsqueda por texto en los listados**: los filtros actuales son por selección (marca/género/tipo/precio/descuento/obsolescencia); un campo de búsqueda libre por código o nombre ayudaría en categorías grandes.
- **Manejo de "sin conexión"** más explícito, más allá de los toasts de error (por ejemplo detectar `navigator.onLine` y mostrar un banner persistente).
- **Íconos propios**: actualmente se usa un ícono genérico (`icons/icon-192.png` y `icons/icon-512.png`), conviene reemplazarlo por el logo real de la marca en ambas resoluciones.
- **Tests**: no hay ninguno. Si la lógica de parseo de precios/descuentos (`app.js`) crece, conviene testearla por separado (por ejemplo extrayéndola a un módulo con Vitest/Jest).
