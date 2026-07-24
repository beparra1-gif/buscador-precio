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

// Canal de tienda: define qué columna de precio del Sheet se usa en toda la app
const CAMPO_PRECIO_CANAL = { estandar: 'precioTienda', outlet: 'precioOutlet', piloto: 'precioPiloto' };
const LABEL_TIENDA = { estandar: 'Tienda Estándar', outlet: 'Outlet', piloto: 'Piloto 30 Tiendas' };
let tiendaActual = localStorage.getItem('tiendaSeleccionada') || null;

if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(err => console.log('PWA no registrada', err));
}

document.addEventListener("DOMContentLoaded", () => {
    cargarRecientes();
    if (tiendaActual && CAMPO_PRECIO_CANAL[tiendaActual]) {
        actualizarChipTienda();
        cambiarVista('view-1');
    }
});

function seleccionarTienda(tipo) {
    tiendaActual = tipo;
    localStorage.setItem('tiendaSeleccionada', tipo);
    actualizarChipTienda();
    cambiarVista('view-1');
}

function actualizarChipTienda() {
    const label = document.getElementById('tiendaActualLabel');
    if (label) label.textContent = LABEL_TIENDA[tiendaActual] || '--';
}

// Toma un valor de un objeto, y si no existe usa un campo alterno (compatibilidad mientras se actualiza el Apps Script)
function valorConFallback(obj, campoPrimario, campoAlterno) {
    const v = obj[campoPrimario];
    return (v !== undefined && v !== null && v !== '') ? v : obj[campoAlterno];
}

// % de descuento del canal seleccionado respecto al Full Price Retail (precio base)
function calcularDescuentoCanal(precioBase, precioCanal) {
    const base = parseInt((precioBase || '').toString().replace(/\D/g, ''), 10);
    const canal = parseInt((precioCanal || '').toString().replace(/\D/g, ''), 10);
    if (!base || isNaN(base) || isNaN(canal)) return 0;
    const pct = Math.round((base - canal) / base * 100);
    return pct > 0 ? pct : 0;
}

