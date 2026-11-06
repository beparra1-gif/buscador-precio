/**
 * Backend de Google Apps Script para "Buscador Comercial".
 * Pegar completo en el archivo .gs del proyecto vinculado a la hoja
 * "BASE PRECIOS" (Extensiones > Apps Script desde el Sheet).
 *
 * Después de pegar y guardar: Implementar > Administrar implementaciones
 * > lápiz (editar la implementación activa) > Nueva versión > Implementar.
 * Guardar código sin volver a implementar NO actualiza la URL /exec en uso.
 */

function doGet(e) {
  var accion = e.parameter.action;

  if (accion === 'listarTiendasStock') {
    return listarTiendasStock();
  }
  if (accion === 'listarCategoria') {
    return listarCategoria(e.parameter.categoria, e.parameter.tienda, e.parameter.tiendaStock);
  }
  // Por defecto (o accion === 'buscarCodigo'): buscar por código
  return buscarCodigo(e.parameter.codigo, e.parameter.tiendaStock);
}

// Recibe la carga diaria de stock desde scripts/actualizar_stock.py (PC local).
// Protegido con un token guardado en Configuración del proyecto > Propiedades
// del script > STOCK_TOKEN (nunca en el código, porque el repo es público).
function doPost(e) {
  var cuerpo;
  try {
    cuerpo = JSON.parse(e.postData.contents);
  } catch (err) {
    return salida({ ok: false, error: 'JSON inválido' });
  }
  var tokenEsperado = PropertiesService.getScriptProperties().getProperty('STOCK_TOKEN');
  if (!tokenEsperado || cuerpo.token !== tokenEsperado) {
    return salida({ ok: false, error: 'Token inválido' });
  }
  if (cuerpo.action === 'subirStock') return subirStock(cuerpo);
  return salida({ ok: false, error: 'Acción desconocida' });
}

// Disparador simple: cualquier edición manual del Sheet invalida la caché, para
// que un cambio de precio se vea al tiro en la app. Los cambios que no son
// ediciones manuales (fórmulas que dependen de otros archivos, importaciones)
// se ven a más tardar cuando vence la caché (CACHE_TTL_SEG).
function onEdit(e) {
  invalidarCache();
}

// ===================== CACHÉ =====================
// Leer las ~17 mil filas de BASE PRECIOS toma varios segundos, así que la
// tabla de productos y el stock de cada tienda se guardan en CacheService.
// CacheService admite máximo 100 KB por valor: los textos largos se parten en
// trozos. La versión (propiedad CACHE_VERSION) va en cada clave; cambiarla
// equivale a borrar toda la caché.
var CACHE_TTL_SEG = 600;         // 10 minutos
var CACHE_TROZO = 50000;         // caracteres por trozo (< 100 KB aun con tildes)
var CACHE_MAX_TROZOS = 150;

function versionCache() {
  return PropertiesService.getScriptProperties().getProperty('CACHE_VERSION') || '1';
}

function invalidarCache() {
  PropertiesService.getScriptProperties().setProperty('CACHE_VERSION', String(new Date().getTime()));
}

function cacheGuardar(clave, texto) {
  try {
    var n = Math.max(1, Math.ceil(texto.length / CACHE_TROZO));
    if (n > CACHE_MAX_TROZOS) return;
    var valores = {};
    for (var i = 0; i < n; i++) valores[clave + '#' + i] = texto.substr(i * CACHE_TROZO, CACHE_TROZO);
    valores[clave] = String(n);
    CacheService.getScriptCache().putAll(valores, CACHE_TTL_SEG);
  } catch (err) { /* sin caché: la próxima consulta lee del Sheet */ }
}

function cacheLeer(clave) {
  try {
    var cache = CacheService.getScriptCache();
    var n = Number(cache.get(clave));
    if (!n) return null;
    var claves = [];
    for (var i = 0; i < n; i++) claves.push(clave + '#' + i);
    var trozos = cache.getAll(claves);
    var partes = [];
    for (var j = 0; j < n; j++) {
      var t = trozos[claves[j]];
      if (t === undefined || t === null) return null; // un trozo expiró: se relee del Sheet
      partes.push(t);
    }
    return partes.join('');
  } catch (err) {
    return null;
  }
}

// ===================== BASE PRECIOS =====================

