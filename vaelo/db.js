// Base de datos de Vaelo (SQLite integrado en Node.js 22, sin instalar nada extra)
'use strict';
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

const DATA_DIR = process.env.VAELO_DATA || path.join(__dirname, 'datos');
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, 'vaelo.db');

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');

const columnas = (tabla) => db.prepare(`PRAGMA table_info(${tabla})`).all().map((c) => c.name);
const existeTabla = (t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);

// ---------- Migración desde la versión 1 (El Salvador) ----------
db.exec('PRAGMA foreign_keys = OFF');
if (existeTabla('usuarios')) {
  const sql = db.prepare("SELECT sql FROM sqlite_master WHERE name='usuarios'").get().sql;
  if (!sql.includes('mensajero')) {
    db.exec(`
      BEGIN;
      CREATE TABLE usuarios_nueva (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nombre TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        telefono TEXT NOT NULL DEFAULT '',
        password_hash TEXT NOT NULL,
        rol TEXT NOT NULL DEFAULT 'cliente' CHECK (rol IN ('cliente','admin','mensajero')),
        vehiculo_id INTEGER,
        activo INTEGER NOT NULL DEFAULT 1,
        ubic_lat REAL, ubic_lng REAL, ubic_fecha TEXT,
        creado TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO usuarios_nueva (id, nombre, email, telefono, password_hash, rol, creado)
        SELECT id, nombre, email, telefono, password_hash, rol, creado FROM usuarios;
      DROP TABLE usuarios;
      ALTER TABLE usuarios_nueva RENAME TO usuarios;
      COMMIT;`);
  }
}
if (existeTabla('envios') && !columnas('envios').includes('vehiculo_id')) {
  // Los envíos de prueba de la versión anterior se guardan aparte, no se borran
  db.exec('ALTER TABLE envios RENAME TO envios_v1; ALTER TABLE eventos RENAME TO eventos_v1;');
}
db.exec('PRAGMA foreign_keys = ON');

// ---------- Esquema actual ----------
db.exec(`
  CREATE TABLE IF NOT EXISTS usuarios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    telefono TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL,
    rol TEXT NOT NULL DEFAULT 'cliente' CHECK (rol IN ('cliente','admin','mensajero')),
    vehiculo_id INTEGER,
    activo INTEGER NOT NULL DEFAULT 1,
    ubic_lat REAL, ubic_lng REAL, ubic_fecha TEXT,
    creado TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sesiones (
    token TEXT PRIMARY KEY,
    usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    expira INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS vehiculos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL,
    descripcion TEXT NOT NULL DEFAULT '',
    peso_max REAL NOT NULL,          -- libras
    tarifa_zona REAL NOT NULL,       -- precio fijo dentro de las zonas de la capital
    tarifa_base REAL NOT NULL,       -- precio de arranque fuera de esas zonas
    precio_km REAL NOT NULL,         -- precio por kilómetro fuera de esas zonas
    activo INTEGER NOT NULL DEFAULT 1,
    orden INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS zonas_fijas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL,
    activa INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS envios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guia TEXT NOT NULL UNIQUE,
    usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
    vehiculo_id INTEGER NOT NULL REFERENCES vehiculos(id),
    peso REAL NOT NULL,
    descripcion TEXT NOT NULL DEFAULT '',
    origen_direccion TEXT NOT NULL,
    origen_zona TEXT NOT NULL,
    origen_telefono TEXT NOT NULL,
    origen_lat REAL, origen_lng REAL,
    destino_nombre TEXT NOT NULL,
    destino_telefono TEXT NOT NULL,
    destino_direccion TEXT NOT NULL,
    destino_zona TEXT NOT NULL,
    destino_lat REAL, destino_lng REAL,
    tipo_tarifa TEXT NOT NULL CHECK (tipo_tarifa IN ('zona','km')),
    km REAL,
    precio REAL NOT NULL,
    metodo_pago TEXT NOT NULL DEFAULT 'efectivo',
    cobro_destinatario REAL NOT NULL DEFAULT 0,
    notas TEXT NOT NULL DEFAULT '',
    estado TEXT NOT NULL DEFAULT 'pendiente',
    mensajero_id INTEGER REFERENCES usuarios(id),
    creado TEXT NOT NULL DEFAULT (datetime('now')),
    actualizado TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_envios_usuario ON envios(usuario_id);
  CREATE INDEX IF NOT EXISTS idx_envios_estado ON envios(estado);
  CREATE INDEX IF NOT EXISTS idx_envios_mensajero ON envios(mensajero_id);

  CREATE TABLE IF NOT EXISTS eventos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    envio_id INTEGER NOT NULL REFERENCES envios(id) ON DELETE CASCADE,
    estado TEXT NOT NULL,
    nota TEXT NOT NULL DEFAULT '',
    lat REAL, lng REAL,
    creado TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS ajustes (
    clave TEXT PRIMARY KEY,
    valor TEXT NOT NULL
  );
`);

// ---------- Datos iniciales (se cambian desde el panel) ----------
if (!db.prepare('SELECT COUNT(*) AS n FROM vehiculos').get().n) {
  const ins = db.prepare(`INSERT INTO vehiculos (nombre, descripcion, peso_max, tarifa_zona, tarifa_base, precio_km, orden)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  ins.run('Moto', 'Sobres, paquetes y cajas pequeñas', 30, 35, 35, 4, 1);
  ins.run('Pickup', 'Cajas grandes, varios bultos o mercadería', 1500, 150, 150, 8, 2);
}
if (!db.prepare('SELECT COUNT(*) AS n FROM zonas_fijas').get().n) {
  const ins = db.prepare('INSERT INTO zonas_fijas (nombre) VALUES (?)');
  ['Zona 1', 'Zona 6', 'Zona 16', 'Zona 17', 'Zona 18', 'Zona 24'].forEach((z) => ins.run(z));
}
const insAj = db.prepare('INSERT OR IGNORE INTO ajustes (clave, valor) VALUES (?, ?)');
insAj.run('whatsapp', '');
insAj.run('horario', 'Lunes a sábado, 8:00 a. m. a 6:00 p. m.');
// Ajustes de la versión 1 que ya no se usan
db.prepare("DELETE FROM ajustes WHERE clave IN ('recargo_mediano','recargo_grande')").run();

module.exports = { db, DB_PATH, DATA_DIR };
