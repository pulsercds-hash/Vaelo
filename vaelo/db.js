// Base de datos de Vaelo (SQLite integrado en Node.js 22, sin instalar nada extra)
'use strict';
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

const DATA_DIR = process.env.VAELO_DATA || path.join(__dirname, 'datos');
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, 'vaelo.db');

const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;

  CREATE TABLE IF NOT EXISTS usuarios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    telefono TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL,
    rol TEXT NOT NULL DEFAULT 'cliente' CHECK (rol IN ('cliente','admin')),
    creado TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sesiones (
    token TEXT PRIMARY KEY,
    usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    expira INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS zonas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL,
    precio REAL NOT NULL,
    activa INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS envios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guia TEXT NOT NULL UNIQUE,
    usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
    origen_direccion TEXT NOT NULL,
    origen_zona_id INTEGER REFERENCES zonas(id),
    origen_telefono TEXT NOT NULL,
    destino_nombre TEXT NOT NULL,
    destino_telefono TEXT NOT NULL,
    destino_direccion TEXT NOT NULL,
    destino_zona_id INTEGER NOT NULL REFERENCES zonas(id),
    tamano TEXT NOT NULL CHECK (tamano IN ('pequeno','mediano','grande')),
    descripcion TEXT NOT NULL DEFAULT '',
    notas TEXT NOT NULL DEFAULT '',
    metodo_pago TEXT NOT NULL DEFAULT 'efectivo',
    cobro_destinatario REAL NOT NULL DEFAULT 0,
    precio REAL NOT NULL,
    estado TEXT NOT NULL DEFAULT 'pendiente',
    creado TEXT NOT NULL DEFAULT (datetime('now')),
    actualizado TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_envios_usuario ON envios(usuario_id);
  CREATE INDEX IF NOT EXISTS idx_envios_estado ON envios(estado);

  CREATE TABLE IF NOT EXISTS eventos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    envio_id INTEGER NOT NULL REFERENCES envios(id) ON DELETE CASCADE,
    estado TEXT NOT NULL,
    nota TEXT NOT NULL DEFAULT '',
    creado TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS ajustes (
    clave TEXT PRIMARY KEY,
    valor TEXT NOT NULL
  );
`);

// Datos iniciales: zonas y ajustes de ejemplo (se cambian desde el panel)
const hayZonas = db.prepare('SELECT COUNT(*) AS n FROM zonas').get().n;
if (!hayZonas) {
  const ins = db.prepare('INSERT INTO zonas (nombre, precio) VALUES (?, ?)');
  [
    ['San Salvador', 3.00],
    ['Antiguo Cuscatlán', 3.50],
    ['Santa Tecla', 3.50],
    ['Mejicanos', 3.50],
    ['Soyapango', 3.50],
    ['Ilopango', 4.00],
    ['San Marcos', 3.50],
    ['Apopa', 4.50],
    ['Otro departamento', 6.00],
  ].forEach(([n, p]) => ins.run(n, p));
}
const ajustesBase = {
  recargo_mediano: '1.00',
  recargo_grande: '3.00',
  whatsapp: '',
  horario: 'Lunes a sábado, 8:00 a. m. a 6:00 p. m.',
};
const insAj = db.prepare('INSERT OR IGNORE INTO ajustes (clave, valor) VALUES (?, ?)');
for (const [k, v] of Object.entries(ajustesBase)) insAj.run(k, v);

module.exports = { db, DB_PATH, DATA_DIR };
