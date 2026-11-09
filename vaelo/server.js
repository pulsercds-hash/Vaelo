// Servidor de Vaelo Mensajería
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

const ESTADOS = ['pendiente', 'recogido', 'en_camino', 'entregado', 'cancelado'];
const TAMANOS = ['pequeno', 'mediano', 'grande'];
const METODOS_PAGO = ['efectivo', 'transferencia'];

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
    const bytes = crypto.randomBytes(8);
    let s = '';
    for (const b of bytes) s += ALFABETO_GUIA[b % ALFABETO_GUIA.length];
    const guia = `VA-${s}`;
    if (!db.prepare('SELECT 1 FROM envios WHERE guia = ?').get(guia)) return guia;
  }
}

function texto(v, max = 200) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}
function numero(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}
const redondear = (n) => Math.round(n * 100) / 100;

function getAjustes() {
  const out = {};
  for (const r of db.prepare('SELECT clave, valor FROM ajustes').all()) out[r.clave] = r.valor;
  return out;
}
function calcularPrecio(zonaDestinoId, tamano) {
  const zona = db.prepare('SELECT * FROM zonas WHERE id = ? AND activa = 1').get(zonaDestinoId);
  if (!zona) return null;
  const aj = getAjustes();
  const recargo = tamano === 'mediano' ? Number(aj.recargo_mediano || 0)
    : tamano === 'grande' ? Number(aj.recargo_grande || 0) : 0;
  return redondear(zona.precio + recargo);
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
};
function json(res, status, data, extra = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...CABECERAS_SEGURIDAD,
    ...extra,
  });
  res.end(body);
}
class ErrorHttp extends Error {
  constructor(status, mensaje) { super(mensaje); this.status = status; }
}
const falla = (status, mensaje) => { throw new ErrorHttp(status, mensaje); };

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
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new ErrorHttp(400, 'Formato de datos inválido.')); }
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
function esHttps(req) {
  return req.headers['x-forwarded-proto'] === 'https' || /"scheme":"https"/.test(req.headers['cf-visitor'] || '');
}
function cookieSesion(req, token, maxAgeSeg) {
  return `vaelo_sesion=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeg}${esHttps(req) ? '; Secure' : ''}`;
}
function ipDe(req) {
  return req.headers['cf-connecting-ip'] || req.headers['x-real-ip'] || req.socket.remoteAddress || '';
}

function usuarioActual(req) {
  const token = leerCookies(req).vaelo_sesion;
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const fila = db.prepare(`
    SELECT u.id, u.nombre, u.email, u.telefono, u.rol FROM sesiones s
    JOIN usuarios u ON u.id = s.usuario_id
    WHERE s.token = ? AND s.expira > ?`).get(token, Date.now());
  return fila || null;
}
function requiereUsuario(req) {
  const u = usuarioActual(req);
  if (!u) falla(401, 'Inicia sesión para continuar.');
  return u;
}
function requiereAdmin(req) {
  const u = requiereUsuario(req);
  if (u.rol !== 'admin') falla(403, 'Esta sección es solo para administradores.');
  return u;
}
function crearSesion(req, res, usuarioId) {
  const token = crypto.randomBytes(32).toString('hex');
  const maxAge = SESION_DIAS * 86400;
  db.prepare('INSERT INTO sesiones (token, usuario_id, expira) VALUES (?, ?, ?)')
    .run(token, usuarioId, Date.now() + maxAge * 1000);
  return cookieSesion(req, token, maxAge);
}

// ---------- Rutas de la API ----------
const rutas = [];
const ruta = (metodo, patron, fn) => {
  const claves = [];
  const re = new RegExp('^' + patron.replace(/:(\w+)/g, (_, k) => { claves.push(k); return '([^/]+)'; }) + '$');
  rutas.push({ metodo, re, claves, fn });
};

