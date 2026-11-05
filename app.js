const urlAPI = "https://script.google.com/macros/s/AKfycbz3mu3U_1YyCILkGQOGrj3R6J0cIX0AdFZfEcMtU2c5nbbAXJRuwWiEewbi4W-mhKxQrQ/exec";

const FETCH_TIMEOUT_MS = 15000;

let html5QrcodeScanner = null;
let currentViewMode = 'list';
let audioCtx = null;

let itemsGlobales = [];
let categoriaActual = '';

let itemsFiltrados = [];
let paginaActual = 1;
const itemsPorPagina = 50;
let ordenPrecio = null; // 'asc' | 'desc' | null

const RANGO_PRECIO_LABEL = { p1: 'Menos de $10.000', p2: '$10.000 - $20.000', p3: '$20.000 - $30.000', p4: '$30.000 - $50.000', p5: 'Más de $50.000' };
const RANGO_DESCUENTO_LABEL = { d0: 'Sin descuento', d1: '1% - 10%', d2: '11% - 25%', d3: '26% - 50%', d4: 'Más de 50%' };

// Canal de tienda: define qué columna de precio del Sheet se usa en toda la app.
// Viene con la tienda: evento (EDP en scripts/tiendas_evento.txt, columna
// "Precio eventos outlet"), outlet (cadena OUTLET) o estandar (el resto).
const CAMPO_PRECIO_CANAL = { estandar: 'precioTienda', outlet: 'precioOutlet', evento: 'precioEvento' };
const LABEL_TIENDA = { estandar: 'Tienda Estándar', outlet: 'Outlet', evento: 'Evento Outlet' };
let tiendaActual = localStorage.getItem('tiendaSeleccionada') || null;
// Tienda física (EDP = tienda_key del archivo de stock). El usuario digita su
// EDP y de ahí sale todo: nombre (GLOSA TIENDA), cadena (cadena townhall) y el
// canal de precios (cadena OUTLET -> precios Outlet; el resto -> Estándar).
// Los listados y la búsqueda muestran solo/además el stock de esa tienda.
let tiendaStockActual = localStorage.getItem('tiendaStockSeleccionada') || null;
let infoTiendaStock = leerInfoTiendaGuardada();
let tiendasStockCache = null;

function leerInfoTiendaGuardada() {
    try { return JSON.parse(localStorage.getItem('tiendaStockInfo') || 'null'); } catch (e) { return null; }
}

// Fecha de la última carga de stock ({ semana: "202644", actualizado: "2026-11-04 06:10" }).
// Se reemplaza con lo que diga el servidor en cada respuesta (al abrir la app,
// al buscar y al listar), así siempre se muestra la carga más reciente.
let fechaStock = (() => {
    try { return JSON.parse(localStorage.getItem('stockFecha') || 'null'); } catch (e) { return null; }
})();

function actualizarFechaStock(semana, actualizado) {
    if (!semana && !actualizado) return;
    const previa = fechaStock || { semana: '', actualizado: '' };
    const nuevaSemana = semana ? semana.toString() : previa.semana;
    // Si la respuesta trae solo la semana y es la misma, se conserva la hora ya conocida
    const nuevaHora = actualizado ? actualizado.toString() : (nuevaSemana === previa.semana ? previa.actualizado : '');
    fechaStock = { semana: nuevaSemana, actualizado: nuevaHora };
    try { localStorage.setItem('stockFecha', JSON.stringify(fechaStock)); } catch (e) { /* sin almacenamiento */ }
    renderFechaStock();
}

function textoFechaStock() {
    if (!fechaStock) return '';
    const partes = [];
    // "2026-11-04 06:10" -> "04-11-2026 06:10"
    const m = (fechaStock.actualizado || '').match(/^(\d{4})-(\d{2})-(\d{2})(.*)$/);
    if (fechaStock.actualizado) partes.push('Stock actualizado ' + (m ? `${m[3]}-${m[2]}-${m[1]}${m[4]}` : fechaStock.actualizado));
    if (fechaStock.semana && fechaStock.semana.length >= 6) partes.push(`semana ${fechaStock.semana.slice(-2)}`);
    return partes.join(' · ');
}

function renderFechaStock() {
    const texto = textoFechaStock();
    document.querySelectorAll('.fecha-stock').forEach(el => {
        el.textContent = texto;
        el.style.display = texto ? 'block' : 'none';
    });
}

// Aviso rojo "EVENTO OUTLET" arriba de todas las pantallas (menos la de
// ingreso de EDP) cuando la tienda usa los precios de evento.
function actualizarAvisoEvento() {
    const aviso = document.getElementById('avisoEvento');
    if (!aviso) return;
    const enIngreso = document.getElementById('view-0').classList.contains('active');
    aviso.style.display = (tiendaActual === 'evento' && !enIngreso) ? 'block' : 'none';
}

if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(err => console.log('PWA no registrada', err));
}

function tiendaConfiguradaValida() {
    if (!tiendaActual) return false;
    return !!CAMPO_PRECIO_CANAL[tiendaActual] && !!tiendaStockActual && !!infoTiendaStock;
}

// Parámetro &tiendaStock=... para el Apps Script
function paramTiendaStock() {
    if (!tiendaStockActual) return '';
    return `&tiendaStock=${encodeURIComponent(tiendaStockActual)}`;
}

document.addEventListener("DOMContentLoaded", () => {
    cargarRecientes();
    renderFechaStock();
    if (tiendaConfiguradaValida()) {
        actualizarChipTienda();
        cambiarVista('view-1');
        refrescarTiendaGuardada();
    } else {
        abrirSelectorTienda();
    }
});

