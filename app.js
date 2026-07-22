// 🚨 REEMPLAZA ESTA URL POR TU URL DE GOOGLE APPS SCRIPT
const urlAPI = "https://script.google.com/macros/s/AKfycby6lSF6gjJWTF8UVqFW16vARSORJH-kVPWo4z8VbQnPM7pDAir3PxvtP62-Oylfbg8U/exec";

const FETCH_TIMEOUT_MS = 15000;

let html5QrcodeScanner = null;
let currentViewMode = 'list';
let audioCtx = null;
let waMarca = "", waDesc = "", waPrecioAntes = "", waPrecioActual = "", waCodigo = "";

let itemsGlobales = [];
let categoriaActual = '';

let itemsFiltrados = [];
let paginaActual = 1;
const itemsPorPagina = 50;

if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(err => console.log('PWA no registrada', err));
}

document.addEventListener("DOMContentLoaded", cargarRecientes);

const formatearMoneda = (valor) => {
    if (valor === undefined || valor === null || valor === '') return '--';
    const strValor = valor.toString().trim();
    if (strValor === '' || strValor === '--') return '--';
    const numero = parseInt(strValor.replace(/\D/g, ""), 10);
    if (isNaN(numero)) return strValor;
    return new Intl.NumberFormat('es-CL', { style: 'currency', currency: 'CLP', maximumFractionDigits: 0 }).format(numero);
};

