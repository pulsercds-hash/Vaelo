// Servidor de Vaelo Mensajería (Guatemala)
// Funciona solo con Node.js 22 (sin paquetes extra). Inicia con: node server.js
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { db } = require('./db');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');
const SESION_DIAS = 30;
// Servicio de rutas para medir kilómetros reales por calle. Si falla, se usa la distancia en línea recta × 1.4
const OSRM_URL = process.env.VAELO_OSRM === 'no' ? '' : (process.env.VAELO_OSRM || 'https://router.project-osrm.org');

const ESTADOS = ['pendiente', 'recogido', 'en_camino', 'entregado', 'cancelado'];
const ESTADOS_MENSAJERO = ['recogido', 'en_camino', 'entregado'];
const METODOS_PAGO = ['efectivo', 'transferencia'];
const OTRA_ZONA = 'Otra zona o municipio';

// ---------- Utilidades ----------
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}
function verificarPassword(password, guardado) {
  const [alg, saltHex, hashHex] = String(guardado).split('$');
  if (alg !== 'scrypt' || !saltHex || !hashHex) return false;
  const hash = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), 64);
  const esperado = Buffer.from(hashHex, 'hex');
  return esperado.length === hash.length && crypto.timingSafeEqual(hash, esperado);
}

const ALFABETO_GUIA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function nuevaGuia() {
  for (;;) {
    let s = '';
    for (const b of crypto.randomBytes(8)) s += ALFABETO_GUIA[b % ALFABETO_GUIA.length];
    const guia = `VA-${s}`;
    if (!db.prepare('SELECT 1 FROM envios WHERE guia = ?').get(guia)) return guia;
  }
}

const texto = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const numero = (v) => { const n = Number(v); return v === '' || v == null ? NaN : (Number.isFinite(n) ? n : NaN); };
const redondear = (n) => Math.round(n * 100) / 100;

// Coordenadas dentro de Guatemala (con margen)
function coordenada(lat, lng) {
  const la = numero(lat), ln = numero(lng);
  if (!Number.isFinite(la) || !Number.isFinite(ln)) return null;
  if (la < 13.4 || la > 18.1 || ln < -92.6 || ln > -88.0) return null;
  return { lat: la, lng: ln };
}

function getAjustes() {
  const out = {};
  for (const r of db.prepare('SELECT clave, valor FROM ajustes').all()) out[r.clave] = r.valor;
  return out;
}
const zonasFijas = () => db.prepare('SELECT id, nombre FROM zonas_fijas WHERE activa = 1 ORDER BY id').all();

