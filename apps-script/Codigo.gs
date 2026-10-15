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

  if (accion === 'debug') {
    return debugHojas();
  }
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

// Endpoint temporal de diagnóstico: ?action=debug
// Muestra qué pestañas existen, cuál se está usando, y qué hay en su fila 1.
// Se puede borrar una vez que todo funcione.
function debugHojas() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var hoja = encontrarHojaBase(ss);
  var ultimaCol = hoja.getLastColumn();
  var filaEncabezados = ultimaCol > 0 ? hoja.getRange(1, 1, 1, ultimaCol).getValues()[0] : [];
  return salida({
    hojasDisponibles: ss.getSheets().map(function (h) { return h.getName(); }),
    hojaUsada: hoja.getName(),
    totalFilas: hoja.getLastRow(),
    totalColumnas: ultimaCol,
    filaEncabezados: filaEncabezados
  });
}

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
  // en absoluto (el código del producto, o el estado para filtrar categorías).
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
  'Full Price Retail', 'Precio Antes', 'Nuevo Precio Final', 'Precios Outlet', 'Precio 30 tiendas',
  'Obsolescencia final', 'OBSERVACION STANDAR', 'OBSERVACION OUTLET'
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
    precioPiloto: leer('Precio 30 tiendas'),
    obsolescencia: leerTexto('Obsolescencia final').trim()
  };
}

// Búsqueda de un solo código: en vez de leer las 15 mil filas completas,
// busca directo en la columna del código (como un Ctrl+F, corre del lado
// de Sheets) y recién ahí lee la única fila que interesa. Mucho más rápido
// que buscarCodigo cargando todo con obtenerDatos().
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
    }
  }
  return salida(resultado);
}

// Las columnas de observación usan palabras distintas a los botones de la app
// (ej. "DISMINUYE" en vez de "BAJA"), así que cada categoría acepta sinónimos.
var SINONIMOS_CATEGORIA = {
  SUBE: ['SUBE', 'AUMENTA'],
  BAJA: ['BAJA', 'DISMINUYE'],
  MANTIENE: ['MANTIENE']
};

// Cada canal tiene su propia columna de observación (antes había una sola
// columna genérica; ahora Estándar y Outlet se evalúan por separado, así
// que "sube/baja/mantiene" puede diferir entre canales para el mismo producto).
function columnaObservacionPorTienda(tienda) {
  return tienda === 'outlet' ? 'OBSERVACION OUTLET' : 'OBSERVACION STANDAR';
}

function listarCategoria(categoria, tienda, tiendaStock) {
  var info = obtenerDatos();
  var data = info.data, col = info.col, colOpcional = info.colOpcional;
  var items = [];

  // Con tienda elegida, solo se listan los artículos que esa tienda tiene en
  // stock (cruce de "Cod Art Numero" contra la columna articulo del archivo
  // de stock), y cada item lleva su cantidad.
  var stockTienda = null, idxCodArt = -1;
  if (tiendaStock) {
    stockTienda = leerStockTienda(tiendaStock);
    if (!stockTienda) return salida({ encontrado: false, error: 'No hay stock cargado para la tienda ' + tiendaStock });
    idxCodArt = col('Cod Art Numero');
  }
  var agregar = function (row) {
    var producto = armarProducto(row, col, colOpcional);
    if (stockTienda) {
      var cantidad = stockTienda.articulos[normalizarCodigo(row[idxCodArt] || '')];
      if (!cantidad) return;
      producto.stock = cantidad;
    }
    items.push(producto);
  };
  var respuesta = function () {
    return salida({ encontrado: true, items: items, semanaStock: stockTienda ? stockTienda.semana : null });
  };

  // Categoría especial: no filtra por observación de canal sino por la
  // columna "Obsolescencia final" (solo productos marcados 50 o 100).
  if (categoria === 'OBSOLESCENCIA') {
    var idxObs = colOpcional('Obsolescencia final');
    for (var i = 1; i < data.length; i++) {
      var valObs = idxObs === -1 ? '' : (data[i][idxObs] || '').toString().trim();
      if (valObs === '50' || valObs === '100') {
        agregar(data[i]);
      }
    }
    return respuesta();
  }

  var idxEstatus = col(columnaObservacionPorTienda(tienda));
  var candidatos = (SINONIMOS_CATEGORIA[categoria] || [categoria]).map(normalizarTexto);

  for (var j = 1; j < data.length; j++) {
    var estatus = normalizarTexto(data[j][idxEstatus] || '');
    var coincide = candidatos.some(function (c) { return estatus.indexOf(c) !== -1; });
    if (coincide) {
      agregar(data[j]);
    }
  }
  return respuesta();
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
//                  Tipo = outlet para cadena OUTLET, estandar para el resto)
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

// Devuelve { semana, articulos: { codArtNormalizado: cantidad } } de una
// tienda, o null si la tienda no tiene stock cargado. Busca solo las filas
// de esa tienda con TextFinder en vez de leer toda la pestaña.
function leerStockTienda(tiendaKey) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var hoja = ss.getSheetByName(HOJA_STOCK);
  if (!hoja || hoja.getLastRow() < 2) return null;
  var clave = tiendaKey.toString().trim();
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
  return { semana: leerSemanaStock(ss), articulos: articulos };
}

function leerSemanaStock(ss) {
  var meta = ss.getSheetByName(HOJA_STOCK_META);
  return meta && meta.getLastRow() >= 2 ? meta.getRange(2, 6).getValue().toString() : null;
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
      tipo: f[2].toString() === 'outlet' ? 'outlet' : 'estandar',
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