// La tienda guardada en el celular puede quedar desactualizada (ej. pasó a ser
// tienda evento, o cambió su nombre/cadena en BASE.xlsx): se vuelve a leer en
// segundo plano al abrir la app y, si cambió, se actualiza sin pedir la EDP.
async function refrescarTiendaGuardada() {
    try {
        const data = await fetchConTimeout(`${urlAPI}?action=listarTiendasStock`);
        if (!data.encontrado || !data.tiendas) return;
        tiendasStockCache = data.tiendas;
        actualizarFechaStock(data.semana, data.actualizado);
        const t = buscarTiendaPorEdp(tiendaStockActual);
        if (t && (t.tipo !== tiendaActual || t.nombre !== infoTiendaStock.nombre || t.cadena !== infoTiendaStock.cadena)) {
            guardarTienda(t);
        }
    } catch (e) { /* sin conexión: se sigue con lo guardado */ }
}

function guardarTienda(t) {
    tiendaStockActual = t.tienda;
    infoTiendaStock = { nombre: t.nombre, cadena: t.cadena, tipo: t.tipo };
    tiendaActual = t.tipo;
    localStorage.setItem('tiendaStockSeleccionada', tiendaStockActual);
    localStorage.setItem('tiendaStockInfo', JSON.stringify(infoTiendaStock));
    localStorage.setItem('tiendaSeleccionada', tiendaActual);
    actualizarChipTienda();
    actualizarAvisoEvento();
}

// Pantalla inicial: el usuario digita su EDP. La lista de tiendas se trae una
// vez (para validar la EDP y mostrar nombre/cadena mientras escribe).
async function abrirSelectorTienda() {
    cambiarVista('view-0');
    const input = document.getElementById('edpInput');
    input.value = tiendaStockActual || '';
    previsualizarTienda();
    if (tiendasStockCache) return;
    const info = document.getElementById('infoSemanaStock');
    info.innerText = 'Cargando tiendas...';
    try {
        const data = await fetchConTimeout(`${urlAPI}?action=listarTiendasStock`);
        if (data.encontrado && data.tiendas && data.tiendas.length > 0) {
            tiendasStockCache = data.tiendas;
            actualizarFechaStock(data.semana, data.actualizado);
            info.innerText = textoFechaStock();
        } else {
            info.innerText = 'El stock por tienda aún no está cargado.';
        }
    } catch (e) {
        info.innerText = 'No se pudo cargar la lista de tiendas. Revise su conexión.';
    }
    previsualizarTienda();
}

function buscarTiendaPorEdp(edp) {
    const limpio = (edp || '').toString().trim().replace(/^0+/, '');
    if (!limpio || !tiendasStockCache) return null;
    return tiendasStockCache.find(t => t.tienda.replace(/^0+/, '') === limpio) || null;
}

function previsualizarTienda() {
    const prev = document.getElementById('previewTienda');
    const edp = document.getElementById('edpInput').value.trim();
    if (!edp || !tiendasStockCache) { prev.style.display = 'none'; return; }
    const t = buscarTiendaPorEdp(edp);
    prev.style.display = 'block';
    if (!t) {
        prev.className = 'preview-tienda no-encontrada';
        prev.innerHTML = `EDP ${edp} no encontrada o sin stock cargado`;
        return;
    }
    prev.className = 'preview-tienda' + (t.tipo === 'evento' ? ' evento' : '');
    prev.innerHTML = `
        ${t.tipo === 'evento' ? '<div class="preview-evento">EVENTO OUTLET</div>' : ''}
        <div class="preview-nombre">${t.nombre || 'Tienda ' + t.tienda}</div>
        <div class="preview-meta">${t.cadena || '--'} · Precios ${LABEL_TIENDA[t.tipo] || ''} · ${t.articulos} artículos con stock</div>`;
}

function confirmarTiendaStock() {
    const edp = document.getElementById('edpInput').value.trim();
    if (!edp) return mostrarToast('Digite el EDP de su tienda', 'error');
    if (!tiendasStockCache) return mostrarToast('Aún no se cargan las tiendas. Intente en unos segundos.', 'error');
    const t = buscarTiendaPorEdp(edp);
    if (!t) return mostrarToast(`El EDP ${edp} no existe o no tiene stock cargado.`, 'error');

    guardarTienda(t);
    cambiarVista('view-1');
}

function actualizarChipTienda() {
    const label = document.getElementById('tiendaActualLabel');
    if (!label) return;
    if (infoTiendaStock) {
        label.textContent = `${infoTiendaStock.nombre || tiendaStockActual} · ${infoTiendaStock.cadena || LABEL_TIENDA[tiendaActual]}`;
    } else {
        label.textContent = LABEL_TIENDA[tiendaActual] || '--';
    }
}

// Precio/valor de la hoja a número: acepta 12990, "12990" o "$12.990" (NaN si viene vacío)
function aNumero(v) {
    if (v === undefined || v === null || v === '') return NaN;
    if (typeof v === 'number') return Math.round(v);
    const limpio = v.toString().replace(/\D/g, '');
    return limpio === '' ? NaN : parseInt(limpio, 10);
}

// true si el campo trae algo que mostrar (ni vacío ni "--")
function tieneValor(v) {
    if (v === undefined || v === null) return false;
    const s = v.toString().trim();
    return s !== '' && s !== '--';
}

// Precio del canal de la tienda (Estándar / Outlet / Evento Outlet)
function precioCanal(item) {
    return item[CAMPO_PRECIO_CANAL[tiendaActual] || 'precioTienda'];
}