// Quita tildes, pasa a mayúsculas y recorta espacios, para que las comparaciones
// no dependan de que el texto esté escrito exactamente igual (tildes, mayúsculas, espacios extra)
function normalizarTexto(s) {
  var sinTildes = s.toString().trim().toUpperCase().normalize('NFD');
  var rangoDiacriticos = String.fromCharCode(0x0300) + '-' + String.fromCharCode(0x036f);
  return sinTildes.replace(new RegExp('[' + rangoDiacriticos + ']', 'g'), '');
}

// Busca la pestaña "BASE PRECIOS" tolerando tildes/mayúsculas/espacios distintos;
// si no la encuentra, usa la primera pestaña del archivo como respaldo.
function encontrarHojaBase(ss) {
  var objetivo = normalizarTexto('BASE PRECIOS');
  var hojas = ss.getSheets();
  for (var i = 0; i < hojas.length; i++) {
    if (normalizarTexto(hojas[i].getName()) === objetivo) return hojas[i];
  }
  return hojas[0];
}

function obtenerEncabezados(sheet) {
  var totalColumnas = sheet.getLastColumn();
  var headers = sheet.getRange(1, 1, 1, totalColumnas).getValues()[0];
  var headersNorm = headers.map(normalizarTexto);
  // colOpcional: no falla si no encuentra la columna (devuelve -1). Úsala para
  // campos que no deben tumbar toda la respuesta si a alguien se le borra un
  // encabezado en el Sheet (ej. precios por canal, marca, género, etc).
  var colOpcional = function (nombre) {
    return headersNorm.indexOf(normalizarTexto(nombre));
  };
  // col: falla fuerte. Solo para columnas sin las que la app no puede funcionar
  // en absoluto (el código del producto).
  var col = function (nombre) {
    var idx = colOpcional(nombre);
    if (idx === -1) throw new Error('No se encontró la columna: ' + nombre + ' (hoja: ' + sheet.getName() + ', encabezados: ' + headers.join(' | ') + ')');
    return idx;
  };
  return { headers: headers, headersNorm: headersNorm, totalColumnas: totalColumnas, col: col, colOpcional: colOpcional };
}

// Columnas que la app realmente necesita. Se usan para no leer más ancho de
// hoja del que hace falta (evita traer W4/W3/W2/W1 y otras columnas sin uso).
var CAMPOS_REQUERIDOS = [
  'Cod 7 texto', 'Cod Art Numero', 'Marca', 'GENERO', 'TIPO PRODUCTO', 'Proyecto',
  'Full Price Retail', 'Precio Antes', 'Nuevo Precio Final', 'Precios Tiendas', 'Precios Outlet',
  'Precio eventos outlet', 'Precio 30 tiendas', 'Obsolescencia final'
];

// Lee toda la hoja, pero solo hasta la última columna que realmente se usa
// (calculado a partir de CAMPOS_REQUERIDOS, sin asumir un orden fijo).
function obtenerDatos() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = encontrarHojaBase(ss);
  var info = obtenerEncabezados(sheet);
  var indices = CAMPOS_REQUERIDOS
    .map(function (nombre) { return info.headersNorm.indexOf(normalizarTexto(nombre)); })
    .filter(function (idx) { return idx !== -1; });
  var anchoUtil = indices.length > 0 ? Math.max.apply(null, indices) + 1 : info.totalColumnas;
  var totalFilas = sheet.getLastRow();
  var data = totalFilas > 1 ? sheet.getRange(1, 1, totalFilas, anchoUtil).getValues() : [info.headers];
  return { data: data, col: info.col, colOpcional: info.colOpcional };
}

// La app siempre manda el código relleno con ceros a la izquierda hasta 7 dígitos
// (ej. "0010554"), pero en la hoja "Cod 7 texto" guarda el número sin ese relleno
// (ej. "10554"). Se quitan los ceros a la izquierda de ambos lados para comparar.
function normalizarCodigo(c) {
  var limpio = c.toString().trim().replace(/^0+/, '');
  return limpio === '' ? '0' : limpio;
}

