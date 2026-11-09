// Funciones compartidas por todas las páginas de Vaelo
'use strict';

const ESTADOS = {
  pendiente: 'Pendiente de recoger',
  recogido: 'Recogido',
  en_camino: 'En camino',
  entregado: 'Entregado',
  cancelado: 'Cancelado',
};
const PAGOS = { efectivo: 'Efectivo', transferencia: 'Transferencia' };
const CENTRO_GUATE = [14.6349, -90.5069];

async function api(ruta, opciones = {}) {
  const init = { method: opciones.method || 'GET', headers: {}, credentials: 'same-origin' };
  if (opciones.body !== undefined) {
    init.method = opciones.method || 'POST';
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opciones.body);
  }
  let res;
  try { res = await fetch(ruta, init); }
  catch { throw new Error('No hay conexión con el servidor. Revisa tu internet e inténtalo de nuevo.'); }
  let data = {};
  try { data = await res.json(); } catch { /* sin cuerpo */ }
  if (!res.ok) {
    const err = new Error(data.error || 'Algo salió mal. Inténtalo de nuevo.');
    err.status = res.status;
    throw err;
  }
  return data;
}

const dinero = (n) => 'Q' + Number(n || 0).toLocaleString('es-GT', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Las fechas se guardan en hora UTC; aquí se muestran en la hora local del teléfono o computadora
function fecha(texto, conHora = true) {
  if (!texto) return '';
  const d = new Date(texto.replace(' ', 'T') + 'Z');
  const op = conHora ? { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' } : { day: 'numeric', month: 'short', year: 'numeric' };
  return d.toLocaleString('es-GT', op);
}

function el(etiqueta, atributos = {}, ...hijos) {
  const nodo = document.createElement(etiqueta);
  for (const [k, v] of Object.entries(atributos)) {
    if (v == null || v === false) continue;
    if (k === 'class') nodo.className = v;
    else if (k === 'text') nodo.textContent = v;
    else if (k.startsWith('on')) nodo.addEventListener(k.slice(2), v);
    else nodo.setAttribute(k, v === true ? '' : v);
  }
  for (const h of hijos.flat()) if (h != null && h !== false) nodo.append(h instanceof Node ? h : document.createTextNode(String(h)));
  return nodo;
}

const chipEstado = (estado) => el('span', { class: `estado ${estado}`, text: ESTADOS[estado] || estado });

function mostrarMensaje(nodo, texto, tipo = 'error') {
  nodo.className = `mensaje ${tipo}`;
  nodo.textContent = texto || '';
  if (texto) nodo.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

const telLink = (t) => el('a', { href: 'tel:' + String(t || '').replace(/[^\d+]/g, ''), text: t });

// Barra superior: cambia según quién inició sesión
async function pintarBarra() {
  const barra = document.getElementById('barra');
  if (!barra) return null;
  let usuario = null;
  try { usuario = (await api('/api/yo')).usuario; } catch { /* sin sesión */ }
  const nav = el('nav', { class: 'nav', 'aria-label': 'Principal' });
  if (!usuario || usuario.rol !== 'mensajero') nav.append(el('a', { href: '/rastreo', text: 'Rastrear' }));
  if (usuario) {
    if (usuario.rol === 'admin') nav.append(el('a', { href: '/admin', text: 'Panel' }), el('a', { href: '/mensajero', text: 'Modo mensajero' }));
    if (usuario.rol === 'mensajero') nav.append(el('a', { href: '/mensajero', text: 'Mis entregas' }));
    if (usuario.rol !== 'mensajero') nav.append(el('a', { href: '/mi-cuenta', text: 'Mis envíos' }));
    nav.append(el('button', { class: 'enlace', type: 'button', text: 'Salir', onclick: salir }));
  } else {
    nav.append(el('a', { href: '/entrar', text: 'Entrar' }));
    nav.append(el('a', { href: '/registro', class: 'boton cinta chico', text: 'Crear cuenta' }));
  }
  const marca = el('a', { href: '/', class: 'marca' }, el('img', { src: '/img/logo-blanco.png', alt: 'Vaelo', width: 139, height: 40 }));
  barra.replaceChildren(el('div', { class: 'contenedor' }, marca, nav));
  return usuario;
}

async function salir() {
  try { await api('/api/logout', { body: {} }); } catch { /* igual salimos */ }
  location.href = '/';
}

const codigoBarras = () => el('div', { class: 'codigo-barras', 'aria-hidden': 'true' });

// Guía imprimible para pegar en el paquete
function guiaImprimible(e) {
  return el('div', { class: 'guia-imprimible' },
    el('div', { class: 'franja' }, el('img', { src: '/img/logo-negro.png', alt: 'Vaelo', height: 24 }), el('span', { text: `${e.vehiculo || ''} · ${e.peso} lb` })),
    el('div', { class: 'numero', text: e.guia }),
    codigoBarras(),
    el('div', { class: 'partes' },
      el('div', {}, el('span', { text: 'Envía' }), e.cliente_nombre || '', el('br'), e.origen_telefono || '', el('br'), e.origen_zona || ''),
      el('div', {}, el('span', { text: 'Recibe' }), el('strong', { text: e.destino_nombre }), el('br'), e.destino_telefono, el('br'), e.destino_direccion, el('br'), e.destino_zona || '')),
    el('div', { class: 'partes' },
      Number(e.cobro_destinatario) > 0
        ? el('div', {}, el('span', { text: 'Cobrar al recibir' }), el('strong', { text: dinero(e.cobro_destinatario) }))
        : el('div', {}, el('span', { text: 'Fecha' }), fecha(e.creado, false)),
      el('div', {}, el('span', { text: 'Contenido' }), e.descripcion || 'Sin descripción')));
}

// ---------- Mapas (Leaflet + OpenStreetMap) ----------
const hayMapa = () => typeof window.L !== 'undefined';

function crearMapa(contenedor, centro = CENTRO_GUATE, zoom = 12) {
  if (!hayMapa()) {
    contenedor.replaceChildren(el('div', { class: 'mapa-error', text: 'No se pudo cargar el mapa. Revisa tu conexión y recarga la página.' }));
    return null;
  }
  const mapa = L.map(contenedor, { scrollWheelZoom: false }).setView(centro, zoom);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(mapa);
  return mapa;
}

function iconoPin(letra, clase) {
  return L.divIcon({ className: '', html: `<div class="pin ${clase}"><span>${letra}</span></div>`, iconSize: [34, 42], iconAnchor: [17, 40] });
}
const iconoMensajero = () => L.divIcon({ className: '', html: '<div class="pin-mensajero" title="Mensajero">🛵</div>', iconSize: [40, 40], iconAnchor: [20, 20] });

// Dibuja recogida (A), entrega (B) y la posición del mensajero
function dibujarEnvio(mapa, e) {
  if (!mapa) return;
  const puntos = [];
  if (e.origen_lat) { L.marker([e.origen_lat, e.origen_lng], { icon: iconoPin('A', 'recogida') }).addTo(mapa).bindPopup('Recogida'); puntos.push([e.origen_lat, e.origen_lng]); }
  if (e.destino_lat) { L.marker([e.destino_lat, e.destino_lng], { icon: iconoPin('B', e.estado === 'entregado' ? 'entregado' : 'entrega') }).addTo(mapa).bindPopup(e.estado === 'entregado' ? 'Entregado aquí' : 'Entrega'); puntos.push([e.destino_lat, e.destino_lng]); }
  if (puntos.length === 2) L.polyline(puntos, { color: '#1c3faa', weight: 3, dashArray: '6 8', opacity: .7 }).addTo(mapa);
  if (e.mensajero_lat) {
    L.marker([e.mensajero_lat, e.mensajero_lng], { icon: iconoMensajero(), zIndexOffset: 1000 }).addTo(mapa)
      .bindPopup(`${e.mensajero_nombre || 'Mensajero'}<br>Actualizado ${fecha(e.mensajero_ubic_fecha)}`);
    puntos.push([e.mensajero_lat, e.mensajero_lng]);
  }
  if (puntos.length > 1) mapa.fitBounds(puntos, { padding: [40, 40], maxZoom: 15 });
  else if (puntos.length === 1) mapa.setView(puntos[0], 15);
}

// Buscador de direcciones (OpenStreetMap / Nominatim), solo dentro de Guatemala
async function buscarDireccion(q) {
  const url = 'https://nominatim.openstreetmap.org/search?format=json&limit=5&countrycodes=gt&accept-language=es&q=' + encodeURIComponent(q);
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error('El buscador de direcciones no respondió. Marca el punto tocando el mapa.');
  return (await r.json()).map((x) => ({ nombre: x.display_name, lat: Number(x.lat), lng: Number(x.lon) }));
}

// Mapa para marcar un punto: tocar el mapa, buscar una dirección o usar la ubicación actual
function selectorPunto(contenedor, { letra, clase, alCambiar, conMiUbicacion }) {
  let marcador = null, punto = null;
  const caja = el('div', { class: 'mapa' });
  const buscar = el('input', { type: 'search', placeholder: 'Busca un lugar, ej. Centro Comercial Miraflores', 'aria-label': 'Buscar lugar en el mapa' });
  const resultados = el('div', { class: 'resultados-busqueda' });
  const estado = el('p', { class: 'pista', text: 'Toca el mapa para marcar el punto exacto.' });
  const fijar = (lat, lng, centrar) => {
    punto = { lat, lng };
    if (!mapa) return;
    if (marcador) marcador.setLatLng([lat, lng]);
    else {
      marcador = L.marker([lat, lng], { icon: iconoPin(letra, clase), draggable: true }).addTo(mapa);
      marcador.on('dragend', () => { const p = marcador.getLatLng(); punto = { lat: p.lat, lng: p.lng }; alCambiar && alCambiar(punto); });
    }
    if (centrar) mapa.setView([lat, lng], 16);
    estado.textContent = 'Punto marcado. Puedes arrastrar el pin para ajustarlo.';
    estado.classList.add('ok');
    alCambiar && alCambiar(punto);
  };
  const botonBuscar = el('button', { class: 'boton borde chico', type: 'button', text: 'Buscar', onclick: async () => {
    const q = buscar.value.trim();
    if (q.length < 3) return;
    resultados.replaceChildren(el('p', { class: 'pista', text: 'Buscando…' }));
    try {
      const lista = await buscarDireccion(q);
      if (!lista.length) { resultados.replaceChildren(el('p', { class: 'pista', text: 'No encontramos ese lugar. Prueba con otro nombre o toca el mapa.' })); return; }
      resultados.replaceChildren(...lista.map((x) => el('button', { type: 'button', class: 'resultado', text: x.nombre, onclick: () => { fijar(x.lat, x.lng, true); resultados.replaceChildren(); } })));
    } catch (e) { resultados.replaceChildren(el('p', { class: 'pista', text: e.message })); }
  } });
  buscar.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); botonBuscar.click(); } });
  const controles = el('div', { class: 'mapa-controles' }, buscar, botonBuscar);
  if (conMiUbicacion && navigator.geolocation) {
    controles.append(el('button', { class: 'boton borde chico', type: 'button', text: 'Usar mi ubicación', onclick: () => {
      estado.textContent = 'Obteniendo tu ubicación…';
      navigator.geolocation.getCurrentPosition(
        (p) => fijar(p.coords.latitude, p.coords.longitude, true),
        () => { estado.textContent = 'No pudimos obtener tu ubicación. Busca el lugar o toca el mapa.'; },
        { enableHighAccuracy: true, timeout: 10000 });
    } }));
  }
  contenedor.replaceChildren(controles, resultados, caja, estado);
  const mapa = crearMapa(caja);
  if (mapa) mapa.on('click', (ev) => fijar(ev.latlng.lat, ev.latlng.lng, false));
  return {
    obtener: () => punto,
    limpiar: () => { punto = null; if (marcador) { marcador.remove(); marcador = null; } estado.textContent = 'Toca el mapa para marcar el punto exacto.'; estado.classList.remove('ok'); },
    refrescar: () => mapa && mapa.invalidateSize(),
  };
}

// ---------- App instalable ----------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}