// Precio de referencia contra el que se mide el canal: Full Price Retail, salvo
// en tiendas evento, que se comparan contra el precio estándar. Es el mismo
// criterio que usa el backend (categoriaPrecio en Codigo.gs) para armar los
// listados Alzas/Bajas/Sin Cambios, así lista, detalle y PDF siempre coinciden.
function precioBaseCanal(item) {
    return tiendaActual === 'evento' ? item.precioTienda : item.fullPriceRetail;
}
function labelPrecioBase() {
    return tiendaActual === 'evento' ? 'Precio Estándar' : 'Precio Inicial';
}

// Alza / baja / igual del precio del canal respecto al precio base, con su %
function compararPrecioCanal(item) {
    const base = aNumero(precioBaseCanal(item));
    const canal = aNumero(precioCanal(item));
    if (!base || !canal) return { tipo: 'igual', pct: 0 };
    if (canal > base) return { tipo: 'alza', pct: Math.round((canal - base) / base * 100) };
    if (canal < base) return { tipo: 'baja', pct: Math.round((base - canal) / base * 100) };
    return { tipo: 'igual', pct: 0 };
}

// Normaliza la columna "Obsolescencia final" (50, 100 o vacío) a '50' | '100' | ''
function obtenerNivelObsolescencia(valor) {
    if (valor === undefined || valor === null) return '';
    const str = valor.toString().trim();
    if (str === '50') return '50';
    if (str === '100') return '100';
    return '';
}

function renderObsolescenciaAlert(nivel) {
    if (!nivel) return '';
    const mensaje = nivel === '100'
        ? 'Obsolescencia 100% — producto descontinuado'
        : 'Obsolescencia 50% — posible descontinuación';
    return `<div class="obsolescencia-alert nivel-${nivel}"><span class="obs-dot"></span><span>${mensaje}</span></div>`;
}

// Pastilla de stock de la tienda, junto al código del producto (detalle y
// listados). Solo viene "stock" cuando hay una tienda elegida (0 = no lo tiene).
function renderStockTienda(stock) {
    if (stock === undefined || stock === null || stock === '') return '';
    return Number(stock) > 0
        ? `<span class="item-stock">Stock: ${stock}</span>`
        : `<span class="item-stock sin-stock">Sin stock</span>`;
}

function renderObsolescenciaBadge(nivel) {
    if (!nivel) return '';
    return `<span class="item-badge-obsolescencia nivel-${nivel}"><span class="obs-dot"></span>Obs. ${nivel}%</span>`;
}

// Muestra el código de 7 dígitos con guión tras el 3ro (ej. 8811970 -> 881-1970,
// 23456 -> 0023456 -> 002-3456), en el detalle, los listados y el PDF.
function formatearCodigoConGuion(codigo) {
    const c = (codigo || '').toString().trim().padStart(7, '0');
    return c.slice(0, 3) + '-' + c.slice(3);
}

const formatearMoneda = (valor) => {
    if (!tieneValor(valor)) return '--';
    const numero = aNumero(valor);
    if (isNaN(numero)) return valor.toString().trim();
    return new Intl.NumberFormat('es-CL', { style: 'currency', currency: 'CLP', maximumFractionDigits: 0 }).format(numero);
};

// Formatea la fecha de actualización de precio, venga como ISO (Date de Apps Script) o como texto ya legible
function formatearFecha(valor) {
    if (valor === undefined || valor === null || valor === '') return '';
    const str = valor.toString().trim();
    if (str === '' || str === '--') return '';
    const fecha = new Date(str);
    if (isNaN(fecha.getTime())) return str;
    // timeZone UTC evita que la fecha se corra un día por la zona horaria del navegador
    return new Intl.DateTimeFormat('es-CL', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' }).format(fecha);
}

// Wrapper de fetch con timeout, para no dejar el loader colgado si la API no responde
async function fetchConTimeout(url, timeoutMs = FETCH_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, { signal: controller.signal });
        return await res.json();
    } finally {
        clearTimeout(timer);
    }
}

// Toast no bloqueante para reemplazar alert()
function mostrarToast(mensaje, tipo = 'info') {
    let container = document.getElementById('toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toast-container';
        document.body.appendChild(container);
    }
    const toast = document.createElement('div');
    toast.className = 'toast' + (tipo === 'error' ? ' error' : '');
    toast.textContent = mensaje;
    container.appendChild(toast);

    requestAnimationFrame(() => toast.classList.add('show'));
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    }, 3200);
}

function cambiarVista(viewId) {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById(viewId).classList.add('active');
    actualizarAvisoEvento();
    if(viewId === 'view-1') {
        document.getElementById('codigoInput').focus();
        cargarRecientes();
    }
}

function initAudio() { if (!audioCtx) { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } }

function playBeep() {
    if (!audioCtx) return;
    const osc = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();
    osc.connect(gainNode);
    gainNode.connect(audioCtx.destination);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, audioCtx.currentTime);
    gainNode.gain.setValueAtTime(0.1, audioCtx.currentTime);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.1);
}

function abrirScanner() {
    initAudio();
    document.getElementById('scanner-modal').style.display = 'flex';
    if (!html5QrcodeScanner) { html5QrcodeScanner = new Html5Qrcode("reader"); }
    const config = { fps: 10, qrbox: { width: 260, height: 140 } };
    html5QrcodeScanner.start({ facingMode: "environment" }, config, onScanSuccess)
    .catch(err => {
        mostrarToast("Active los permisos de cámara en su navegador.", 'error');
        cerrarScanner();
    });
}