// Orden de los campos de un producto al guardarlo en caché (como arreglo, para
// no repetir los nombres de campo 17 mil veces).
var CAMPOS_PRODUCTO = [
  'codigo', 'codArtNumero', 'marca', 'genero', 'tipoProducto', 'proyecto',
  'fullPriceRetail', 'precioAntes', 'precioTienda', 'precioOutlet', 'precioEvento',
  'precioPiloto', 'obsolescencia'
];

// Lee un campo de forma tolerante: si la columna no existe (ej. a alguien se le
// borró el encabezado sin querer), devuelve null en vez de tumbar todo el producto.
function armarProducto(row, col, colOpcional) {
  var leer = function (nombre) {
    var idx = colOpcional(nombre);
    return idx === -1 ? null : row[idx];
  };
  var leerTexto = function (nombre) {
    var v = leer(nombre);
    return v === null || v === undefined ? '' : v.toString();
  };
  // Si la columna principal viene vacía para esta fila (no siempre está
  // cargada "Nuevo Precio Final"), usa la de respaldo en vez de dejar el
  // precio en blanco.
  var leerConRespaldo = function (principal, respaldo) {
    var v = leer(principal);
    return (v === null || v === undefined || v === '') ? leer(respaldo) : v;
  };
  return {
    codigo: row[col('Cod 7 texto')].toString().trim().padStart(7, '0'),
    codArtNumero: leerTexto('Cod Art Numero').trim(),
    marca: leer('Marca'),
    genero: leer('GENERO'),
    tipoProducto: leer('TIPO PRODUCTO'),
    proyecto: leer('Proyecto'),
    fullPriceRetail: leer('Full Price Retail'),
    precioAntes: leer('Precio Antes'),
    precioTienda: leerConRespaldo('Nuevo Precio Final', 'Precios Tiendas'),
    precioOutlet: leer('Precios Outlet'),
    // Columna AA: precio de las tiendas evento outlet (lista en scripts/tiendas_evento.txt)
    precioEvento: leer('Precio eventos outlet'),
    precioPiloto: leer('Precio 30 tiendas'),
    obsolescencia: leerTexto('Obsolescencia final').trim()
  };
}

// Todos los productos de BASE PRECIOS, desde la caché si está disponible.
function obtenerProductos() {
  var clave = 'productos|' + versionCache();
  var enCache = cacheLeer(clave);
  if (enCache) {
    return JSON.parse(enCache).map(function (fila) {
      var p = {};
      CAMPOS_PRODUCTO.forEach(function (campo, i) { p[campo] = fila[i]; });
      return p;
    });
  }

  var info = obtenerDatos();
  var idxCodigo = info.col('Cod 7 texto');
  var productos = [];
  for (var i = 1; i < info.data.length; i++) {
    var cod = info.data[i][idxCodigo];
    if (cod === '' || cod === null || cod === undefined) continue; // fila vacía
    productos.push(armarProducto(info.data[i], info.col, info.colOpcional));
  }
  cacheGuardar(clave, JSON.stringify(productos.map(function (p) {
    return CAMPOS_PRODUCTO.map(function (campo) { return p[campo]; });
  })));
  return productos;
}

// Búsqueda de un solo código: en vez de leer las 17 mil filas completas,
// busca directo en la columna del código (como un Ctrl+F, corre del lado
// de Sheets) y recién ahí lee la única fila que interesa.
function buscarCodigo(codigoBuscar, tiendaStock) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = encontrarHojaBase(ss);
  var info = obtenerEncabezados(sheet);
  var idxCodigo = info.col('Cod 7 texto');
  var buscado = normalizarCodigo(codigoBuscar || '');

  var totalFilas = sheet.getLastRow();
  if (totalFilas < 2) return salida({ encontrado: false });

  var rangoCodigos = sheet.getRange(2, idxCodigo + 1, totalFilas - 1, 1);
  var encontrada = rangoCodigos.createTextFinder(buscado).matchEntireCell(true).findNext();
  if (!encontrada) return salida({ encontrado: false });

  var filaValores = sheet.getRange(encontrada.getRow(), 1, 1, info.totalColumnas).getValues()[0];
  var resultado = armarProducto(filaValores, info.col, info.colOpcional);
  resultado.encontrado = true;
  // Con tienda elegida, se informa cuánto stock tiene esa tienda del artículo
  // (0 si no tiene); el producto se muestra igual para poder consultar precio.
  if (tiendaStock) {
    var stockTienda = leerStockTienda(tiendaStock);
    if (stockTienda) {
      resultado.stock = stockTienda.articulos[normalizarCodigo(resultado.codArtNumero)] || 0;
      resultado.semanaStock = stockTienda.semana;
      resultado.stockActualizado = stockTienda.actualizado;
    }
  }
  return salida(resultado);
}