function envioPublico(e) {
  return {
    id: e.id, guia: e.guia, estado: e.estado, precio: e.precio, tamano: e.tamano,
    origen_direccion: e.origen_direccion, origen_zona: e.origen_zona, origen_telefono: e.origen_telefono,
    destino_nombre: e.destino_nombre, destino_telefono: e.destino_telefono,
    destino_direccion: e.destino_direccion, destino_zona: e.destino_zona,
    descripcion: e.descripcion, notas: e.notas, metodo_pago: e.metodo_pago,
    cobro_destinatario: e.cobro_destinatario, creado: e.creado, actualizado: e.actualizado,
    cliente_nombre: e.cliente_nombre, cliente_email: e.cliente_email, cliente_telefono: e.cliente_telefono,
  };
}
const SQL_ENVIO = `
  SELECT e.*, zo.nombre AS origen_zona, zd.nombre AS destino_zona,
         u.nombre AS cliente_nombre, u.email AS cliente_email, u.telefono AS cliente_telefono
  FROM envios e
  LEFT JOIN zonas zo ON zo.id = e.origen_zona_id
  LEFT JOIN zonas zd ON zd.id = e.destino_zona_id
  JOIN usuarios u ON u.id = e.usuario_id`;

// Público
ruta('GET', '/api/config', () => {
  const aj = getAjustes();
  return {
    zonas: db.prepare('SELECT id, nombre, precio FROM zonas WHERE activa = 1 ORDER BY nombre').all(),
    recargos: { pequeno: 0, mediano: Number(aj.recargo_mediano || 0), grande: Number(aj.recargo_grande || 0) },
    whatsapp: aj.whatsapp || '',
    horario: aj.horario || '',
  };
});

ruta('GET', '/api/rastreo/:guia', ({ params }) => {
  const guia = decodeURIComponent(params.guia).toUpperCase().replace(/\s+/g, '');
  const e = db.prepare(`
    SELECT e.id, e.guia, e.estado, e.creado, e.destino_nombre, zd.nombre AS destino_zona, zo.nombre AS origen_zona
    FROM envios e LEFT JOIN zonas zd ON zd.id = e.destino_zona_id LEFT JOIN zonas zo ON zo.id = e.origen_zona_id
    WHERE e.guia = ?`).get(guia);
  if (!e) falla(404, 'No encontramos un envío con esa guía. Revisa que esté bien escrita, por ejemplo VA-7K3M9QX2.');
  const eventos = db.prepare('SELECT estado, nota, creado FROM eventos WHERE envio_id = ? ORDER BY id').all(e.id);
  return {
    guia: e.guia, estado: e.estado, creado: e.creado,
    origen_zona: e.origen_zona, destino_zona: e.destino_zona,
    destinatario: (e.destino_nombre || '').split(/\s+/)[0],
    eventos,
  };
});

// Cuentas
ruta('POST', '/api/registro', async ({ req, body }) => {
  if (limitar(ipDe(req), 'registro', 10, 3600_000)) falla(429, 'Demasiados intentos. Espera un momento e inténtalo de nuevo.');
  const nombre = texto(body.nombre, 100);
  const email = texto(body.email, 150).toLowerCase();
  const telefono = texto(body.telefono, 30);
  const password = typeof body.password === 'string' ? body.password : '';
  if (nombre.length < 2) falla(400, 'Escribe tu nombre completo.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) falla(400, 'Escribe un correo válido.');
  if (telefono.replace(/\D/g, '').length < 8) falla(400, 'Escribe un teléfono de al menos 8 dígitos.');
  if (password.length < 8) falla(400, 'La contraseña debe tener al menos 8 caracteres.');
  if (db.prepare('SELECT 1 FROM usuarios WHERE email = ?').get(email)) falla(409, 'Ya existe una cuenta con ese correo. Inicia sesión.');
  const r = db.prepare('INSERT INTO usuarios (nombre, email, telefono, password_hash) VALUES (?, ?, ?, ?)')
    .run(nombre, email, telefono, hashPassword(password));
  const cookie = crearSesion(req, null, Number(r.lastInsertRowid));
  return { _status: 201, _headers: { 'Set-Cookie': cookie }, ok: true, rol: 'cliente' };
});

ruta('POST', '/api/login', ({ req, body }) => {
  if (limitar(ipDe(req), 'login', 10, 900_000)) falla(429, 'Demasiados intentos. Espera 15 minutos e inténtalo de nuevo.');
  const email = texto(body.email, 150).toLowerCase();
  const password = typeof body.password === 'string' ? body.password : '';
  const u = db.prepare('SELECT * FROM usuarios WHERE email = ?').get(email);
  if (!u || !verificarPassword(password, u.password_hash)) falla(401, 'Correo o contraseña incorrectos.');
  const cookie = crearSesion(req, null, u.id);
  return { _headers: { 'Set-Cookie': cookie }, ok: true, rol: u.rol };
});

ruta('POST', '/api/logout', ({ req }) => {
  const token = leerCookies(req).vaelo_sesion;
  if (token) db.prepare('DELETE FROM sesiones WHERE token = ?').run(token);
  return { _headers: { 'Set-Cookie': cookieSesion(req, '', 0) }, ok: true };
});

ruta('GET', '/api/yo', ({ req }) => ({ usuario: usuarioActual(req) }));

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
  const filas = db.prepare(`${SQL_ENVIO} WHERE e.usuario_id = ? ORDER BY e.id DESC LIMIT 200`).all(u.id);
  return { envios: filas.map(envioPublico) };
});