function distanciaRecta(a, b) {
  const R = 6371, rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const cacheRutas = new Map();
async function kilometros(a, b) {
  const clave = [a.lat, a.lng, b.lat, b.lng].map((n) => n.toFixed(5)).join(',');
  if (cacheRutas.has(clave)) return cacheRutas.get(clave);
  let km = null, fuente = 'calle';
  if (OSRM_URL) {
    try {
      const url = `${OSRM_URL}/route/v1/driving/${a.lng},${a.lat};${b.lng},${b.lat}?overview=false`;
      const r = await fetch(url, { signal: AbortSignal.timeout(5000), headers: { 'User-Agent': 'Vaelo-Mensajeria/1.0' } });
      const j = await r.json();
      if (j.code === 'Ok' && j.routes && j.routes[0]) km = j.routes[0].distance / 1000;
    } catch { /* se usa la estimación */ }
  }
  if (km == null) { km = distanciaRecta(a, b) * 1.4; fuente = 'estimado'; }
  const out = { km: Math.max(0.1, Math.round(km * 10) / 10), fuente };
  if (cacheRutas.size > 2000) cacheRutas.clear();
  cacheRutas.set(clave, out);
  return out;
}

// Calcula el precio: tarifa fija si recogida y entrega están en zonas cubiertas; si no, por kilómetro
async function cotizar(body) {
  const vehiculo = db.prepare('SELECT * FROM vehiculos WHERE id = ? AND activo = 1').get(numero(body.vehiculo_id));
  if (!vehiculo) falla(400, 'Elige el vehículo para tu envío.');
  const peso = numero(body.peso);
  if (!(peso > 0)) falla(400, 'Escribe el peso aproximado del paquete en libras.');
  if (peso > vehiculo.peso_max) falla(400, `Ese peso supera lo que lleva una ${vehiculo.nombre.toLowerCase()} (máximo ${vehiculo.peso_max} lb). Elige otro vehículo.`);
  const nombresZonas = zonasFijas().map((z) => z.nombre);
  const oz = texto(body.origen_zona, 60), dz = texto(body.destino_zona, 60);
  for (const z of [oz, dz]) if (z !== OTRA_ZONA && !nombresZonas.includes(z)) falla(400, 'Elige la zona de recogida y la de entrega.');
  const origen = coordenada(body.origen_lat, body.origen_lng);
  const destino = coordenada(body.destino_lat, body.destino_lng);

  if (oz !== OTRA_ZONA && dz !== OTRA_ZONA) {
    let km = null;
    if (origen && destino) km = (await kilometros(origen, destino)).km;
    return { tipo: 'zona', km, precio: redondear(vehiculo.tarifa_zona), vehiculo, peso,
      detalle: `Tarifa fija en zonas cubiertas (${vehiculo.nombre})` };
  }
  if (!origen || !destino) falla(400, 'Para envíos fuera de las zonas cubiertas, marca en el mapa el punto de recogida y el de entrega para calcular los kilómetros.');
  const { km, fuente } = await kilometros(origen, destino);
  const precio = redondear(Math.max(vehiculo.tarifa_zona, vehiculo.tarifa_base + km * vehiculo.precio_km));
  return { tipo: 'km', km, precio, vehiculo, peso, fuente,
    detalle: `Q${vehiculo.tarifa_base.toFixed(2)} + ${km} km × Q${vehiculo.precio_km.toFixed(2)}${fuente === 'estimado' ? ' (distancia aproximada)' : ''}` };
}

// Límite simple de intentos (por IP) para login y registro
const intentos = new Map();
function limitar(ip, clave, max, ventanaMs) {
  const k = `${clave}:${ip}`;
  const ahora = Date.now();
  const lista = (intentos.get(k) || []).filter((t) => ahora - t < ventanaMs);
  lista.push(ahora);
  intentos.set(k, lista);
  return lista.length > max;
}
setInterval(() => {
  const ahora = Date.now();
  for (const [k, lista] of intentos) if (lista.every((t) => ahora - t > 3600_000)) intentos.delete(k);
  db.prepare('DELETE FROM sesiones WHERE expira < ?').run(ahora);
}, 600_000).unref();

// ---------- Respuestas ----------
const CABECERAS_SEGURIDAD = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'geolocation=(self), camera=(), microphone=()',
};
function json(res, status, data, extra = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CABECERAS_SEGURIDAD, ...extra });
  res.end(JSON.stringify(data));
}
class ErrorHttp extends Error { constructor(status, mensaje) { super(mensaje); this.status = status; } }
function falla(status, mensaje) { throw new ErrorHttp(status, mensaje); }

function leerJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 100_000) { reject(new ErrorHttp(413, 'Los datos enviados son demasiado grandes.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new ErrorHttp(400, 'Formato de datos inválido.')); }
    });
    req.on('error', reject);
  });
}
function leerCookies(req) {
  const out = {};
  for (const parte of (req.headers.cookie || '').split(';')) {
    const i = parte.indexOf('=');
    if (i > 0) out[parte.slice(0, i).trim()] = decodeURIComponent(parte.slice(i + 1).trim());
  }
  return out;
}
const esHttps = (req) => req.headers['x-forwarded-proto'] === 'https' || /"scheme":"https"/.test(req.headers['cf-visitor'] || '');
const cookieSesion = (req, token, maxAge) => `vaelo_sesion=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${esHttps(req) ? '; Secure' : ''}`;
const ipDe = (req) => req.headers['cf-connecting-ip'] || req.headers['x-real-ip'] || req.socket.remoteAddress || '';

function usuarioActual(req) {
  const token = leerCookies(req).vaelo_sesion;
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  return db.prepare(`
    SELECT u.id, u.nombre, u.email, u.telefono, u.rol, u.vehiculo_id FROM sesiones s
    JOIN usuarios u ON u.id = s.usuario_id
    WHERE s.token = ? AND s.expira > ? AND u.activo = 1`).get(token, Date.now()) || null;
}
function requiereUsuario(req) { const u = usuarioActual(req); if (!u) falla(401, 'Inicia sesión para continuar.'); return u; }
function requiereRol(req, ...roles) {
  const u = requiereUsuario(req);
  if (!roles.includes(u.rol)) falla(403, 'No tienes permiso para esta sección.');
  return u;
}
function crearSesion(req, usuarioId) {
  const token = crypto.randomBytes(32).toString('hex');
  const maxAge = SESION_DIAS * 86400;
  db.prepare('INSERT INTO sesiones (token, usuario_id, expira) VALUES (?, ?, ?)').run(token, usuarioId, Date.now() + maxAge * 1000);
  return cookieSesion(req, token, maxAge);
}