// Precio de la hoja a número: acepta 12990, "12990" o "$12.990".
function aNumeroPrecio(v) {
  if (v === null || v === undefined || v === '') return NaN;
  if (typeof v === 'number') return Math.round(v);
  var limpio = v.toString().replace(/\D/g, '');
  return limpio === '' ? NaN : parseInt(limpio, 10);
}

// Categoría Alza/Baja/Sin cambios de un producto en un canal. Es el MISMO
// criterio que usa la app (app.js, compararPrecioCanal):
//   precio del canal (Tienda / Outlet / Evento Outlet) vs "Precio Antes";
//   si el producto no tiene Precio Antes, vs Full Price Retail.
// Más alto = SUBE, más bajo = BAJA, igual = MANTIENE. Sin precio de canal o
// sin referencia no hay categoría (el producto no entra en esos listados).
// El % de descuento que muestra la app se calcula aparte, siempre vs FPR.
function categoriaPrecio(producto, tienda) {
  var campo = tienda === 'evento' ? 'precioEvento' : tienda === 'outlet' ? 'precioOutlet' : 'precioTienda';
  var canal = aNumeroPrecio(producto[campo]);
  var base = aNumeroPrecio(producto.precioAntes) || aNumeroPrecio(producto.fullPriceRetail);
  if (!base || !canal) return ''; // NaN o 0
  if (canal > base) return 'SUBE';
  if (canal < base) return 'BAJA';
  return 'MANTIENE';
}

function listarCategoria(categoria, tienda, tiendaStock) {
  // Con tienda elegida, solo se listan los artículos que esa tienda tiene en
  // stock (cruce de "Cod Art Numero" contra la columna articulo del archivo
  // de stock), y cada item lleva su cantidad.
  var stockTienda = null;
  if (tiendaStock) {
    stockTienda = leerStockTienda(tiendaStock);
    if (!stockTienda) return salida({ encontrado: false, error: 'No hay stock cargado para la tienda ' + tiendaStock });
  }

  // OBSOLESCENCIA no filtra por precio sino por la columna "Obsolescencia
  // final" (solo productos marcados 50 o 100).
  var cumple = categoria === 'OBSOLESCENCIA'
    ? function (p) { return p.obsolescencia === '50' || p.obsolescencia === '100'; }
    : function (p) { return categoriaPrecio(p, tienda) === categoria; };

  var items = [];
  obtenerProductos().forEach(function (producto) {
    if (!cumple(producto)) return;
    if (stockTienda) {
      var cantidad = stockTienda.articulos[normalizarCodigo(producto.codArtNumero || '')];
      if (!cantidad) return;
      producto.stock = cantidad;
    }
    items.push(producto);
  });

  return salida({
    encontrado: true,
    items: items,
    semanaStock: stockTienda ? stockTienda.semana : null,
    stockActualizado: stockTienda ? stockTienda.actualizado : null
  });
}

// ===================== STOCK POR TIENDA =====================
// El stock viene del archivo Obsolescencia_Unido_<año>.txt (1,7 GB, en
// SharePoint), que Apps Script no puede leer. scripts/actualizar_stock.py lo
// procesa en la PC (solo la última semana, ubicación EN TIENDA) y lo manda
// por doPost a estas dos pestañas:
//   STOCK TIENDAS: Tienda | Parte | Articulos  ("1010346:5,1010410:2,...";
//                  una tienda grande ocupa varias filas porque una celda no
//                  admite más de 50.000 caracteres)
//   STOCK META:    Tienda | Nombre | Tipo | Cadena | Articulos | Semana | Actualizado
//                  (Nombre = GLOSA TIENDA y Cadena = cadena townhall de BASE.xlsx;
//                  Tipo = evento para las EDP de scripts/tiendas_evento.txt,
//                  outlet para cadena OUTLET, estandar para el resto)
var HOJA_STOCK = 'STOCK TIENDAS';
var HOJA_STOCK_META = 'STOCK META';