function cerrarScanner() {
    document.getElementById('scanner-modal').style.display = 'none';
    if (html5QrcodeScanner) { html5QrcodeScanner.stop().catch(e => console.log(e)); }
}

function onScanSuccess(decodedText) {
    // El lector puede disparar varias lecturas antes de detenerse: solo vale la primera
    if (document.getElementById('scanner-modal').style.display === 'none') return;
    playBeep();
    cerrarScanner();
    document.getElementById('codigoInput').value = decodedText;
    cambiarVista('view-1');
    procesarCodigo();
}

function guardarReciente(cod) {
    let recents = JSON.parse(localStorage.getItem('recents') || '[]');
    recents = recents.filter(c => c !== cod);
    recents.unshift(cod);
    if(recents.length > 5) recents.pop();
    localStorage.setItem('recents', JSON.stringify(recents));
}

function cargarRecientes() {
    let recents = JSON.parse(localStorage.getItem('recents') || '[]');
    const section = document.getElementById('recentsSection');
    const list = document.getElementById('recentsList');
    if(recents.length === 0) { section.style.display = 'none'; return; }
    section.style.display = 'block';
    list.innerHTML = recents.map(c => `<div class="chip-recent" onclick="procesarCodigo('${c}')"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg> ${c}</div>`).join('');
}

// Cada consulta a la API (búsqueda o listado) recibe un número correlativo. Si
// el usuario lanza otra antes de que llegue la respuesta (doble toque, escaneo
// repetido, recientes), la respuesta vieja se descarta y no pisa a la nueva.
let consultaActual = 0;
function iniciarConsulta() {
    consultaActual++;
    document.getElementById('loading').style.display = 'block';
    return consultaActual;
}
// true si la consulta sigue siendo la última; si lo es, apaga el loader
function esConsultaVigente(id) {
    if (id !== consultaActual) return false;
    document.getElementById('loading').style.display = 'none';
    return true;
}

function mostrarErrorConsulta(error, mensajeConexion) {
    if (error.name === 'AbortError') {
        mostrarToast("La consulta demoró demasiado. Intente nuevamente.", 'error');
    } else {
        mostrarToast(mensajeConexion, 'error');
    }
}

// Bloque "Precio Inicial / Precio Antes" + precio actual del detalle. "Precio
// Antes" se omite cuando el producto no lo tiene cargado.
function renderPreciosDetalle(data) {
    const comparacion = compararPrecioCanal(data);
    const precioActualTexto = formatearMoneda(precioCanal(data));
    const hayAntes = tieneValor(data.precioAntes);

    const estiloBase = comparacion.tipo === 'igual'
        ? 'color: var(--text-muted);'
        : 'color: var(--text-muted); text-decoration: line-through;';
    const estiloAntes = {
        alza: 'font-weight: 600; color: var(--text-main);',
        baja: 'color: var(--text-muted); text-decoration: line-through;',
        igual: 'color: var(--text-muted);'
    }[comparacion.tipo];

    const referencias = `
        <div class="price-alza-box">
            <div class="price-alza-item">
                <span class="price-label">${labelPrecioBase()}</span>
                <span style="${estiloBase}">${formatearMoneda(precioBaseCanal(data))}</span>
            </div>
            ${hayAntes ? `
            <div class="price-alza-item">
                <span class="price-label">Precio Antes</span>
                <span style="${estiloAntes}">${formatearMoneda(data.precioAntes)}</span>
            </div>` : ''}
        </div>`;

    let cuerpo;
    if (comparacion.tipo === 'alza') {
        cuerpo = `
            ${referencias}
            <div class="price-label" style="color: var(--accent-red); font-weight: bold;">⚠️ Novedad: Alza de Precio +${comparacion.pct}%</div>
            <div class="price-actual alert-red">${precioActualTexto}</div>`;
    } else if (comparacion.tipo === 'baja') {
        cuerpo = `
            <div style="text-align: center;"><div class="discount-badge">BAJA DE PRECIO -${comparacion.pct}%</div></div>
            ${referencias}
            <div class="price-label" style="margin-top: 10px;">Precio Actual</div>
            <div class="price-actual">${precioActualTexto}</div>`;
    } else {
        cuerpo = `
            ${referencias}
            <div class="price-label">Precio Actual</div>
            <div class="price-actual" style="color: var(--primary);">${precioActualTexto}</div>
            <div style="font-size: 12px; color: var(--text-muted); margin-top: 5px;">Sin variaciones recientes</div>`;
    }

    let html = `<div class="label-canal">Precio ${LABEL_TIENDA[tiendaActual] || ''}</div><div class="price-container">${cuerpo}</div>`;
    const fechaTxt = formatearFecha(data.fechaActualizacion);
    if (fechaTxt) {
        html += `<div style="font-size: 11px; color: var(--text-light); text-align: center; margin-top: 8px;">Precio actualizado el ${fechaTxt}</div>`;
    }
    return html;
}

