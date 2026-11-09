// Copia de seguridad diaria de la base de datos. Guarda los últimos 14 días.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { db, DATA_DIR } = require('../db');

const dir = path.join(DATA_DIR, 'respaldos');
fs.mkdirSync(dir, { recursive: true });
const fecha = new Date().toISOString().slice(0, 10);
const destino = path.join(dir, `vaelo-${fecha}.db`);
if (fs.existsSync(destino)) fs.unlinkSync(destino);
db.exec(`VACUUM INTO '${destino.replace(/'/g, "''")}'`);

const viejos = fs.readdirSync(dir).filter((f) => /^vaelo-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort().reverse().slice(14);
for (const f of viejos) fs.unlinkSync(path.join(dir, f));
console.log(`Respaldo guardado: ${destino}`);