function subirStock(cuerpo) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var ahora = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');
    escribirHojaTexto(ss, HOJA_STOCK, ['Tienda', 'Parte', 'Articulos'], cuerpo.filasStock);
    var filasMeta = cuerpo.filasMeta.map(function (f) { return f.concat([cuerpo.semana, ahora]); });
    escribirHojaTexto(ss, HOJA_STOCK_META, ['Tienda', 'Nombre', 'Tipo', 'Cadena', 'Articulos', 'Semana', 'Actualizado'], filasMeta);
    invalidarCache(); // el stock en caché quedó viejo
    return salida({ ok: true, semana: cuerpo.semana, tiendas: filasMeta.length, filas: cuerpo.filasStock.length });
  } finally {
    lock.releaseLock();
  }
}

// Formato texto (@) antes de escribir: si no, Sheets convierte "1010346:5"
// en una hora y los códigos de tienda pierden su forma original.
function escribirHojaTexto(ss, nombre, encabezados, filas) {
  var hoja = ss.getSheetByName(nombre) || ss.insertSheet(nombre);
  hoja.clearContents();
  var valores = [encabezados].concat(filas.map(function (f) { return f.map(String); }));
  hoja.getRange(1, 1, valores.length, encabezados.length).setNumberFormat('@').setValues(valores);
}

// Devuelve { semana, actualizado, articulos: { codArtNormalizado: cantidad } }
// de una tienda, o null si la tienda no tiene stock cargado. Busca solo las
// filas de esa tienda con TextFinder en vez de leer toda la pestaña, y guarda
// el resultado en caché.
function leerStockTienda(tiendaKey) {
  var clave = tiendaKey.toString().trim();
  var claveCache = 'stock|' + versionCache() + '|' + clave;
  var enCache = cacheLeer(claveCache);
  if (enCache) return JSON.parse(enCache);

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var hoja = ss.getSheetByName(HOJA_STOCK);
  if (!hoja || hoja.getLastRow() < 2) return null;
  var celdas = hoja.getRange(2, 1, hoja.getLastRow() - 1, 1)
    .createTextFinder(clave).matchEntireCell(true).findAll();
  if (celdas.length === 0) return null;

  var articulos = {};
  celdas.forEach(function (celda) {
    var texto = hoja.getRange(celda.getRow(), 3).getValue().toString();
    texto.split(',').forEach(function (par) {
      var partes = par.split(':');
      if (partes.length === 2) articulos[normalizarCodigo(partes[0])] = Number(partes[1]) || 0;
    });
  });
  var meta = leerFechaStock(ss);
  var resultado = { semana: meta.semana, actualizado: meta.actualizado, articulos: articulos };
  cacheGuardar(claveCache, JSON.stringify(resultado));
  return resultado;
}

// Semana y fecha/hora de la última carga de stock (iguales en todas las filas de STOCK META)
function leerFechaStock(ss) {
  var meta = ss.getSheetByName(HOJA_STOCK_META);
  if (!meta || meta.getLastRow() < 2) return { semana: null, actualizado: null };
  var fila = meta.getRange(2, 6, 1, 2).getValues()[0];
  return { semana: fila[0].toString(), actualizado: fila[1].toString() };
}

// Lista las tiendas con stock (EDP, nombre, cadena y canal de precios) para
// que el frontend valide la EDP que digita el usuario y arme el header.
function listarTiendasStock() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var meta = ss.getSheetByName(HOJA_STOCK_META);
  if (!meta || meta.getLastRow() < 2) return salida({ encontrado: false, error: 'Aún no se ha cargado el stock por tienda' });

  var filas = meta.getRange(2, 1, meta.getLastRow() - 1, 7).getValues();
  var tiendas = filas.map(function (f) {
    return {
      tienda: f[0].toString(),
      nombre: f[1].toString(),
      tipo: ['outlet', 'evento'].indexOf(f[2].toString()) !== -1 ? f[2].toString() : 'estandar',
      cadena: f[3].toString(),
      articulos: Number(f[4]) || 0
    };
  });
  return salida({
    encontrado: true,
    tiendas: tiendas,
    semana: filas[0][5].toString(),
    actualizado: filas[0][6].toString()
  });
}

function salida(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