function renderFotoDetalle(codigo) {
    const imgContainer = document.getElementById('imgContenedor');
    imgContainer.innerHTML = '';
    imgContainer.style.background = '';
    imgContainer.style.border = '';
    const urlBusquedaBata = `https://www.bata.com/cl/search?q=${codigo}`;

    const imgElement = document.createElement('img');
    imgElement.style.width = '100%';
    imgElement.style.height = '100%';
    imgElement.style.objectFit = 'contain';

    let attempt = 0;
    imgElement.onerror = function() {
        attempt++;
        if (attempt === 1) imgElement.src = `./fotos/${codigo}.JPG`;
        else {
            imgContainer.style.background = '#F9FAFB';
            imgContainer.style.border = '1px dashed #D1D5DB';
            imgContainer.innerHTML = `<a href="${urlBusquedaBata}" target="_blank" style="color:var(--text-muted); text-decoration:none; display:flex; flex-direction:column; align-items:center; justify-content:center; width:100%; height:100%; padding: 10px;"><span style="font-size:24px;">📸</span><span style="font-size:12px; font-weight:600; margin-top:5px;">Foto no encontrada</span><span style="color:var(--primary); font-size:11px; text-decoration:underline; margin-top:3px; text-align:center;">Ver en web oficial</span></a>`;
        }
    };
    imgElement.src = `./fotos/${codigo}.jpg`;
    imgContainer.appendChild(imgElement);
}

async function procesarCodigo(codDirecto = null) {
    let codigo = codDirecto || document.getElementById('codigoInput').value.trim();
    if(!codigo) return mostrarToast("Ingrese o escanee un código válido", 'error');

    if (codigo.length === 13 && !isNaN(codigo)) codigo = codigo.substring(1, 8);
    codigo = codigo.padStart(7, '0');
    if(!codDirecto) document.getElementById('codigoInput').value = codigo;

    const id = iniciarConsulta();
    const urlBusqueda = `${urlAPI}?action=buscarCodigo&codigo=${encodeURIComponent(codigo)}${paramTiendaStock()}`;

    try {
        const data = await fetchConTimeout(urlBusqueda);
        if (!esConsultaVigente(id)) return;

        if (!data.encontrado) {
            return mostrarToast("El código " + codigo + " no se encuentra.", 'error');
        }

        guardarReciente(codigo);
        actualizarFechaStock(data.semanaStock, data.stockActualizado);

        document.getElementById('tituloProducto').innerHTML = formatearCodigoConGuion(data.codigo || codigo) + renderStockTienda(data.stock);

        document.getElementById('outMarca').innerText = data.marca || '--';
        document.getElementById('outGenero').innerText = data.genero || '--';
        document.getElementById('outTipoProd').innerText = data.tipoProducto || '--';
        document.getElementById('outProyecto').innerText = tieneValor(data.proyecto) ? data.proyecto : '--';

        document.getElementById('priceContainerDynamic').innerHTML = renderPreciosDetalle(data);

        const nivelObs = obtenerNivelObsolescencia(data.obsolescencia);
        document.getElementById('obsolescenciaContainer').innerHTML = renderObsolescenciaAlert(nivelObs);
        const infoBoxEl = document.getElementById('infoBoxProducto');
        infoBoxEl.classList.remove('obsolescencia-50', 'obsolescencia-100');
        if (nivelObs) infoBoxEl.classList.add('obsolescencia-' + nivelObs);

        renderFotoDetalle(codigo);
        cambiarVista('view-2');
    } catch (error) {
        if (!esConsultaVigente(id)) return;
        mostrarErrorConsulta(error, "Error de conexión.");
    }
}

// Resetea los selects de filtro y muestra/oculta los grupos que corresponden:
// Obsolescencia solo en ese apartado, Punta de Precio solo en tiendas Outlet y Evento Outlet
// (donde se trabaja con precios redondos tipo $990 / $5.000 / $10.000).
function prepararFiltrosParaListado(modo) {
    document.getElementById('filterPrecio').value = 'ALL';
    document.getElementById('filterDescuento').value = 'ALL';
    document.getElementById('filterObsolescencia').value = 'ALL';
    document.getElementById('filterPuntaPrecio').value = 'ALL';

    document.getElementById('grupoFiltroObsolescencia').style.display = (modo === 'obsolescencia') ? 'block' : 'none';
    document.getElementById('grupoFiltroPuntaPrecio').style.display = (tiendaActual === 'outlet' || tiendaActual === 'evento') ? 'block' : 'none';

    ordenPrecio = null;
    document.getElementById('btnOrdenAsc').classList.remove('active');
    document.getElementById('btnOrdenDesc').classList.remove('active');
}

async function cargarLista(categoria, tituloHumanizado) {
    const id = iniciarConsulta();
    document.getElementById('tituloLista').innerText = tituloHumanizado;
    document.getElementById('listaContenedor').innerHTML = '';
    prepararFiltrosParaListado(categoria === 'OBSOLESCENCIA' ? 'obsolescencia' : 'normal');
    categoriaActual = categoria;
    // Exportar a PDF solo tiene sentido para Alzas/Bajas (no para Sin Cambios ni Obsolescencia)
    document.getElementById('btnExportarPDF').style.display = (categoria === 'SUBE' || categoria === 'BAJA') ? 'flex' : 'none';

    try {
        const data = await fetchConTimeout(`${urlAPI}?action=listarCategoria&categoria=${categoria}&tienda=${tiendaActual}${paramTiendaStock()}`);
        if (!esConsultaVigente(id)) return;
        actualizarFechaStock(data.semanaStock, data.stockActualizado);

        if (data.encontrado && data.items && data.items.length > 0) {
            itemsGlobales = data.items;
            itemsFiltrados = [...itemsGlobales];
            paginaActual = 1;

            poblarFiltros(itemsGlobales);
            renderizarFiltrosActivos();
            renderizarPagina();

            cambiarVista('view-3');
        } else {
            mostrarToast(paramTiendaStock() ? "No se encontraron artículos con stock en su tienda." : "No se encontraron artículos.", 'error');
        }
    } catch(e) {
        if (!esConsultaVigente(id)) return;
        mostrarErrorConsulta(e, "Error al cargar la lista.");
    }
}

