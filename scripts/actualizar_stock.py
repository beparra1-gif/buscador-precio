"""
Actualiza el stock por tienda que usa el Buscador Comercial.

Lee el archivo Obsolescencia_Unido_<año>.txt (más reciente de la carpeta),
se queda SOLO con la última semana (semana_key máxima, ej. 202642), suma el
stock por tienda_key + articulo (solo ubicación "EN TIENDA") y lo sube a la
hoja "STOCK TIENDAS" del Google Sheet a través del Apps Script (doPost).

Uso:
    python actualizar_stock.py            # procesa y sube
    python actualizar_stock.py --dry-run  # procesa y muestra resumen, no sube

Configuración en stock_config.json (al lado de este script, NO se versiona):
    {
      "url_api": "https://script.google.com/macros/s/.../exec",
      "token": "el mismo valor que STOCK_TOKEN en las propiedades del Apps Script",
      "carpeta_stock": "C:/Users/.../Obsolescencia-stock/Obs",
      "tiendas_xlsx": "C:/Users/.../BASES/BASE.xlsx",  (maestro: EDP, GLOSA TIENDA, cadena townhall)
      "tiendas_hoja": "DM+BASE DATOS TIENDA"

Requiere: pip install openpyxl
    }
"""
import glob
import json
import os
import sys
import urllib.request
from datetime import datetime

DIR_SCRIPT = os.path.dirname(os.path.abspath(__file__))
RUTA_CONFIG = os.path.join(DIR_SCRIPT, 'stock_config.json')

# Solo cuenta lo que está físicamente en la tienda (no EN TRANSITO, EN BODEGA
# ni devoluciones), que es lo que el vendedor puede ofrecer hoy.
UBICACIONES_VALIDAS = {'EN TIENDA'}

# Una celda de Google Sheets admite máximo 50.000 caracteres; se deja margen.
MAX_CARACTERES_CELDA = 45000


def log(msg):
    print(f"[{datetime.now():%Y-%m-%d %H:%M:%S}] {msg}", flush=True)


def archivo_mas_reciente(carpeta):
    # Ordenar por nombre deja al final el año más alto (…_2026.txt, …_2027.txt)
    archivos = sorted(glob.glob(os.path.join(carpeta, 'Obsolescencia_Unido_*.txt')))
    if not archivos:
        raise FileNotFoundError(f'No hay archivos Obsolescencia_Unido_*.txt en {carpeta}')
    return archivos[-1]


def leer_stock_ultima_semana(ruta):
    """Una sola pasada: va guardando solo la semana máxima vista hasta ahora,
    y descarta lo acumulado si aparece una semana mayor."""
    semana_max = ''
    stock = {}  # tienda_key -> {articulo: cantidad}
    with open(ruta, encoding='latin-1') as fh:
        enc = fh.readline().rstrip('\r\n').split(';')
        idx = {nombre.strip().lower(): i for i, nombre in enumerate(enc)}
        i_sem, i_tienda, i_art = idx['semana_key'], idx['tienda_key'], idx['articulo']
        i_ubic, i_stock = idx['desc_ubicacion'], idx['stock']
        corte = max(i_sem, i_tienda, i_art, i_ubic, i_stock) + 1

        for linea in fh:
            p = linea.split(';', corte)
            if len(p) <= corte - 1:
                continue
            semana = p[i_sem]
            if semana < semana_max:
                continue
            if semana > semana_max:
                semana_max = semana
                stock = {}
            if p[i_ubic].strip().upper() not in UBICACIONES_VALIDAS:
                continue
            try:
                cantidad = float(p[i_stock].replace(',', '.') or 0)
            except ValueError:
                continue
            tienda = p[i_tienda].strip()
            articulo = p[i_art].strip().lstrip('0') or '0'
            arts = stock.setdefault(tienda, {})
            arts[articulo] = arts.get(articulo, 0) + cantidad

    # Solo artículos con stock positivo
    limpio = {}
    for tienda, arts in stock.items():
        con_stock = {a: int(round(c)) for a, c in arts.items() if c > 0}
        if con_stock:
            limpio[tienda] = con_stock
    return semana_max, limpio


