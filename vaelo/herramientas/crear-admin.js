// Crea (o convierte en) administrador una cuenta.
// Uso: VAELO_ADMIN_EMAIL=correo VAELO_ADMIN_PASSWORD=clave VAELO_ADMIN_NOMBRE="Nombre" node herramientas/crear-admin.js
'use strict';
const { db } = require('../db');
const { hashPassword } = require('../server');

const email = String(process.env.VAELO_ADMIN_EMAIL || '').trim().toLowerCase();
const password = String(process.env.VAELO_ADMIN_PASSWORD || '');
const nombre = String(process.env.VAELO_ADMIN_NOMBRE || 'Administrador').trim();

if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { console.error('Correo no válido.'); process.exit(1); }
if (password.length < 8) { console.error('La contraseña debe tener al menos 8 caracteres.'); process.exit(1); }

const existe = db.prepare('SELECT id FROM usuarios WHERE email = ?').get(email);
if (existe) {
  db.prepare("UPDATE usuarios SET rol = 'admin', password_hash = ? WHERE id = ?").run(hashPassword(password), existe.id);
  console.log(`Listo: ${email} ahora es administrador (contraseña actualizada).`);
} else {
  db.prepare("INSERT INTO usuarios (nombre, email, telefono, password_hash, rol) VALUES (?, ?, '', ?, 'admin')")
    .run(nombre, email, hashPassword(password));
  console.log(`Listo: cuenta de administrador creada para ${email}.`);
}