function poblarFiltros(items) {
    const setMarcas = new Set();
    const setGeneros = new Set();
    const setTipos = new Set();

    items.forEach(item => {
        if (item.marca && item.marca !== '--') setMarcas.add(item.marca);
        if (item.genero && item.genero !== '--') setGeneros.add(item.genero);
        if (item.tipoProducto && item.tipoProducto !== '--') setTipos.add(item.tipoProducto);
    });

    const fMarca = document.getElementById('filterMarca');
    const fGenero = document.getElementById('filterGenero');
    const fTipo = document.getElementById('filterTipo');

    fMarca.innerHTML = '<option value="ALL">Todas las Marcas</option>' + Array.from(setMarcas).sort().map(m => `<option value="${m}">${m}</option>`).join('');
    fGenero.innerHTML = '<option value="ALL">Todos los Géneros</option>' + Array.from(setGeneros).sort().map(g => `<option value="${g}">${g}</option>`).join('');
    fTipo.innerHTML = '<option value="ALL">Todos los Tipos</option>' + Array.from(setTipos).sort().map(t => `<option value="${t}">${t}</option>`).join('');
}

// Bucket de precio para el filtro "Rango de Precio" (usa el precio del canal activo)
function obtenerRangoPrecio(valor) {
    const n = aNumero(valor);
    if (isNaN(n)) return null;
    if (n < 10000) return 'p1';
    if (n < 20000) return 'p2';
    if (n < 30000) return 'p3';
    if (n < 50000) return 'p4';
    return 'p5';
}

// Bucket de % de descuento para el filtro "Nivel de Descuento" (0 si no hay baja)
function obtenerRangoDescuento(pct) {
    if (!pct || pct <= 0) return 'd0';
    if (pct <= 10) return 'd1';
    if (pct <= 25) return 'd2';
    if (pct <= 50) return 'd3';
    return 'd4';
}

function aplicarFiltros() {
    const vMarca = document.getElementById('filterMarca').value;
    const vGenero = document.getElementById('filterGenero').value;
    const vTipo = document.getElementById('filterTipo').value;
    const vPrecio = document.getElementById('filterPrecio').value;
    const vDescuento = document.getElementById('filterDescuento').value;
    const vObsolescencia = document.getElementById('filterObsolescencia').value;
    const vPuntaPrecio = document.getElementById('filterPuntaPrecio').value;

    const filtrados = itemsGlobales.filter(item => {
        const pasaMarca = vMarca === "ALL" || item.marca === vMarca;
        const pasaGenero = vGenero === "ALL" || item.genero === vGenero;
        const pasaTipo = vTipo === "ALL" || item.tipoProducto === vTipo;
        const pasaObsolescencia = vObsolescencia === "ALL" || obtenerNivelObsolescencia(item.obsolescencia) === vObsolescencia;
        const pasaPrecio = vPrecio === 'ALL' || obtenerRangoPrecio(precioCanal(item)) === vPrecio;

        let pasaDescuento = true;
        if (vDescuento !== 'ALL') {
            const comparacion = compararPrecioCanal(item);
            const pct = comparacion.tipo === 'baja' ? comparacion.pct : 0;
            pasaDescuento = obtenerRangoDescuento(pct) === vDescuento;
        }

        // Punta de precio: coincidencia EXACTA con el precio del canal (ej. $990, $5.000),
        // a diferencia de Rango de Precio que agrupa por tramos.
        const pasaPuntaPrecio = vPuntaPrecio === 'ALL' || aNumero(precioCanal(item)) === parseInt(vPuntaPrecio, 10);

        return pasaMarca && pasaGenero && pasaTipo && pasaObsolescencia && pasaPuntaPrecio && pasaPrecio && pasaDescuento;
    });

    if (ordenPrecio) {
        const leerPrecio = (item) => aNumero(precioCanal(item)) || 0;
        filtrados.sort((a, b) => ordenPrecio === 'asc' ? leerPrecio(a) - leerPrecio(b) : leerPrecio(b) - leerPrecio(a));
    }

    itemsFiltrados = filtrados;
    paginaActual = 1;
    renderizarFiltrosActivos();
    renderizarPagina();
}

function abrirFiltros() {
    document.getElementById('filtros-modal').classList.add('active');
}

function cerrarFiltros() {
    document.getElementById('filtros-modal').classList.remove('active');
}

function setOrdenPrecio(orden) {
    ordenPrecio = (ordenPrecio === orden) ? null : orden;
    document.getElementById('btnOrdenAsc').classList.toggle('active', ordenPrecio === 'asc');
    document.getElementById('btnOrdenDesc').classList.toggle('active', ordenPrecio === 'desc');
}

function guardarFiltros() {
    aplicarFiltros();
    cerrarFiltros();
}

function borrarFiltros() {
    ['filterMarca', 'filterGenero', 'filterTipo', 'filterPrecio', 'filterDescuento', 'filterObsolescencia', 'filterPuntaPrecio'].forEach(id => {
        document.getElementById(id).value = 'ALL';
    });
    ordenPrecio = null;
    document.getElementById('btnOrdenAsc').classList.remove('active');
    document.getElementById('btnOrdenDesc').classList.remove('active');
    aplicarFiltros();
    cerrarFiltros();
}

// Quita un filtro puntual desde su chip en la pantalla de listado, sin abrir el modal
function quitarFiltro(id) {
    if (id === '__orden') {
        ordenPrecio = null;
        document.getElementById('btnOrdenAsc').classList.remove('active');
        document.getElementById('btnOrdenDesc').classList.remove('active');
    } else {
        document.getElementById(id).value = 'ALL';
    }
    aplicarFiltros();
}