def leer_maestro_tiendas(ruta, hoja):
    """Maestro de tiendas (BASE.xlsx, hoja "DM+BASE DATOS TIENDA"):
    EDP = tienda_key del stock, GLOSA TIENDA = nombre que ve el usuario,
    cadena townhall = cadena (BATA, BUBBLE GUMMERS, WEINBRENNER, OUTLET...),
    Eventos = "Evento Outlet" marca las tiendas que se muestran como Tienda Evento.
    Las tiendas de cadena OUTLET (o con OUTLET en el nombre) usan precios
    Outlet; todas las demás, precios Estándar."""
    import openpyxl  # solo hace falta para el maestro: pip install openpyxl
    libro = openpyxl.load_workbook(ruta, read_only=True, data_only=True)
    filas = libro[hoja].iter_rows(values_only=True)
    enc = [str(c or '').strip().lower() for c in next(filas)]
    i_edp, i_nombre, i_cadena = enc.index('edp'), enc.index('glosa tienda'), enc.index('cadena townhall')
    i_evento = enc.index('eventos') if 'eventos' in enc else -1
    maestro = {}
    for f in filas:
        if f[i_edp] is None:
            continue
        edp = str(f[i_edp]).strip().lstrip('0') or '0'
        nombre = str(f[i_nombre] or '').strip()
        cadena = str(f[i_cadena] or '').strip().upper()
        es_outlet = cadena == 'OUTLET' or 'OUTLET' in nombre.upper()
        es_evento = i_evento != -1 and 'EVENTO' in str(f[i_evento] or '').upper()
        maestro[edp] = {'nombre': nombre, 'cadena': cadena, 'tipo': 'outlet' if es_outlet else 'estandar',
                        'evento': 'SI' if es_evento else ''}
    libro.close()
    return maestro


def armar_filas(stock, maestro):
    """Convierte el stock a filas para el Sheet, partiendo en varias filas las
    tiendas cuyo texto 'articulo:cantidad,...' no cabe en una celda. Con
    maestro, solo se suben las tiendas que figuran en él (deja fuera códigos
    de bodegas/centros de distribución que no son tiendas)."""
    filas_stock, filas_meta = [], []
    for tienda in sorted(stock, key=lambda t: int(t) if t.isdigit() else t):
        info = maestro.get(tienda.lstrip('0') or '0')
        if maestro and not info:
            continue
        info = info or {}
        arts = stock[tienda]
        partes, actual = [], ''
        for art in sorted(arts):
            par = f'{art}:{arts[art]}'
            if actual and len(actual) + len(par) + 1 > MAX_CARACTERES_CELDA:
                partes.append(actual)
                actual = ''
            actual = f'{actual},{par}' if actual else par
        if actual:
            partes.append(actual)
        for n, texto in enumerate(partes, start=1):
            filas_stock.append([tienda, n, texto])
        filas_meta.append([tienda, info.get('nombre', ''), info.get('tipo', 'estandar'), info.get('cadena', ''), info.get('evento', ''), len(arts)])
    return filas_stock, filas_meta


def subir(url, token, semana, filas_stock, filas_meta):
    cuerpo = json.dumps({
        'action': 'subirStock',
        'token': token,
        'semana': semana,
        'filasStock': filas_stock,
        'filasMeta': filas_meta,
    }).encode('utf-8')
    req = urllib.request.Request(url, data=cuerpo, headers={'Content-Type': 'application/json'})
    # Apps Script responde con un redirect 302 que urllib sigue como GET (lo esperado)
    with urllib.request.urlopen(req, timeout=300) as res:
        respuesta = json.loads(res.read().decode('utf-8'))
    if not respuesta.get('ok'):
        raise RuntimeError(f'El Apps Script rechazó la carga: {respuesta}')
    return respuesta


def main():
    # La consola de Windows (y el log de la tarea programada) no siempre es UTF-8
    sys.stdout.reconfigure(encoding='utf-8')
    dry_run = '--dry-run' in sys.argv
    with open(RUTA_CONFIG, encoding='utf-8') as fh:
        config = json.load(fh)

    ruta = archivo_mas_reciente(config['carpeta_stock'])
    log(f'Leyendo {ruta}')
    semana, stock = leer_stock_ultima_semana(ruta)
    total = sum(len(a) for a in stock.values())
    log(f'Semana {semana}: {len(stock)} tiendas, {total} pares tienda-artículo con stock')

    maestro = {}
    if config.get('tiendas_xlsx'):
        maestro = leer_maestro_tiendas(config['tiendas_xlsx'], config.get('tiendas_hoja', 'DM+BASE DATOS TIENDA'))
        log(f'Maestro de tiendas: {len(maestro)} EDP')
    filas_stock, filas_meta = armar_filas(stock, maestro)
    if maestro:
        sin_maestro = sorted(t for t in stock if (t.lstrip('0') or '0') not in maestro)
        log(f'{len(filas_meta)} tiendas con stock y en el maestro; {len(sin_maestro)} códigos con stock fuera del maestro (no se suben): {", ".join(sin_maestro[:30])}')

    if dry_run:
        log(f'--dry-run: {len(filas_stock)} filas de stock, {len(filas_meta)} tiendas. No se sube nada.')
        return

    respuesta = subir(config['url_api'], config['token'], semana, filas_stock, filas_meta)
    log(f'Carga OK: {respuesta}')


if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        log(f'ERROR: {e}')
        sys.exit(1)