// Compara el precio del canal elegido contra el Precio Inicial (Full Price Retail).
// El estado de alza/baja se calcula del precio real de CADA canal, no del texto
// genérico de OBSERVACION (que es un solo valor por producto, no por canal) —
// así un canal puede marcar alza aunque el estatus general diga "se mantiene".
function compararPrecioCanal(precioBase, precioCanal) {
    const base = parseInt((precioBase || '').toString().replace(/\D/g, ''), 10);
    const canal = parseInt((precioCanal || '').toString().replace(/\D/g, ''), 10);
    if (!base || isNaN(base) || isNaN(canal)) return { tipo: 'igual', pct: 0 };
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

function renderObsolescenciaBadge(nivel) {
    if (!nivel) return '';
    return `<span class="item-badge-obsolescencia nivel-${nivel}"><span class="obs-dot"></span>Obs. ${nivel}%</span>`;
}

// Muestra el código de 7 dígitos con guión tras el 3ro (ej. 8811970 -> 881-1970,
// 23456 -> 0023456 -> 002-3456), solo para el título del detalle del producto.
function formatearCodigoConGuion(codigo) {
    const c = (codigo || '').toString().trim().padStart(7, '0');
    return c.slice(0, 3) + '-' + c.slice(3);
}

const formatearMoneda = (valor) => {
    if (valor === undefined || valor === null || valor === '') return '--';
    const strValor = valor.toString().trim();
    if (strValor === '' || strValor === '--') return '--';
    const numero = parseInt(strValor.replace(/\D/g, ""), 10);
    if (isNaN(numero)) return strValor;
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

async function procesarCodigo(codDirecto = null) {
    let codigo = codDirecto || document.getElementById('codigoInput').value.trim();
    if(!codigo) return mostrarToast("Ingrese o escanee un código válido", 'error');

    if (codigo.length === 13 && !isNaN(codigo)) codigo = codigo.substring(1, 8);
    codigo = codigo.padStart(7, '0');
    if(!codDirecto) document.getElementById('codigoInput').value = codigo;

    document.getElementById('loading').style.display = "block";

    try {
        const data = await fetchConTimeout(`${urlAPI}?action=buscarCodigo&codigo=${codigo}`);
        document.getElementById('loading').style.display = "none";

        if(data.encontrado) {
            guardarReciente(codigo);

            document.getElementById('tituloProducto').innerText = formatearCodigoConGuion(data.codigo || codigo);

            document.getElementById('outMarca').innerText = data.marca || '--';
            document.getElementById('outGenero').innerText = data.genero || '--';
            document.getElementById('outTipoProd').innerText = data.tipoProducto || '--';
            document.getElementById('outProyecto').innerText = (data.proyecto && data.proyecto.toString().trim() !== "") ? data.proyecto : '--';

            const campoPrecio = CAMPO_PRECIO_CANAL[tiendaActual] || 'precioTienda';
            const precioBase = valorConFallback(data, 'fullPriceRetail', 'precioInicial');
            const precioCanal = valorConFallback(data, campoPrecio, 'nuevoPrecio');
            const precioActualTexto = formatearMoneda(precioCanal);

            // El alza/baja se calcula del precio real del canal elegido vs el Precio
            // Inicial, no del texto de OBSERVACION (que es un solo valor por producto,
            // no varía según el canal que el usuario está mirando).
            const comparacion = compararPrecioCanal(precioBase, precioCanal);
            const numDesc = comparacion.tipo === 'baja' ? comparacion.pct : 0;

            const pContainer = document.getElementById('priceContainerDynamic');
            pContainer.innerHTML = '';

            const labelCanal = `<div style="text-align:center; font-size:11px; color:var(--text-muted); text-transform:uppercase; font-weight:600; letter-spacing:0.5px; margin-bottom:6px;">Precio ${LABEL_TIENDA[tiendaActual] || ''}</div>`;

            if (comparacion.tipo === 'alza') {
                const precioAntesTexto = formatearMoneda(data.precioAntes);
                pContainer.innerHTML = `
                    ${labelCanal}
                    <div class="price-container">
                        <div class="price-alza-box">
                            <div class="price-alza-item">
                                <span class="price-label">Precio Inicial</span>
                                <span style="color: var(--text-muted); text-decoration: line-through;">${formatearMoneda(precioBase)}</span>
                            </div>
                            <div class="price-alza-item">
                                <span class="price-label">Precio Antes</span>
                                <span style="font-weight: 600; color: var(--text-main);">${precioAntesTexto}</span>
                            </div>
                        </div>
                        <div class="price-label" style="color: var(--accent-red); font-weight: bold;">⚠️ Novedad: Alza de Precio +${comparacion.pct}%</div>
                        <div class="price-actual alert-red">${precioActualTexto}</div>
                    </div>
                `;
            } else if (comparacion.tipo === 'baja') {
                const precioAntesTexto = formatearMoneda(data.precioAntes);
                pContainer.innerHTML = `
                    ${labelCanal}
                    <div class="price-container">
                        <div style="text-align: center;"><div class="discount-badge">BAJA DE PRECIO -${numDesc}%</div></div>
                        <div class="price-alza-box">
                            <div class="price-alza-item">
                                <span class="price-label">Precio Inicial</span>
                                <span style="color: var(--text-muted); text-decoration: line-through;">${formatearMoneda(precioBase)}</span>
                            </div>
                            <div class="price-alza-item">
                                <span class="price-label">Precio Antes</span>
                                <span style="color: var(--text-muted); text-decoration: line-through;">${precioAntesTexto}</span>
                            </div>
                        </div>
                        <div class="price-label" style="margin-top: 10px;">Precio Actual</div>
                        <div class="price-actual">${precioActualTexto}</div>
                    </div>
                `;
            } else {
                pContainer.innerHTML = `
                    ${labelCanal}
                    <div class="price-container">
                        <div class="price-alza-box">
                            <div class="price-alza-item">
                                <span class="price-label">Precio Inicial</span>
                                <span style="color: var(--text-muted);">${formatearMoneda(precioBase)}</span>
                            </div>
                            <div class="price-alza-item">
                                <span class="price-label">Precio Antes</span>
                                <span style="color: var(--text-muted);">${formatearMoneda(data.precioAntes)}</span>
                            </div>
                        </div>
                        <div class="price-label">Precio Actual</div>
                        <div class="price-actual" style="color: var(--primary);">${precioActualTexto}</div>
                        <div style="font-size: 12px; color: var(--text-muted); margin-top: 5px;">Sin variaciones recientes</div>
                    </div>
                `;
            }

            const fechaTxt = formatearFecha(data.fechaActualizacion);
            if (fechaTxt) {
                pContainer.innerHTML += `<div style="font-size: 11px; color: var(--text-light); text-align: center; margin-top: 8px;">Precio actualizado el ${fechaTxt}</div>`;
            }

            const nivelObs = obtenerNivelObsolescencia(data.obsolescencia);
            const obsContainer = document.getElementById('obsolescenciaContainer');
            obsContainer.innerHTML = renderObsolescenciaAlert(nivelObs);
            const infoBoxEl = document.getElementById('infoBoxProducto');
            infoBoxEl.classList.remove('obsolescencia-50', 'obsolescencia-100');
            if (nivelObs) infoBoxEl.classList.add('obsolescencia-' + nivelObs);

            const imgContainer = document.getElementById('imgContenedor');
            imgContainer.innerHTML = '';
            const urlFotoLower = `./fotos/${codigo}.jpg`;
            const urlFotoUpper = `./fotos/${codigo}.JPG`;
            const urlBusquedaBata = `https://www.bata.com/cl/search?q=${codigo}`;

            const imgElement = document.createElement('img');
            imgElement.style.width = '100%';
            imgElement.style.height = '100%';
            imgElement.style.objectFit = 'contain';

            let attempt = 0;
            imgElement.onerror = function() {
                attempt++;
                if (attempt === 1) imgElement.src = urlFotoUpper;
                else {
                    imgContainer.style.background = '#F9FAFB';
                    imgContainer.style.border = '1px dashed #D1D5DB';
                    imgContainer.innerHTML = `<a href="${urlBusquedaBata}" target="_blank" style="color:var(--text-muted); text-decoration:none; display:flex; flex-direction:column; align-items:center; justify-content:center; width:100%; height:100%; padding: 10px;"><span style="font-size:24px;">📸</span><span style="font-size:12px; font-weight:600; margin-top:5px;">Foto no encontrada</span><span style="color:var(--primary); font-size:11px; text-decoration:underline; margin-top:3px; text-align:center;">Ver en web oficial</span></a>`;
                }
            };
            imgElement.src = urlFotoLower;
            imgContainer.appendChild(imgElement);

            cambiarVista('view-2');
        } else {
            mostrarToast("El código " + codigo + " no se encuentra.", 'error');
        }
    } catch (error) {
        document.getElementById('loading').style.display = "none";
        if (error.name === 'AbortError') {
            mostrarToast("La consulta demoró demasiado. Intente nuevamente.", 'error');
        } else {
            mostrarToast("Error de conexión.", 'error');
        }
    }
}

async function cargarLista(categoria, tituloHumanizado) {
    document.getElementById('loading').style.display = "block";
    document.getElementById('tituloLista').innerText = tituloHumanizado;
    document.getElementById('listaContenedor').innerHTML = '';
    document.getElementById('filterPrecio').value = 'ALL';
    document.getElementById('filterDescuento').value = 'ALL';
    categoriaActual = categoria;
    // Exportar a PDF solo tiene sentido para Alzas/Bajas (no para Sin Cambios ni Obsolescencia)
    document.getElementById('btnExportarPDF').style.display = (categoria === 'SUBE' || categoria === 'BAJA') ? 'flex' : 'none';

    try {
        const data = await fetchConTimeout(`${urlAPI}?action=listarCategoria&categoria=${categoria}`);
        document.getElementById('loading').style.display = "none";

        if (data.encontrado && data.items && data.items.length > 0) {
            itemsGlobales = data.items;
            itemsFiltrados = [...itemsGlobales];
            paginaActual = 1;

            poblarFiltros(itemsGlobales);
            renderizarPagina();

            cambiarVista('view-3');
        } else {
            mostrarToast("No se encontraron artículos.", 'error');
        }
    } catch(e) {
        document.getElementById('loading').style.display = "none";
        if (e.name === 'AbortError') {
            mostrarToast("La consulta demoró demasiado. Intente nuevamente.", 'error');
        } else {
            mostrarToast("Error al cargar la lista.", 'error');
        }
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
    const n = parseInt((valor || '').toString().replace(/\D/g, ''), 10);
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

    const campoPrecio = CAMPO_PRECIO_CANAL[tiendaActual] || 'precioTienda';

    const filtrados = itemsGlobales.filter(item => {
        const pasaMarca = vMarca === "ALL" || item.marca === vMarca;
        const pasaGenero = vGenero === "ALL" || item.genero === vGenero;
        const pasaTipo = vTipo === "ALL" || item.tipoProducto === vTipo;

        let pasaPrecio = true;
        if (vPrecio !== 'ALL') {
            const precioCanal = valorConFallback(item, campoPrecio, 'nuevoPrecio');
            pasaPrecio = obtenerRangoPrecio(precioCanal) === vPrecio;
        }

        let pasaDescuento = true;
        if (vDescuento !== 'ALL') {
            const precioBase = valorConFallback(item, 'fullPriceRetail', 'precioInicial');
            const precioCanal = valorConFallback(item, campoPrecio, 'nuevoPrecio');
            const comparacion = compararPrecioCanal(precioBase, precioCanal);
            const pct = comparacion.tipo === 'baja' ? comparacion.pct : 0;
            pasaDescuento = obtenerRangoDescuento(pct) === vDescuento;
        }

        return pasaMarca && pasaGenero && pasaTipo && pasaPrecio && pasaDescuento;
    });

    itemsFiltrados = filtrados;
    paginaActual = 1;
    renderizarPagina();
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

    const campoPrecio = CAMPO_PRECIO_CANAL[tiendaActual] || 'precioTienda';

    items.forEach(item => {
        const codigo = item.codigo ? item.codigo.toString().padStart(7, '0') : '';
        const urlFoto = `./fotos/${codigo}.jpg`;
        const urlFotoUpper = `./fotos/${codigo}.JPG`;

        const precioBase = valorConFallback(item, 'fullPriceRetail', 'precioInicial');
        const precioCanal = valorConFallback(item, campoPrecio, 'nuevoPrecio');
        const numDesc = calcularDescuentoCanal(precioBase, precioCanal);

        let badgeHtml = '';
        if ((categoriaActual === 'BAJA' || categoriaActual === 'OBSOLESCENCIA') && numDesc > 0) badgeHtml = `<div class="item-discount">-${numDesc}%</div>`;
        if (categoriaActual === 'SUBE') badgeHtml = `<div style="font-size: 11px; color: var(--accent-red); font-weight: 600;">⚠️ Alza</div>`;

        const nivelObs = obtenerNivelObsolescencia(item.obsolescencia);
        const claseObs = nivelObs ? ` obsolescencia-${nivelObs}` : '';
        const badgeObs = renderObsolescenciaBadge(nivelObs);

        const card = document.createElement('div');
        card.className = 'item-card' + claseObs;
        card.onclick = () => procesarCodigo(codigo);

        card.innerHTML = `
            <img src="${urlFoto}" onerror="this.onerror=null; this.src='${urlFotoUpper}';">
            <div class="item-details">
                <div class="item-header-row">
                    <div class="item-code">${codigo}${badgeObs}</div>
                    ${badgeHtml}
                </div>
                <div class="item-meta">${item.marca || '--'} | ${item.genero || '--'}</div>
                <div class="item-prices">
                    <div class="item-price-old">
                        <span>Precio Inicial</span>
                        ${formatearMoneda(precioBase)}
                    </div>
                    <div class="item-price-old">
                        <span>Precio Antes</span>
                        ${formatearMoneda(item.precioAntes)}
                    </div>
                    <div class="item-price-new">
                        ${formatearMoneda(precioCanal)}
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
        const campoPrecio = CAMPO_PRECIO_CANAL[tiendaActual] || 'precioTienda';
        const codigos = itemsFiltrados.map(item => item.codigo ? item.codigo.toString().padStart(7, '0') : '');
        const imagenes = await Promise.all(codigos.map(cod => cargarImagenProducto(cod)));

        const filas = itemsFiltrados.map((item, i) => {
            const precioBase = valorConFallback(item, 'fullPriceRetail', 'precioInicial');
            const precioCanal = valorConFallback(item, campoPrecio, 'nuevoPrecio');
            const comparacion = compararPrecioCanal(precioBase, precioCanal);
            const pctTexto = comparacion.tipo === 'alza' ? `+${comparacion.pct}%` : comparacion.tipo === 'baja' ? `-${comparacion.pct}%` : '--';
            return {
                foto: imagenes[i],
                fila: [
                    '',
                    formatearCodigoConGuion(codigos[i]),
                    item.marca || '--',
                    item.genero || '--',
                    item.tipoProducto || '--',
                    formatearMoneda(precioBase),
                    formatearMoneda(item.precioAntes),
                    pctTexto,
                    formatearMoneda(precioCanal)
                ]
            };
        });

        const { jsPDF } = window.jspdf;
        const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'letter' });

        const tituloLista = categoriaActual === 'SUBE' ? 'Alzas de Precio' : 'Bajas de Precio';
        doc.setFontSize(14);
        doc.text(`${tituloLista} — ${LABEL_TIENDA[tiendaActual] || ''}`, 40, 30);

        doc.autoTable({
            head: [['Foto', 'Código', 'Marca', 'Género', 'Tipo Producto', 'Precio Inicial', 'Precio Antes', '% Variación', 'Precio Final']],
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