// Normaliza valores de descuento que pueden venir como "15", "15%", "0,15" o "0.15"
function parsearDescuento(valorDescuento) {
    if (!valorDescuento) return 0;
    let str = valorDescuento.toString().trim().replace('%', '').replace(',', '.');
    let num = parseFloat(str);
    if (isNaN(num)) return 0;
    if (num > 0 && num <= 1) num = num * 100;
    return Math.round(num);
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

function compartirWhatsApp() {
    let text = `🔥 ¡Mira esta oportunidad!\n\n👟 *${waMarca}* (Cód: ${waCodigo})\n`;
    if(waDesc && waDesc !== '0') text += `📉 Descuento: -${waDesc}%\n`;
    if(waPrecioAntes && waPrecioAntes !== '--') text += `❌ Antes: ${waPrecioAntes}\n`;
    text += `✅ *Ahora: ${waPrecioActual}*\n\n¡Te esperamos en la tienda!`;
    window.open(`https://api.whatsapp.com/send?text=${encodeURIComponent(text)}`, '_blank');
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

            document.getElementById('tituloProducto').innerText = data.codigo || '--';

            document.getElementById('outMarca').innerText = data.marca || '--';
            document.getElementById('outGenero').innerText = data.genero || '--';
            document.getElementById('outTipoProd').innerText = data.tipoProducto || '--';
            document.getElementById('outProyecto').innerText = (data.proyecto && data.proyecto.toString().trim() !== "") ? data.proyecto : '--';

            waMarca = data.marca || 'Producto';
            waCodigo = data.codigo || codigo;
            waPrecioActual = formatearMoneda(data.nuevoPrecio);

            const numDesc = parsearDescuento(data.descuento);
            waDesc = numDesc;

            const pContainer = document.getElementById('priceContainerDynamic');
            pContainer.innerHTML = '';
            const estatus = data.estatus || '';

            if (estatus.includes('SUBE') || estatus.includes('AUMENTA')) {
                waPrecioAntes = formatearMoneda(data.precioAntes);
                pContainer.innerHTML = `
                    <div class="price-container">
                        <div class="price-alza-box">
                            <div class="price-alza-item">
                                <span class="price-label">Precio Inicial</span>
                                <span style="color: var(--text-muted); text-decoration: line-through;">${formatearMoneda(data.precioInicial)}</span>
                            </div>
                            <div class="price-alza-item">
                                <span class="price-label">Precio Antes</span>
                                <span style="font-weight: 600; color: var(--text-main);">${waPrecioAntes}</span>
                            </div>
                        </div>
                        <div class="price-label" style="color: var(--accent-red); font-weight: bold;">⚠️ Novedad: Alza de Precio</div>
                        <div class="price-actual alert-red">${waPrecioActual}</div>
                    </div>
                `;
            } else if (estatus.includes('BAJA') || estatus.includes('DISMINUYE') || numDesc > 0) {
                waPrecioAntes = formatearMoneda(data.precioAntes);
                pContainer.innerHTML = `
                    <div class="price-container">
                        <div style="text-align: center;"><div class="discount-badge">BAJA DE PRECIO -${numDesc}%</div></div>
                        <div class="price-alza-box">
                            <div class="price-alza-item">
                                <span class="price-label">Precio Inicial</span>
                                <span style="color: var(--text-muted); text-decoration: line-through;">${formatearMoneda(data.precioInicial)}</span>
                            </div>
                            <div class="price-alza-item">
                                <span class="price-label">Precio Antes</span>
                                <span style="color: var(--text-muted); text-decoration: line-through;">${waPrecioAntes}</span>
                            </div>
                        </div>
                        <div class="price-label" style="margin-top: 10px;">Precio Actual</div>
                        <div class="price-actual">${waPrecioActual}</div>
                    </div>
                `;
            } else {
                waPrecioAntes = "";
                pContainer.innerHTML = `
                    <div class="price-container">
                        <div class="price-alza-box">
                            <div class="price-alza-item">
                                <span class="price-label">Precio Inicial</span>
                                <span style="color: var(--text-muted);">${formatearMoneda(data.precioInicial)}</span>
                            </div>
                            <div class="price-alza-item">
                                <span class="price-label">Precio Antes</span>
                                <span style="color: var(--text-muted);">${formatearMoneda(data.precioAntes)}</span>
                            </div>
                        </div>
                        <div class="price-label">Precio Actual</div>
                        <div class="price-actual" style="color: var(--primary);">${waPrecioActual}</div>
                        <div style="font-size: 12px; color: var(--text-muted); margin-top: 5px;">Sin variaciones recientes</div>
                    </div>
                `;
            }

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
    categoriaActual = categoria;

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

function aplicarFiltros() {
    const vMarca = document.getElementById('filterMarca').value;
    const vGenero = document.getElementById('filterGenero').value;
    const vTipo = document.getElementById('filterTipo').value;

    const filtrados = itemsGlobales.filter(item => {
        const pasaMarca = vMarca === "ALL" || item.marca === vMarca;
        const pasaGenero = vGenero === "ALL" || item.genero === vGenero;
        const pasaTipo = vTipo === "ALL" || item.tipoProducto === vTipo;
        return pasaMarca && pasaGenero && pasaTipo;
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

    items.forEach(item => {
        const codigo = item.codigo ? item.codigo.toString().padStart(7, '0') : '';
        const urlFoto = `./fotos/${codigo}.jpg`;
        const urlFotoUpper = `./fotos/${codigo}.JPG`;

        const numDesc = parsearDescuento(item.descuento);

        let badgeHtml = '';
        if (categoriaActual === 'BAJA' && numDesc > 0) badgeHtml = `<div class="item-discount">-${numDesc}%</div>`;
        if (categoriaActual === 'SUBE') badgeHtml = `<div style="font-size: 11px; color: var(--accent-red); font-weight: 600;">⚠️ Alza</div>`;

        const card = document.createElement('div');
        card.className = 'item-card';
        card.onclick = () => procesarCodigo(codigo);

        card.innerHTML = `
            <img src="${urlFoto}" onerror="this.onerror=null; this.src='${urlFotoUpper}';">
            <div class="item-details">
                <div class="item-header-row">
                    <div class="item-code">${codigo}</div>
                    ${badgeHtml}
                </div>
                <div class="item-meta">${item.marca || '--'} | ${item.genero || '--'}</div>
                <div class="item-prices">
                    <div class="item-price-old">
                        <span>Precio Inicial</span>
                        ${formatearMoneda(item.precioInicial)}
                    </div>
                    <div class="item-price-old">
                        <span>Precio Antes</span>
                        ${formatearMoneda(item.precioAntes)}
                    </div>
                    <div class="item-price-new">
                        ${formatearMoneda(item.nuevoPrecio)}
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