// ---------- Consultas de envíos ----------
const SQL_ENVIO = `
  SELECT e.*, v.nombre AS vehiculo, u.nombre AS cliente_nombre, u.email AS cliente_email, u.telefono AS cliente_telefono,
         m.nombre AS mensajero_nombre, m.telefono AS mensajero_telefono,
         m.ubic_lat AS mensajero_lat, m.ubic_lng AS mensajero_lng, m.ubic_fecha AS mensajero_ubic_fecha
  FROM envios e
  JOIN vehiculos v ON v.id = e.vehiculo_id
  JOIN usuarios u ON u.id = e.usuario_id
  LEFT JOIN usuarios m ON m.id = e.mensajero_id`;

function envioSalida(e) {
  const out = { ...e };
  // La ubicación del mensajero solo se muestra mientras lleva el paquete y si es reciente (2 horas)
  const reciente = e.mensajero_ubic_fecha && (Date.now() - new Date(e.mensajero_ubic_fecha.replace(' ', 'T') + 'Z').getTime()) < 2 * 3600_000;
  if (!['recogido', 'en_camino', 'pendiente'].includes(e.estado) || !reciente) {
    out.mensajero_lat = null; out.mensajero_lng = null; out.mensajero_ubic_fecha = null;
  }
  return out;
}
const eventosDe = (id) => db.prepare('SELECT estado, nota, lat, lng, creado FROM eventos WHERE envio_id = ? ORDER BY id').all(id);

function cambiarEstado(envioId, estado, nota, lat, lng) {
  const c = coordenada(lat, lng);
  db.prepare("UPDATE envios SET estado = ?, actualizado = datetime('now') WHERE id = ?").run(estado, envioId);
  db.prepare('INSERT INTO eventos (envio_id, estado, nota, lat, lng) VALUES (?, ?, ?, ?, ?)')
    .run(envioId, estado, nota, c ? c.lat : null, c ? c.lng : null);
}

// ---------- Rutas de la API ----------
const rutas = [];
function ruta(metodo, patron, fn) {
  const claves = [];
  const re = new RegExp('^' + patron.replace(/:(\w+)/g, (_, k) => { claves.push(k); return '([^/]+)'; }) + '$');
  rutas.push({ metodo, re, claves, fn });
}

// Público
ruta('GET', '/api/config', () => {
  const aj = getAjustes();
  return {
    vehiculos: db.prepare('SELECT id, nombre, descripcion, peso_max, tarifa_zona, tarifa_base, precio_km FROM vehiculos WHERE activo = 1 ORDER BY orden, id').all(),
    zonas: zonasFijas().map((z) => z.nombre),
    otraZona: OTRA_ZONA,
    whatsapp: aj.whatsapp || '',
    horario: aj.horario || '',
  };
});

ruta('POST', '/api/cotizar', async ({ body }) => {
  const c = await cotizar(body);
  return { tipo: c.tipo, km: c.km, precio: c.precio, detalle: c.detalle };
});

ruta('GET', '/api/rastreo/:guia', ({ params }) => {
  const guia = decodeURIComponent(params.guia).toUpperCase().replace(/\s+/g, '');
  const e = db.prepare(`SELECT e.id, e.guia, e.estado, e.creado, e.origen_zona, e.destino_zona, e.destino_nombre, v.nombre AS vehiculo
    FROM envios e JOIN vehiculos v ON v.id = e.vehiculo_id WHERE e.guia = ?`).get(guia);
  if (!e) falla(404, 'No encontramos un envío con esa guía. Revisa que esté bien escrita, por ejemplo VA-7K3M9QX2.');
  return {
    guia: e.guia, estado: e.estado, creado: e.creado, vehiculo: e.vehiculo,
    origen_zona: e.origen_zona, destino_zona: e.destino_zona,
    destinatario: (e.destino_nombre || '').split(/\s+/)[0],
    eventos: eventosDe(e.id).map(({ estado, nota, creado }) => ({ estado, nota, creado })),
  };
});

