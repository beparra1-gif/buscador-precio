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
  if (accion === 'debugEvento') {
    return debugEvento();
  }
  if (accion === 'listarTiendasEvento') {
    return listarTiendasEvento();
  }
  if (accion === 'buscarCodigoEvento') {
    return buscarCodigoEvento(e.parameter.codigo, e.parameter.tiendaEvento);
  }
  if (accion === 'listarEvento') {
    return listarEvento(e.parameter.tiendaEvento);
  }
  if (accion === 'listarCategoria') {
    return listarCategoria(e.parameter.categoria, e.parameter.tienda);
  }
  // Por defecto (o accion === 'buscarCodigo'): buscar por código
  return buscarCodigo(e.parameter.codigo);
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
  'Cod 7 texto', 'Marca', 'GENERO', 'TIPO PRODUCTO', 'Proyecto',
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
  return {
    codigo: row[col('Cod 7 texto')].toString().trim().padStart(7, '0'),
    marca: leer('Marca'),
    genero: leer('GENERO'),
    tipoProducto: leer('TIPO PRODUCTO'),
    proyecto: leer('Proyecto'),
    fullPriceRetail: leer('Full Price Retail'),
    precioAntes: leer('Precio Antes'),
    precioTienda: leer('Nuevo Precio Final'),
    precioOutlet: leer('Precios Outlet'),
    precioPiloto: leer('Precio 30 tiendas'),
    obsolescencia: leerTexto('Obsolescencia final').trim()
  };
}

// Búsqueda de un solo código: en vez de leer las 15 mil filas completas,
// busca directo en la columna del código (como un Ctrl+F, corre del lado
// de Sheets) y recién ahí lee la única fila que interesa. Mucho más rápido
// que buscarCodigo cargando todo con obtenerDatos().
function buscarCodigo(codigoBuscar) {
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

function listarCategoria(categoria, tienda) {
  var info = obtenerDatos();
  var data = info.data, col = info.col, colOpcional = info.colOpcional;
  var items = [];

  // Categoría especial: no filtra por observación de canal sino por la
  // columna "Obsolescencia final" (solo productos marcados 50 o 100).
  if (categoria === 'OBSOLESCENCIA') {
    var idxObs = colOpcional('Obsolescencia final');
    for (var i = 1; i < data.length; i++) {
      var valObs = idxObs === -1 ? '' : (data[i][idxObs] || '').toString().trim();
      if (valObs === '50' || valObs === '100') {
        items.push(armarProducto(data[i], col, colOpcional));
      }
    }
    return salida({ encontrado: true, items: items });
  }

  var idxEstatus = col(columnaObservacionPorTienda(tienda));
  var candidatos = (SINONIMOS_CATEGORIA[categoria] || [categoria]).map(normalizarTexto);

  for (var j = 1; j < data.length; j++) {
    var estatus = normalizarTexto(data[j][idxEstatus] || '');
    var coincide = candidatos.some(function (c) { return estatus.indexOf(c) !== -1; });
    if (coincide) {
      items.push(armarProducto(data[j], col, colOpcional));
    }
  }
  return salida({ encontrado: true, items: items });
}

// ===================== EVENTO OUTLET =====================
// Hoja aparte de liquidaciones por tienda física (pestaña "TIENDAS EVENTO",
// detectada por contener "EVENTO" en el nombre). Se lee por NOMBRE de
// encabezado, igual que BASE PRECIOS (reutiliza obtenerEncabezados), porque
// los encabezados reales de esta hoja son:
// Tienda | Codigo | Marca | Genero | Categoria | Subcategoria | Proyecto |
// Observación | Precio Lleno | Precio Oferta Anterior | Nuevo Precio Oferta | Stock

// Endpoint temporal de diagnóstico: ?action=debugEvento
// Muestra los encabezados reales y una fila de ejemplo de la hoja Evento
// Outlet, para confirmar en qué columna está cada dato. Se puede borrar
// una vez que COL_EVENTO esté confirmado.
function debugEvento() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = encontrarHojaEvento(ss);
  if (!sheet) return salida({ encontrado: false, error: 'No se encontró ninguna hoja con "EVENTO" en el nombre' });
  var totalColumnas = sheet.getLastColumn();
  var encabezados = sheet.getRange(1, 1, 1, totalColumnas).getValues()[0];
  var filaEjemplo = sheet.getLastRow() > 1 ? sheet.getRange(2, 1, 1, totalColumnas).getValues()[0] : [];
  var letras = encabezados.map(function (_, i) { return columnaALetra(i); });
  return salida({
    encontrado: true,
    hoja: sheet.getName(),
    totalFilas: sheet.getLastRow(),
    totalColumnas: totalColumnas,
    letras: letras,
    encabezados: encabezados,
    filaEjemplo: filaEjemplo
  });
}

