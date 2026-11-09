// Funciones compartidas por todas las páginas de Vaelo
'use strict';

const LOGO_SVG = '<svg viewBox="0 0 32 32" aria-hidden="true"><rect x="1" y="1" width="30" height="30" rx="7" fill="#ffcf2e"/><path d="M8 9.5l8 13 8-13" fill="none" stroke="#15171c" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

const ESTADOS = {
  pendiente: 'Pendiente de recoger',
  recogido: 'Recogido',
  en_camino: 'En camino',
  entregado: 'Entregado',
  cancelado: 'Cancelado',
};
const TAMANOS = { pequeno: 'Pequeño', mediano: 'Mediano', grande: 'Grande' };
const PAGOS = { efectivo: 'Efectivo', transferencia: 'Transferencia' };

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

const dinero = (n) => '$' + Number(n || 0).toFixed(2);

// Las fechas se guardan en hora UTC; aquí se muestran en la hora local del navegador
function fecha(texto, conHora = true) {
  if (!texto) return '';
  const d = new Date(texto.replace(' ', 'T') + 'Z');
  const op = conHora
    ? { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }
    : { day: 'numeric', month: 'short', year: 'numeric' };
  return d.toLocaleString('es-SV', op);
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

function chipEstado(estado) {
  return el('span', { class: `estado ${estado}`, text: ESTADOS[estado] || estado });
}

function mostrarMensaje(nodo, texto, tipo = 'error') {
  nodo.className = `mensaje ${tipo}`;
  nodo.textContent = texto || '';
  if (texto) nodo.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

// Barra superior: cambia según si hay sesión iniciada
async function pintarBarra() {
  const barra = document.getElementById('barra');
  if (!barra) return null;
  let usuario = null;
  try { usuario = (await api('/api/yo')).usuario; } catch { /* sin sesión */ }
  const nav = el('nav', { class: 'nav', 'aria-label': 'Principal' },
    el('a', { href: '/rastreo', text: 'Rastrear' }));
  if (usuario) {
    if (usuario.rol === 'admin') nav.append(el('a', { href: '/admin', text: 'Panel' }));
    nav.append(el('a', { href: '/mi-cuenta', text: 'Mis envíos' }));
    nav.append(el('button', { class: 'enlace', type: 'button', text: 'Salir', onclick: salir }));
  } else {
    nav.append(el('a', { href: '/entrar', text: 'Entrar' }));
    nav.append(el('a', { href: '/registro', class: 'boton cinta chico', text: 'Crear cuenta' }));
  }
  const marca = el('a', { href: '/', class: 'marca', 'aria-label': 'Vaelo, inicio' });
  marca.innerHTML = LOGO_SVG + '<span>vaelo</span>';
  barra.replaceChildren(el('div', { class: 'contenedor' }, marca, nav));
  return usuario;
}

async function salir() {
  try { await api('/api/logout', { body: {} }); } catch { /* igual salimos */ }
  location.href = '/';
}

function codigoBarras() { return el('div', { class: 'codigo-barras', 'aria-hidden': 'true' }); }

// Guía imprimible para pegar en el paquete
function guiaImprimible(e) {
  return el('div', { class: 'guia-imprimible' },
    el('div', { class: 'franja' }, el('span', { text: 'vaelo' }), el('span', { text: TAMANOS[e.tamano] || '' })),
    el('div', { class: 'numero', text: e.guia }),
    codigoBarras(),
    el('div', { class: 'partes' },
      el('div', {}, el('span', { text: 'Envía' }), e.cliente_nombre || '', el('br'), e.origen_telefono || '', el('br'), `${e.origen_zona || ''}`),
      el('div', {}, el('span', { text: 'Recibe' }), el('strong', { text: e.destino_nombre }), el('br'), e.destino_telefono, el('br'), e.destino_direccion, el('br'), e.destino_zona || '')),
    Number(e.cobro_destinatario) > 0
      ? el('div', { class: 'partes' }, el('div', {}, el('span', { text: 'Cobrar al recibir' }), el('strong', { text: dinero(e.cobro_destinatario) })), el('div', {}, el('span', { text: 'Contenido' }), e.descripcion || 'Sin descripción'))
      : el('div', { class: 'partes' }, el('div', {}, el('span', { text: 'Contenido' }), e.descripcion || 'Sin descripción'), el('div', {}, el('span', { text: 'Fecha' }), fecha(e.creado, false))));
}