// Cuentas
ruta('POST', '/api/registro', ({ req, body }) => {
  if (limitar(ipDe(req), 'registro', 10, 3600_000)) falla(429, 'Demasiados intentos. Espera un momento e inténtalo de nuevo.');
  const nombre = texto(body.nombre, 100);
  const email = texto(body.email, 150).toLowerCase();
  const telefono = texto(body.telefono, 30);
  const password = typeof body.password === 'string' ? body.password : '';
  if (nombre.length < 2) falla(400, 'Escribe tu nombre completo.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) falla(400, 'Escribe un correo válido.');
  if (telefono.replace(/\D/g, '').length < 8) falla(400, 'Escribe un teléfono de 8 dígitos.');
  if (password.length < 8) falla(400, 'La contraseña debe tener al menos 8 caracteres.');
  if (db.prepare('SELECT 1 FROM usuarios WHERE email = ?').get(email)) falla(409, 'Ya existe una cuenta con ese correo. Inicia sesión.');
  const r = db.prepare('INSERT INTO usuarios (nombre, email, telefono, password_hash) VALUES (?, ?, ?, ?)')
    .run(nombre, email, telefono, hashPassword(password));
  return { _status: 201, _headers: { 'Set-Cookie': crearSesion(req, Number(r.lastInsertRowid)) }, ok: true, rol: 'cliente' };
});

ruta('POST', '/api/login', ({ req, body }) => {
  if (limitar(ipDe(req), 'login', 10, 900_000)) falla(429, 'Demasiados intentos. Espera 15 minutos e inténtalo de nuevo.');
  const email = texto(body.email, 150).toLowerCase();
  const password = typeof body.password === 'string' ? body.password : '';
  const u = db.prepare('SELECT * FROM usuarios WHERE email = ?').get(email);
  if (!u || !verificarPassword(password, u.password_hash)) falla(401, 'Correo o contraseña incorrectos.');
  if (!u.activo) falla(403, 'Esta cuenta está desactivada. Comunícate con Vaelo.');
  return { _headers: { 'Set-Cookie': crearSesion(req, u.id) }, ok: true, rol: u.rol };
});

ruta('POST', '/api/logout', ({ req }) => {
  const token = leerCookies(req).vaelo_sesion;
  if (token) db.prepare('DELETE FROM sesiones WHERE token = ?').run(token);
  return { _headers: { 'Set-Cookie': cookieSesion(req, '', 0) }, ok: true };
});

ruta('GET', '/api/yo', ({ req }) => ({ usuario: usuarioActual(req) }));

ruta('PUT', '/api/yo', ({ req, body }) => {
  const u = requiereUsuario(req);
  const nombre = texto(body.nombre, 100), telefono = texto(body.telefono, 30);
  if (nombre.length < 2) falla(400, 'Escribe tu nombre completo.');
  if (telefono.replace(/\D/g, '').length < 8) falla(400, 'Escribe un teléfono de 8 dígitos.');
  db.prepare('UPDATE usuarios SET nombre = ?, telefono = ? WHERE id = ?').run(nombre, telefono, u.id);
  return { ok: true };
});

ruta('POST', '/api/cambiar-password', ({ req, body }) => {
  const u = requiereUsuario(req);
  const fila = db.prepare('SELECT password_hash FROM usuarios WHERE id = ?').get(u.id);
  if (!verificarPassword(String(body.actual || ''), fila.password_hash)) falla(400, 'La contraseña actual no es correcta.');
  const nueva = String(body.nueva || '');
  if (nueva.length < 8) falla(400, 'La nueva contraseña debe tener al menos 8 caracteres.');
  db.prepare('UPDATE usuarios SET password_hash = ? WHERE id = ?').run(hashPassword(nueva), u.id);
  return { ok: true };
});

// Cliente: envíos
ruta('GET', '/api/envios', ({ req }) => {
  const u = requiereUsuario(req);
  return { envios: db.prepare(`${SQL_ENVIO} WHERE e.usuario_id = ? ORDER BY e.id DESC LIMIT 200`).all(u.id).map(envioSalida) };
});

ruta('GET', '/api/envios/:id', ({ req, params }) => {
  const u = requiereUsuario(req);
  const e = db.prepare(`${SQL_ENVIO} WHERE e.id = ? AND e.usuario_id = ?`).get(Number(params.id), u.id);
  if (!e) falla(404, 'No encontramos ese envío.');
  return { envio: envioSalida(e), eventos: eventosDe(e.id) };
});

ruta('POST', '/api/envios', async ({ req, body }) => {
  const u = requiereUsuario(req);
  const d = {
    origen_direccion: texto(body.origen_direccion, 300),
    origen_telefono: texto(body.origen_telefono, 30) || u.telefono,
    destino_nombre: texto(body.destino_nombre, 100),
    destino_telefono: texto(body.destino_telefono, 30),
    destino_direccion: texto(body.destino_direccion, 300),
    descripcion: texto(body.descripcion, 200),
    notas: texto(body.notas, 300),
    metodo_pago: texto(body.metodo_pago, 20) || 'efectivo',
    cobro_destinatario: body.cobro_destinatario === '' || body.cobro_destinatario == null ? 0 : numero(body.cobro_destinatario),
  };
  if (d.origen_direccion.length < 5) falla(400, 'Escribe la dirección donde recogemos el paquete.');
  if (d.origen_telefono.replace(/\D/g, '').length < 8) falla(400, 'Escribe un teléfono de contacto para la recogida.');
  if (d.destino_nombre.length < 2) falla(400, 'Escribe el nombre de quien recibe.');
  if (d.destino_telefono.replace(/\D/g, '').length < 8) falla(400, 'Escribe el teléfono de quien recibe (8 dígitos).');
  if (d.destino_direccion.length < 5) falla(400, 'Escribe la dirección de entrega.');
  if (!METODOS_PAGO.includes(d.metodo_pago)) falla(400, 'Elige cómo vas a pagar el envío.');
  if (!Number.isFinite(d.cobro_destinatario) || d.cobro_destinatario < 0 || d.cobro_destinatario > 50000) falla(400, 'El monto a cobrar a quien recibe no es válido.');
  const c = await cotizar(body);
  const o = coordenada(body.origen_lat, body.origen_lng), de = coordenada(body.destino_lat, body.destino_lng);

  const guia = nuevaGuia();
  db.exec('BEGIN');
  try {
    const r = db.prepare(`INSERT INTO envios
      (guia, usuario_id, vehiculo_id, peso, descripcion, origen_direccion, origen_zona, origen_telefono, origen_lat, origen_lng,
       destino_nombre, destino_telefono, destino_direccion, destino_zona, destino_lat, destino_lng,
       tipo_tarifa, km, precio, metodo_pago, cobro_destinatario, notas)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      guia, u.id, c.vehiculo.id, c.peso, d.descripcion, d.origen_direccion, texto(body.origen_zona, 60), d.origen_telefono,
      o ? o.lat : null, o ? o.lng : null, d.destino_nombre, d.destino_telefono, d.destino_direccion, texto(body.destino_zona, 60),
      de ? de.lat : null, de ? de.lng : null, c.tipo, c.km, c.precio, d.metodo_pago, redondear(d.cobro_destinatario), d.notas);
    db.prepare('INSERT INTO eventos (envio_id, estado, nota) VALUES (?, ?, ?)').run(r.lastInsertRowid, 'pendiente', 'Solicitud recibida');
    db.exec('COMMIT');
    return { _status: 201, id: Number(r.lastInsertRowid), guia, precio: c.precio };
  } catch (err) { db.exec('ROLLBACK'); throw err; }
});

ruta('POST', '/api/envios/:id/cancelar', ({ req, params }) => {
  const u = requiereUsuario(req);
  const e = db.prepare('SELECT * FROM envios WHERE id = ? AND usuario_id = ?').get(Number(params.id), u.id);
  if (!e) falla(404, 'No encontramos ese envío.');
  if (e.estado !== 'pendiente') falla(400, 'Solo puedes cancelar envíos que todavía no hemos recogido.');
  cambiarEstado(e.id, 'cancelado', 'Cancelado por el cliente');
  return { ok: true };
});

// Mensajeros
ruta('GET', '/api/mensajero/envios', ({ req }) => {
  const u = requiereRol(req, 'mensajero', 'admin');
  const filas = db.prepare(`${SQL_ENVIO} WHERE e.mensajero_id = ?
    AND (e.estado IN ('pendiente','recogido','en_camino') OR (e.estado = 'entregado' AND date(e.actualizado) >= date('now','-1 day')))
    ORDER BY CASE e.estado WHEN 'en_camino' THEN 0 WHEN 'recogido' THEN 1 WHEN 'pendiente' THEN 2 ELSE 3 END, e.id`).all(u.id);
  return { envios: filas.map(envioSalida) };
});

ruta('POST', '/api/mensajero/envios/:id/estado', ({ req, params, body }) => {
  const u = requiereRol(req, 'mensajero', 'admin');
  const e = db.prepare('SELECT * FROM envios WHERE id = ? AND mensajero_id = ?').get(Number(params.id), u.id);
  if (!e) falla(404, 'Este envío no está asignado a ti.');
  const estado = texto(body.estado, 20);
  if (!ESTADOS_MENSAJERO.includes(estado)) falla(400, 'Estado no válido.');
  if (['entregado', 'cancelado'].includes(e.estado)) falla(400, 'Este envío ya está cerrado.');
  cambiarEstado(e.id, estado, texto(body.nota, 300), body.lat, body.lng);
  const c = coordenada(body.lat, body.lng);
  if (c) db.prepare("UPDATE usuarios SET ubic_lat = ?, ubic_lng = ?, ubic_fecha = datetime('now') WHERE id = ?").run(c.lat, c.lng, u.id);
  return { ok: true };
});

ruta('POST', '/api/mensajero/ubicacion', ({ req, body }) => {
  const u = requiereRol(req, 'mensajero', 'admin');
  const c = coordenada(body.lat, body.lng);
  if (!c) falla(400, 'Ubicación no válida.');
  db.prepare("UPDATE usuarios SET ubic_lat = ?, ubic_lng = ?, ubic_fecha = datetime('now') WHERE id = ?").run(c.lat, c.lng, u.id);
  return { ok: true };
});

// Administración
ruta('GET', '/api/admin/resumen', ({ req }) => {
  requiereRol(req, 'admin');
  const porEstado = {};
  for (const s of ESTADOS) porEstado[s] = 0;
  for (const r of db.prepare('SELECT estado, COUNT(*) AS n FROM envios GROUP BY estado').all()) porEstado[r.estado] = r.n;
  const hoy = db.prepare("SELECT COUNT(*) AS n FROM envios WHERE date(creado, '-6 hours') = date('now', '-6 hours')").get().n;
  const mes = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(precio), 0) AS total FROM envios
    WHERE estado = 'entregado' AND strftime('%Y-%m', actualizado, '-6 hours') = strftime('%Y-%m', 'now', '-6 hours')`).get();
  const sinAsignar = db.prepare("SELECT COUNT(*) AS n FROM envios WHERE mensajero_id IS NULL AND estado = 'pendiente'").get().n;
  const clientes = db.prepare("SELECT COUNT(*) AS n FROM usuarios WHERE rol = 'cliente'").get().n;
  return { porEstado, hoy, sinAsignar, entregadosMes: mes.n, ingresosMes: redondear(mes.total), clientes };
});

ruta('GET', '/api/admin/envios', ({ req, query }) => {
  requiereRol(req, 'admin');
  const cond = [], args = [];
  const estado = query.get('estado');
  if (estado === 'sin_asignar') cond.push("e.mensajero_id IS NULL AND e.estado = 'pendiente'");
  else if (estado && ESTADOS.includes(estado)) { cond.push('e.estado = ?'); args.push(estado); }
  const q = (query.get('q') || '').trim().slice(0, 100);
  if (q) {
    cond.push('(e.guia LIKE ? OR e.destino_nombre LIKE ? OR u.nombre LIKE ? OR e.destino_telefono LIKE ? OR u.telefono LIKE ?)');
    const like = `%${q}%`;
    args.push(like, like, like, like, like);
  }
  const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
  return { envios: db.prepare(`${SQL_ENVIO} ${where} ORDER BY e.id DESC LIMIT 300`).all(...args).map(envioSalida) };
});

ruta('GET', '/api/admin/envios/:id', ({ req, params }) => {
  requiereRol(req, 'admin');
  const e = db.prepare(`${SQL_ENVIO} WHERE e.id = ?`).get(Number(params.id));
  if (!e) falla(404, 'No encontramos ese envío.');
  return { envio: envioSalida(e), eventos: eventosDe(e.id) };
});

ruta('POST', '/api/admin/envios/:id/estado', ({ req, params, body }) => {
  requiereRol(req, 'admin');
  const estado = texto(body.estado, 20);
  if (!ESTADOS.includes(estado)) falla(400, 'Estado no válido.');
  const e = db.prepare('SELECT id FROM envios WHERE id = ?').get(Number(params.id));
  if (!e) falla(404, 'No encontramos ese envío.');
  cambiarEstado(e.id, estado, texto(body.nota, 300));
  return { ok: true };
});

ruta('POST', '/api/admin/envios/:id/asignar', ({ req, params, body }) => {
  requiereRol(req, 'admin');
  const e = db.prepare('SELECT id, estado FROM envios WHERE id = ?').get(Number(params.id));
  if (!e) falla(404, 'No encontramos ese envío.');
  if (body.mensajero_id === '' || body.mensajero_id == null) {
    db.prepare('UPDATE envios SET mensajero_id = NULL WHERE id = ?').run(e.id);
    return { ok: true };
  }
  const m = db.prepare("SELECT id, nombre FROM usuarios WHERE id = ? AND rol = 'mensajero' AND activo = 1").get(numero(body.mensajero_id));
  if (!m) falla(400, 'Elige un mensajero activo.');
  db.prepare("UPDATE envios SET mensajero_id = ?, actualizado = datetime('now') WHERE id = ?").run(m.id, e.id);
  db.prepare('INSERT INTO eventos (envio_id, estado, nota) VALUES (?, ?, ?)').run(e.id, e.estado, `Asignado a ${m.nombre.split(' ')[0]}`);
  return { ok: true };
});

ruta('GET', '/api/admin/clientes', ({ req }) => {
  requiereRol(req, 'admin');
  return { clientes: db.prepare(`
    SELECT u.id, u.nombre, u.email, u.telefono, u.rol, u.creado,
      (SELECT COUNT(*) FROM envios e WHERE e.usuario_id = u.id) AS envios
    FROM usuarios u WHERE u.rol IN ('cliente','admin') ORDER BY u.id DESC LIMIT 500`).all() };
});

ruta('GET', '/api/admin/mensajeros', ({ req }) => {
  requiereRol(req, 'admin');
  return { mensajeros: db.prepare(`
    SELECT u.id, u.nombre, u.email, u.telefono, u.activo, u.vehiculo_id, v.nombre AS vehiculo, u.ubic_fecha, u.ubic_lat, u.ubic_lng,
      (u.ubic_fecha >= datetime('now','-2 hours')) AS ubic_reciente,
      (SELECT COUNT(*) FROM envios e WHERE e.mensajero_id = u.id AND e.estado IN ('pendiente','recogido','en_camino')) AS activos
    FROM usuarios u LEFT JOIN vehiculos v ON v.id = u.vehiculo_id
    WHERE u.rol = 'mensajero' ORDER BY u.activo DESC, u.nombre`).all() };
});

ruta('POST', '/api/admin/mensajeros', ({ req, body }) => {
  requiereRol(req, 'admin');
  const nombre = texto(body.nombre, 100), email = texto(body.email, 150).toLowerCase(), telefono = texto(body.telefono, 30);
  const password = String(body.password || '');
  if (nombre.length < 2) falla(400, 'Escribe el nombre del mensajero.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) falla(400, 'Escribe un correo válido para el mensajero.');
  if (password.length < 8) falla(400, 'La contraseña debe tener al menos 8 caracteres.');
  if (db.prepare('SELECT 1 FROM usuarios WHERE email = ?').get(email)) falla(409, 'Ya existe una cuenta con ese correo.');
  const veh = numero(body.vehiculo_id);
  db.prepare("INSERT INTO usuarios (nombre, email, telefono, password_hash, rol, vehiculo_id) VALUES (?, ?, ?, ?, 'mensajero', ?)")
    .run(nombre, email, telefono, hashPassword(password), Number.isFinite(veh) ? veh : null);
  return { _status: 201, ok: true };
});

ruta('PUT', '/api/admin/mensajeros/:id', ({ req, params, body }) => {
  requiereRol(req, 'admin');
  const m = db.prepare("SELECT * FROM usuarios WHERE id = ? AND rol = 'mensajero'").get(Number(params.id));
  if (!m) falla(404, 'No encontramos ese mensajero.');
  const activo = body.activo !== undefined ? (body.activo ? 1 : 0) : m.activo;
  const veh = body.vehiculo_id !== undefined ? numero(body.vehiculo_id) : m.vehiculo_id;
  db.prepare('UPDATE usuarios SET activo = ?, vehiculo_id = ? WHERE id = ?').run(activo, Number.isFinite(veh) ? veh : null, m.id);
  if (body.password) {
    if (String(body.password).length < 8) falla(400, 'La contraseña debe tener al menos 8 caracteres.');
    db.prepare('UPDATE usuarios SET password_hash = ? WHERE id = ?').run(hashPassword(String(body.password)), m.id);
  }
  if (!activo) db.prepare('DELETE FROM sesiones WHERE usuario_id = ?').run(m.id);
  return { ok: true };
});

ruta('GET', '/api/admin/tarifas', ({ req }) => {
  requiereRol(req, 'admin');
  return {
    vehiculos: db.prepare('SELECT * FROM vehiculos ORDER BY orden, id').all(),
    zonas: db.prepare('SELECT * FROM zonas_fijas ORDER BY id').all(),
    ajustes: getAjustes(),
  };
});

ruta('PUT', '/api/admin/vehiculos/:id', ({ req, params, body }) => {
  requiereRol(req, 'admin');
  const v = db.prepare('SELECT * FROM vehiculos WHERE id = ?').get(Number(params.id));
  if (!v) falla(404, 'No encontramos ese vehículo.');
  const nombre = texto(body.nombre ?? v.nombre, 40), descripcion = texto(body.descripcion ?? v.descripcion, 120);
  const nums = {};
  for (const k of ['peso_max', 'tarifa_zona', 'tarifa_base', 'precio_km']) {
    nums[k] = body[k] !== undefined ? numero(body[k]) : v[k];
    if (!(nums[k] >= 0 && nums[k] <= 100000)) falla(400, 'Revisa los números: deben ser cantidades válidas.');
  }
  if (nombre.length < 2) falla(400, 'Escribe el nombre del vehículo.');
  const activo = body.activo !== undefined ? (body.activo ? 1 : 0) : v.activo;
  db.prepare('UPDATE vehiculos SET nombre=?, descripcion=?, peso_max=?, tarifa_zona=?, tarifa_base=?, precio_km=?, activo=? WHERE id=?')
    .run(nombre, descripcion, nums.peso_max, redondear(nums.tarifa_zona), redondear(nums.tarifa_base), redondear(nums.precio_km), activo, v.id);
  return { ok: true };
});

ruta('POST', '/api/admin/zonas', ({ req, body }) => {
  requiereRol(req, 'admin');
  const nombre = texto(body.nombre, 60);
  if (nombre.length < 2 || nombre === OTRA_ZONA) falla(400, 'Escribe el nombre de la zona, por ejemplo "Zona 10".');
  db.prepare('INSERT INTO zonas_fijas (nombre) VALUES (?)').run(nombre);
  return { _status: 201, ok: true };
});

ruta('PUT', '/api/admin/zonas/:id', ({ req, params, body }) => {
  requiereRol(req, 'admin');
  const z = db.prepare('SELECT * FROM zonas_fijas WHERE id = ?').get(Number(params.id));
  if (!z) falla(404, 'No encontramos esa zona.');
  const nombre = body.nombre !== undefined ? texto(body.nombre, 60) : z.nombre;
  if (nombre.length < 2 || nombre === OTRA_ZONA) falla(400, 'Escribe el nombre de la zona.');
  db.prepare('UPDATE zonas_fijas SET nombre = ?, activa = ? WHERE id = ?').run(nombre, body.activa !== undefined ? (body.activa ? 1 : 0) : z.activa, z.id);
  return { ok: true };
});

ruta('PUT', '/api/admin/ajustes', ({ req, body }) => {
  requiereRol(req, 'admin');
  const up = db.prepare('INSERT INTO ajustes (clave, valor) VALUES (?, ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor');
  if (body.whatsapp !== undefined) up.run('whatsapp', String(body.whatsapp).replace(/\D/g, '').slice(0, 15));
  if (body.horario !== undefined) up.run('horario', texto(String(body.horario), 120));
  return { ok: true };
});

// ---------- Archivos estáticos ----------
const TIPOS = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8',
};
const PAGINAS = { '/': 'index.html', '/entrar': 'entrar.html', '/registro': 'registro.html', '/mi-cuenta': 'cliente.html',
  '/enviar': 'cliente.html', '/rastreo': 'rastreo.html', '/admin': 'admin.html', '/mensajero': 'mensajero.html' };

function servirEstatico(req, res, pathname) {
  const rel = PAGINAS[pathname] || pathname.replace(/^\/+/, '');
  const archivo = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!archivo.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
  fs.stat(archivo, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8', ...CABECERAS_SEGURIDAD });
      return fs.createReadStream(path.join(PUBLIC_DIR, '404.html')).on('error', () => res.end('No encontrado')).pipe(res);
    }
    const ext = path.extname(archivo).toLowerCase();
    const sinCache = ext === '.html' || rel === 'sw.js' || ext === '.webmanifest';
    res.writeHead(200, {
      'Content-Type': TIPOS[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': sinCache ? 'no-cache' : 'public, max-age=3600',
      ...CABECERAS_SEGURIDAD,
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(archivo).pipe(res);
  });
}

// ---------- Servidor ----------
const servidor = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;
  try {
    if (pathname.startsWith('/api/')) {
      // Protección CSRF básica: las peticiones que cambian datos deben venir de nuestra propia página
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        const origen = req.headers.origin;
        if (origen && new URL(origen).host !== req.headers.host) falla(403, 'Origen no permitido.');
        if (!(req.headers['content-type'] || '').includes('application/json')) falla(415, 'Formato no permitido.');
      }
      for (const r of rutas) {
        if (r.metodo !== req.method) continue;
        const m = pathname.match(r.re);
        if (!m) continue;
        const params = {};
        r.claves.forEach((k, i) => { params[k] = m[i + 1]; });
        const body = req.method === 'GET' ? {} : await leerJson(req);
        const out = (await r.fn({ req, res, params, body, query: url.searchParams })) || {};
        const { _status = 200, _headers = {}, ...data } = out;
        return json(res, _status, data, _headers);
      }
      falla(404, 'Ruta no encontrada.');
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') falla(405, 'Método no permitido.');
    servirEstatico(req, res, pathname);
  } catch (err) {
    if (err instanceof ErrorHttp) return json(res, err.status, { error: err.message });
    console.error(new Date().toISOString(), req.method, pathname, err);
    json(res, 500, { error: 'Ocurrió un error en el servidor. Inténtalo de nuevo en un momento.' });
  }
});

if (require.main === module) {
  servidor.listen(PORT, HOST, () => console.log(`Vaelo funcionando en http://${HOST}:${PORT}`));
}
module.exports = { servidor, hashPassword };