ruta('POST', '/api/envios', ({ req, body }) => {
  const u = requiereUsuario(req);
  const d = {
    origen_direccion: texto(body.origen_direccion, 300),
    origen_zona_id: numero(body.origen_zona_id),
    origen_telefono: texto(body.origen_telefono, 30) || u.telefono,
    destino_nombre: texto(body.destino_nombre, 100),
    destino_telefono: texto(body.destino_telefono, 30),
    destino_direccion: texto(body.destino_direccion, 300),
    destino_zona_id: numero(body.destino_zona_id),
    tamano: texto(body.tamano, 20),
    descripcion: texto(body.descripcion, 200),
    notas: texto(body.notas, 300),
    metodo_pago: texto(body.metodo_pago, 20) || 'efectivo',
    cobro_destinatario: body.cobro_destinatario === '' || body.cobro_destinatario == null ? 0 : numero(body.cobro_destinatario),
  };
  if (d.origen_direccion.length < 5) falla(400, 'Escribe la dirección donde recogemos el paquete.');
  if (!db.prepare('SELECT 1 FROM zonas WHERE id = ? AND activa = 1').get(d.origen_zona_id)) falla(400, 'Elige la zona de recogida.');
  if (d.destino_nombre.length < 2) falla(400, 'Escribe el nombre de quien recibe.');
  if (d.destino_telefono.replace(/\D/g, '').length < 8) falla(400, 'Escribe el teléfono de quien recibe (8 dígitos o más).');
  if (d.destino_direccion.length < 5) falla(400, 'Escribe la dirección de entrega.');
  if (!TAMANOS.includes(d.tamano)) falla(400, 'Elige el tamaño del paquete.');
  if (!METODOS_PAGO.includes(d.metodo_pago)) falla(400, 'Elige cómo vas a pagar el envío.');
  if (!Number.isFinite(d.cobro_destinatario) || d.cobro_destinatario < 0 || d.cobro_destinatario > 5000) falla(400, 'El monto a cobrar al destinatario no es válido.');
  const precio = calcularPrecio(d.destino_zona_id, d.tamano);
  if (precio == null) falla(400, 'Elige la zona de entrega.');

  const guia = nuevaGuia();
  db.exec('BEGIN');
  try {
    const r = db.prepare(`INSERT INTO envios
      (guia, usuario_id, origen_direccion, origen_zona_id, origen_telefono, destino_nombre, destino_telefono,
       destino_direccion, destino_zona_id, tamano, descripcion, notas, metodo_pago, cobro_destinatario, precio)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      guia, u.id, d.origen_direccion, d.origen_zona_id, d.origen_telefono, d.destino_nombre, d.destino_telefono,
      d.destino_direccion, d.destino_zona_id, d.tamano, d.descripcion, d.notas, d.metodo_pago, redondear(d.cobro_destinatario), precio);
    db.prepare('INSERT INTO eventos (envio_id, estado, nota) VALUES (?, ?, ?)')
      .run(r.lastInsertRowid, 'pendiente', 'Solicitud recibida');
    db.exec('COMMIT');
    return { _status: 201, guia, precio };
  } catch (err) { db.exec('ROLLBACK'); throw err; }
});

ruta('POST', '/api/envios/:id/cancelar', ({ req, params }) => {
  const u = requiereUsuario(req);
  const e = db.prepare('SELECT * FROM envios WHERE id = ? AND usuario_id = ?').get(Number(params.id), u.id);
  if (!e) falla(404, 'No encontramos ese envío.');
  if (e.estado !== 'pendiente') falla(400, 'Solo puedes cancelar envíos que todavía no hemos recogido.');
  db.prepare("UPDATE envios SET estado = 'cancelado', actualizado = datetime('now') WHERE id = ?").run(e.id);
  db.prepare('INSERT INTO eventos (envio_id, estado, nota) VALUES (?, ?, ?)').run(e.id, 'cancelado', 'Cancelado por el cliente');
  return { ok: true };
});

// Administración
ruta('GET', '/api/admin/resumen', ({ req }) => {
  requiereAdmin(req);
  const porEstado = {};
  for (const s of ESTADOS) porEstado[s] = 0;
  for (const r of db.prepare('SELECT estado, COUNT(*) AS n FROM envios GROUP BY estado').all()) porEstado[r.estado] = r.n;
  const hoy = db.prepare("SELECT COUNT(*) AS n FROM envios WHERE date(creado, '-6 hours') = date('now', '-6 hours')").get().n;
  const mes = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(precio), 0) AS total FROM envios
    WHERE estado = 'entregado' AND strftime('%Y-%m', actualizado, '-6 hours') = strftime('%Y-%m', 'now', '-6 hours')`).get();
  const clientes = db.prepare("SELECT COUNT(*) AS n FROM usuarios WHERE rol = 'cliente'").get().n;
  return { porEstado, hoy, entregadosMes: mes.n, ingresosMes: redondear(mes.total), clientes };
});

ruta('GET', '/api/admin/envios', ({ req, query }) => {
  requiereAdmin(req);
  const cond = [];
  const args = [];
  const estado = query.get('estado');
  if (estado && ESTADOS.includes(estado)) { cond.push('e.estado = ?'); args.push(estado); }
  const q = (query.get('q') || '').trim().slice(0, 100);
  if (q) {
    cond.push('(e.guia LIKE ? OR e.destino_nombre LIKE ? OR u.nombre LIKE ? OR e.destino_telefono LIKE ?)');
    const like = `%${q}%`;
    args.push(like, like, like, like);
  }
  const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
  const filas = db.prepare(`${SQL_ENVIO} ${where} ORDER BY e.id DESC LIMIT 300`).all(...args);
  return { envios: filas.map(envioPublico) };
});

ruta('GET', '/api/admin/envios/:id', ({ req, params }) => {
  requiereAdmin(req);
  const e = db.prepare(`${SQL_ENVIO} WHERE e.id = ?`).get(Number(params.id));
  if (!e) falla(404, 'No encontramos ese envío.');
  const eventos = db.prepare('SELECT estado, nota, creado FROM eventos WHERE envio_id = ? ORDER BY id').all(e.id);
  return { envio: envioPublico(e), eventos };
});

ruta('POST', '/api/admin/envios/:id/estado', ({ req, params, body }) => {
  requiereAdmin(req);
  const estado = texto(body.estado, 20);
  if (!ESTADOS.includes(estado)) falla(400, 'Estado no válido.');
  const nota = texto(body.nota, 300);
  const e = db.prepare('SELECT id FROM envios WHERE id = ?').get(Number(params.id));
  if (!e) falla(404, 'No encontramos ese envío.');
  db.prepare("UPDATE envios SET estado = ?, actualizado = datetime('now') WHERE id = ?").run(estado, e.id);
  db.prepare('INSERT INTO eventos (envio_id, estado, nota) VALUES (?, ?, ?)').run(e.id, estado, nota);
  return { ok: true };
});

ruta('GET', '/api/admin/clientes', ({ req }) => {
  requiereAdmin(req);
  const filas = db.prepare(`
    SELECT u.id, u.nombre, u.email, u.telefono, u.rol, u.creado,
      (SELECT COUNT(*) FROM envios e WHERE e.usuario_id = u.id) AS envios
    FROM usuarios u ORDER BY u.id DESC LIMIT 500`).all();
  return { clientes: filas };
});

ruta('GET', '/api/admin/zonas', ({ req }) => {
  requiereAdmin(req);
  return { zonas: db.prepare('SELECT * FROM zonas ORDER BY activa DESC, nombre').all(), ajustes: getAjustes() };
});

ruta('POST', '/api/admin/zonas', ({ req, body }) => {
  requiereAdmin(req);
  const nombre = texto(body.nombre, 80);
  const precio = numero(body.precio);
  if (nombre.length < 2) falla(400, 'Escribe el nombre de la zona.');
  if (!(precio >= 0 && precio <= 500)) falla(400, 'Escribe un precio válido.');
  db.prepare('INSERT INTO zonas (nombre, precio) VALUES (?, ?)').run(nombre, redondear(precio));
  return { _status: 201, ok: true };
});

ruta('PUT', '/api/admin/zonas/:id', ({ req, params, body }) => {
  requiereAdmin(req);
  const z = db.prepare('SELECT * FROM zonas WHERE id = ?').get(Number(params.id));
  if (!z) falla(404, 'No encontramos esa zona.');
  const nombre = body.nombre !== undefined ? texto(body.nombre, 80) : z.nombre;
  const precio = body.precio !== undefined ? numero(body.precio) : z.precio;
  const activa = body.activa !== undefined ? (body.activa ? 1 : 0) : z.activa;
  if (nombre.length < 2) falla(400, 'Escribe el nombre de la zona.');
  if (!(precio >= 0 && precio <= 500)) falla(400, 'Escribe un precio válido.');
  db.prepare('UPDATE zonas SET nombre = ?, precio = ?, activa = ? WHERE id = ?').run(nombre, redondear(precio), activa, z.id);
  return { ok: true };
});

ruta('PUT', '/api/admin/ajustes', ({ req, body }) => {
  requiereAdmin(req);
  const permitidos = { recargo_mediano: 'num', recargo_grande: 'num', whatsapp: 'tel', horario: 'txt' };
  const up = db.prepare('INSERT INTO ajustes (clave, valor) VALUES (?, ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor');
  for (const [k, tipo] of Object.entries(permitidos)) {
    if (body[k] === undefined) continue;
    let v = String(body[k]).trim();
    if (tipo === 'num') {
      const n = Number(v);
      if (!(n >= 0 && n <= 500)) falla(400, 'Los recargos deben ser números entre 0 y 500.');
      v = redondear(n).toFixed(2);
    } else if (tipo === 'tel') {
      v = v.replace(/[^\d]/g, '').slice(0, 15);
    } else v = v.slice(0, 120);
    up.run(k, v);
  }
  return { ok: true };
});

// ---------- Archivos estáticos ----------
const TIPOS = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8',
};
const PAGINAS = { '/': 'index.html', '/entrar': 'entrar.html', '/registro': 'registro.html',
  '/mi-cuenta': 'cliente.html', '/rastreo': 'rastreo.html', '/admin': 'admin.html' };

function servirEstatico(req, res, pathname) {
  let rel = PAGINAS[pathname] || pathname.replace(/^\/+/, '');
  const archivo = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!archivo.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
  fs.stat(archivo, (err, st) => {
    if (err || !st.isFile()) {
      const p404 = path.join(PUBLIC_DIR, '404.html');
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8', ...CABECERAS_SEGURIDAD });
      return fs.createReadStream(p404).on('error', () => res.end('No encontrado')).pipe(res);
    }
    const ext = path.extname(archivo).toLowerCase();
    res.writeHead(200, {
      'Content-Type': TIPOS[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
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