function renderizarFiltrosActivos() {
    const cont = document.getElementById('filtrosActivos');
    const contador = document.getElementById('filtrosContador');
    const chips = [];

    const agregar = (id, etiqueta, formatear) => {
        const el = document.getElementById(id);
        if (el.value !== 'ALL') chips.push({ id, texto: `${etiqueta}: ${formatear ? formatear(el.value) : el.value}` });
    };

    agregar('filterMarca', 'Marca');
    agregar('filterGenero', 'Género');
    agregar('filterTipo', 'Tipo');
    agregar('filterObsolescencia', 'Obsolescencia', v => `${v}%`);
    agregar('filterPrecio', 'Precio', v => RANGO_PRECIO_LABEL[v] || v);
    agregar('filterPuntaPrecio', 'Punta Precio', v => `$${Number(v).toLocaleString('es-CL')}`);
    agregar('filterDescuento', 'Descuento', v => RANGO_DESCUENTO_LABEL[v] || v);
    if (ordenPrecio) chips.push({ id: '__orden', texto: `Orden: ${ordenPrecio === 'asc' ? 'Menor a Mayor' : 'Mayor a Menor'}` });

    document.getElementById('filtrosContador').style.display = chips.length > 0 ? 'flex' : 'none';
    contador.textContent = chips.length;

    if (chips.length === 0) {
        cont.style.display = 'none';
        cont.innerHTML = '';
        return;
    }

    cont.style.display = 'flex';
    cont.innerHTML = chips.map(c =>
        `<span class="chip-filtro">${c.texto} <span class="quitar" onclick="quitarFiltro('${c.id}')">&times;</span></span>`
    ).join('') + `<span class="chip-filtro chip-borrar" onclick="borrarFiltros()">Borrar todo</span>`;
}

function renderizarPagina() {
    const inicio = (paginaActual - 1) * itemsPorPagina;
    const fin = inicio + itemsPorPagina;
    const itemsA_Mostrar = itemsFiltrados.slice(inicio, fin);

    renderizarItems(itemsA_Mostrar);
    renderizarControlesPaginacion();
}

function renderizarControlesPaginacion() {
    const totalPaginas = Math.ceil(itemsFiltrados.length / itemsPorPagina);
    const contPaginacion = document.getElementById('paginacionContenedor');

    if (totalPaginas <= 1) {
        contPaginacion.style.display = 'none';
        return;
    }

    contPaginacion.style.display = 'flex';
    document.getElementById('pagTexto').innerText = `Página ${paginaActual} de ${totalPaginas}`;
    document.getElementById('btnPrev').disabled = paginaActual === 1;
    document.getElementById('btnNext').disabled = paginaActual === totalPaginas;
}

function cambiarPagina(delta) {
    const totalPaginas = Math.ceil(itemsFiltrados.length / itemsPorPagina);
    paginaActual += delta;
    if (paginaActual < 1) paginaActual = 1;
    if (paginaActual > totalPaginas) paginaActual = totalPaginas;

    renderizarPagina();

    document.getElementById('listaContenedor').scrollTop = 0;
}

function renderizarItems(items) {
    const contenedor = document.getElementById('listaContenedor');
    contenedor.innerHTML = '';

    if(items.length === 0) {
        contenedor.innerHTML = '<div style="text-align:center; padding:20px; color:var(--text-muted);">No hay productos que coincidan con los filtros.</div>';
        return;
    }

    items.forEach(item => {
        const codigo = item.codigo ? item.codigo.toString().padStart(7, '0') : '';
        const urlFoto = `./fotos/${codigo}.jpg`;
        const urlFotoUpper = `./fotos/${codigo}.JPG`;

        // El badge sale de la misma comparación que el detalle (canal vs FPR,
        // o vs estándar en Evento), no de la categoría del listado.
        const comparacion = compararPrecioCanal(item);
        let badgeHtml = '';
        if (comparacion.tipo === 'baja') badgeHtml = `<div class="item-discount">-${comparacion.pct}%</div>`;
        if (comparacion.tipo === 'alza') badgeHtml = `<div style="font-size: 11px; color: var(--accent-red); font-weight: 600;">⚠️ Alza +${comparacion.pct}%</div>`;

        const nivelObs = obtenerNivelObsolescencia(item.obsolescencia);
        const claseObs = nivelObs ? ` obsolescencia-${nivelObs}` : '';
        const badgeObs = renderObsolescenciaBadge(nivelObs);

        const metaTexto = `${item.marca || '--'} | ${item.genero || '--'}`;

        const card = document.createElement('div');
        card.className = 'item-card' + claseObs;
        card.onclick = () => procesarCodigo(codigo);

        card.innerHTML = `
            <img src="${urlFoto}" loading="lazy" decoding="async" onerror="this.onerror=null; this.src='${urlFotoUpper}';">
            <div class="item-details">
                <div class="item-header-row">
                    <div class="item-code">${formatearCodigoConGuion(codigo)}${renderStockTienda(item.stock)}${badgeObs}</div>
                    ${badgeHtml}
                </div>
                <div class="item-meta">${metaTexto}</div>
                <div class="item-prices">
                    <div class="item-price-old">
                        <span>${labelPrecioBase()}</span>
                        ${formatearMoneda(precioBaseCanal(item))}
                    </div>
                    ${tieneValor(item.precioAntes) ? `
                    <div class="item-price-old">
                        <span>Precio Antes</span>
                        ${formatearMoneda(item.precioAntes)}
                    </div>` : ''}
                    <div class="item-price-new">
                        ${formatearMoneda(precioCanal(item))}
                    </div>
                </div>
            </div>
        `;
        contenedor.appendChild(card);
    });
}

