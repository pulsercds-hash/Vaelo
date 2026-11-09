# Vaelo Mensajería

Página web y sistema de envíos de Vaelo: los clientes crean su cuenta, piden envíos y los rastrean con su número de guía. El administrador maneja pedidos, clientes y tarifas desde `/admin`.

## Qué incluye

| Dirección | Para quién | Qué hace |
|---|---|---|
| `/` | Todos | Página principal, cotizador de precios y rastreo |
| `/registro`, `/entrar` | Clientes | Crear cuenta e iniciar sesión |
| `/mi-cuenta` | Clientes | Pedir envíos, ver sus envíos, imprimir la guía, cancelar |
| `/rastreo` | Todos | Seguir un envío con el número de guía |
| `/admin` | Administrador | Cambiar estados, ver clientes, editar zonas y precios |

## Tecnología

- **Node.js 22**, sin paquetes externos (no hace falta `npm install`).
- **SQLite** como base de datos: un solo archivo en `/var/lib/vaelo/vaelo.db`, con copia de seguridad diaria en `/var/lib/vaelo/respaldos/` (se guardan 14 días).
- **Nginx** recibe las visitas y se las pasa al sistema.

## Instalar en el servidor (una sola vez)

En la Web Console de DigitalOcean:

```bash
git clone https://github.com/TU_USUARIO/vaelo.git /opt/vaelo
bash /opt/vaelo/deploy/install.sh
```

Al final te pide el correo y la contraseña de tu cuenta de administrador.

## Actualizar después de cambiar algo en GitHub

```bash
bash /opt/vaelo/deploy/actualizar.sh
```

## Comandos útiles

```bash
systemctl status vaelo          # ver si está funcionando
journalctl -u vaelo -n 50       # ver los últimos errores
systemctl restart vaelo         # reiniciar
```

## Cambiar el logo

Reemplaza `public/img/favicon.svg` (el ícono de la pestaña). El logo de la barra superior está en `public/js/comun.js`, en `LOGO_SVG`.