// Convierte un índice 0-based a letra de columna estilo Sheets (0->A, 1->B, ..., 26->AA)
function columnaALetra(indice) {
  var letra = '';
  var n = indice;
  while (n >= 0) {
    letra = String.fromCharCode((n % 26) + 65) + letra;
    n = Math.floor(n / 26) - 1;
  }
  return letra;
}

// Busca cualquier pestaña cuyo nombre contenga "EVENTO" (tolerante a
// tildes/mayúsculas/espacios). Si no existe, devuelve null — a diferencia
// de encontrarHojaBase(), acá NO hay respaldo a la primera hoja porque es
// una hoja aparte y opcional, no la base de datos principal de la app.
function encontrarHojaEvento(ss) {
  var hojas = ss.getSheets();
  for (var i = 0; i < hojas.length; i++) {
    if (normalizarTexto(hojas[i].getName()).indexOf('EVENTO') !== -1) return hojas[i];
  }
  return null;
}

function obtenerDatosEvento() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = encontrarHojaEvento(ss);
  if (!sheet) return null;
  var totalFilas = sheet.getLastRow();
  if (totalFilas < 1) return null;
  var info = obtenerEncabezados(sheet);
  // Empieza en la fila 2: se asume que la fila 1 tiene encabezados.
  var data = totalFilas > 1 ? sheet.getRange(2, 1, totalFilas - 1, info.totalColumnas).getValues() : [];
  return { data: data, col: info.col, colOpcional: info.colOpcional };
}

function armarProductoEvento(row, col, colOpcional) {
  var leer = function (nombre) {
    var idx = colOpcional(nombre);
    return idx === -1 ? null : row[idx];
  };
  return {
    tienda: (leer('Tienda') || '').toString().trim(),
    codigo: (leer('Codigo') || '').toString().trim().padStart(7, '0'),
    marca: leer('Marca'),
    genero: leer('Genero'),
    // Se reutilizan los nombres tipoProducto/precioInicial/precioAntes para que
    // el frontend (filtros, tarjetas, PDF) trate los items de evento igual que
    // los de BASE PRECIOS sin necesitar lógica aparte.
    tipoProducto: leer('Categoria'),
    subcategoria: leer('Subcategoria'),
    precioInicial: leer('Precio Lleno'),
    precioAntes: leer('Precio Oferta Anterior'),
    precioOferta: leer('Nuevo Precio Oferta'),
    stock: leer('Stock')
  };
}

// Lista los nombres de tienda distintos que aparecen en la columna "Tienda",
// para poblar el selector de "cuál tienda soy" en el frontend.
function listarTiendasEvento() {
  var info = obtenerDatosEvento();
  if (!info) return salida({ encontrado: false, error: 'No se encontró la hoja de Evento Outlet' });
  var idxTienda = info.col('Tienda');

  var vistas = {};
  var tiendas = [];
  info.data.forEach(function (row) {
    var t = (row[idxTienda] || '').toString().trim();
    if (t && !vistas[t]) {
      vistas[t] = true;
      tiendas.push(t);
    }
  });
  tiendas.sort();
  return salida({ encontrado: true, tiendas: tiendas });
}

function buscarCodigoEvento(codigoBuscar, tiendaEvento) {
  var info = obtenerDatosEvento();
  if (!info) return salida({ encontrado: false });

  var idxCodigo = info.col('Codigo');
  var idxTienda = info.col('Tienda');
  var buscado = normalizarCodigo(codigoBuscar || '');
  var tiendaNorm = normalizarTexto(tiendaEvento || '');

  for (var i = 0; i < info.data.length; i++) {
    var row = info.data[i];
    var codigoFila = normalizarCodigo(row[idxCodigo] || '');
    var tiendaFila = normalizarTexto(row[idxTienda] || '');
    if (codigoFila === buscado && (!tiendaNorm || tiendaFila === tiendaNorm)) {
      var resultado = armarProductoEvento(row, info.col, info.colOpcional);
      resultado.encontrado = true;
      return salida(resultado);
    }
  }
  return salida({ encontrado: false });
}

// Trae todo el stock de una tienda de evento (el frontend filtra/pagina
// del lado del cliente, igual que con las categorías de BASE PRECIOS).
function listarEvento(tiendaEvento) {
  var info = obtenerDatosEvento();
  if (!info) return salida({ encontrado: true, items: [] });

  var idxCodigo = info.col('Codigo');
  var idxTienda = info.col('Tienda');
  var tiendaNorm = normalizarTexto(tiendaEvento || '');
  var items = [];
  for (var i = 0; i < info.data.length; i++) {
    var row = info.data[i];
    var codigoFila = (row[idxCodigo] || '').toString().trim();
    if (!codigoFila) continue;
    var tiendaFila = normalizarTexto(row[idxTienda] || '');
    if (!tiendaNorm || tiendaFila === tiendaNorm) {
      items.push(armarProductoEvento(row, info.col, info.colOpcional));
    }
  }
  return salida({ encontrado: true, items: items });
}

function salida(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