function toggleViewMode() {
    const cont = document.getElementById('listaContenedor');
    if (currentViewMode === 'list') {
        cont.classList.remove('list-view');
        cont.classList.add('grid-view');
        currentViewMode = 'grid';
    } else {
        cont.classList.remove('grid-view');
        cont.classList.add('list-view');
        currentViewMode = 'list';
    }
}

// Con fotos de miles de productos, generar el PDF en el navegador se vuelve
// lento y puede colgar el celular — por eso hay un tope y se pide filtrar más.
const LIMITE_EXPORTACION_PDF = 150;

async function cargarImagenComoDataURL(url) {
    try {
        const res = await fetch(url);
        if (!res.ok) return null;
        const blob = await res.blob();
        return await new Promise((resolve) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.onerror = () => resolve(null);
            reader.readAsDataURL(blob);
        });
    } catch (e) {
        return null;
    }
}

async function cargarImagenProducto(codigo) {
    let img = await cargarImagenComoDataURL(`./fotos/${codigo}.jpg`);
    if (!img) img = await cargarImagenComoDataURL(`./fotos/${codigo}.JPG`);
    return img;
}

async function exportarListadoPDF() {
    if (categoriaActual !== 'SUBE' && categoriaActual !== 'BAJA') {
        return mostrarToast('La exportación solo está disponible para Alzas o Bajas de Precio.', 'error');
    }
    if (itemsFiltrados.length === 0) {
        return mostrarToast('No hay productos para exportar.', 'error');
    }
    if (itemsFiltrados.length > LIMITE_EXPORTACION_PDF) {
        return mostrarToast(`Hay ${itemsFiltrados.length} productos — no es posible cargar tantas fotos a la vez. El máximo para exportar es ${LIMITE_EXPORTACION_PDF}. Aplica más filtros (marca, género, precio) para reducir la cantidad.`, 'error');
    }
    if (typeof window.jspdf === 'undefined') {
        return mostrarToast('No se pudo cargar el generador de PDF. Revise su conexión e intente de nuevo.', 'error');
    }

    document.getElementById('loading').style.display = 'block';
    mostrarToast('Generando PDF, esto puede tardar unos segundos...', 'info');

    try {
        const codigos = itemsFiltrados.map(item => item.codigo ? item.codigo.toString().padStart(7, '0') : '');
        const imagenes = await Promise.all(codigos.map(cod => cargarImagenProducto(cod)));

        const filas = itemsFiltrados.map((item, i) => {
            const comparacion = compararPrecioCanal(item);
            const pctTexto = comparacion.tipo === 'alza' ? `+${comparacion.pct}%` : comparacion.tipo === 'baja' ? `-${comparacion.pct}%` : '--';
            return {
                foto: imagenes[i],
                fila: [
                    '',
                    formatearCodigoConGuion(codigos[i]),
                    item.marca || '--',
                    item.genero || '--',
                    item.tipoProducto || '--',
                    formatearMoneda(precioBaseCanal(item)),
                    formatearMoneda(item.precioAntes),
                    pctTexto,
                    formatearMoneda(precioCanal(item))
                ]
            };
        });

        const { jsPDF } = window.jspdf;
        const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'letter' });

        const tituloLista = categoriaActual === 'SUBE' ? 'Alzas de Precio' : 'Bajas de Precio';
        doc.setFontSize(14);
        doc.text(`${tituloLista} — ${LABEL_TIENDA[tiendaActual] || ''}${infoTiendaStock ? ' · ' + (infoTiendaStock.nombre || tiendaStockActual) : ''}`, 40, 30);

        doc.autoTable({
            head: [['Foto', 'Código', 'Marca', 'Género', 'Tipo Producto', labelPrecioBase(), 'Precio Antes', '% Variación', 'Precio Final']],
            body: filas.map(f => f.fila),
            startY: 45,
            styles: { fontSize: 8, cellPadding: 4, valign: 'middle', minCellHeight: 36 },
            columnStyles: { 0: { cellWidth: 36 } },
            didDrawCell: (data) => {
                if (data.section === 'body' && data.column.index === 0) {
                    const img = filas[data.row.index] && filas[data.row.index].foto;
                    if (img) {
                        const dim = Math.min(data.cell.height, data.cell.width) - 6;
                        try {
                            doc.addImage(img, data.cell.x + 3, data.cell.y + (data.cell.height - dim) / 2, dim, dim);
                        } catch (e) { /* foto corrupta o formato no soportado: se deja el espacio vacío */ }
                    }
                }
            }
        });

        const nombreArchivo = `${categoriaActual === 'SUBE' ? 'alzas' : 'bajas'}-de-precio-${(tiendaActual || 'tienda')}.pdf`;
        const pdfBlob = doc.output('blob');

        const pdfFile = new File([pdfBlob], nombreArchivo, { type: 'application/pdf' });
        if (navigator.canShare && navigator.canShare({ files: [pdfFile] })) {
            await navigator.share({ files: [pdfFile], title: tituloLista });
        } else {
            doc.save(nombreArchivo);
        }
    } catch (e) {
        console.error(e);
        mostrarToast('Ocurrió un error al generar el PDF.', 'error');
    } finally {
        document.getElementById('loading').style.display = 'none';
    }
}
