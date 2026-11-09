# Vaelo Mensajería

Página web y app (instalable en el celular) de Vaelo, mensajería en moto y pickup en Guatemala. Los clientes crean su cuenta, envían paquetes marcando recogida y entrega en el mapa, y siguen al mensajero hasta la entrega.

**Precios:** tarifa fija cuando recogida y entrega están en las zonas cubiertas (1, 6, 16, 17, 18 y 24, editables). Fuera de ellas: arranque + kilómetros × precio por km, según el vehículo. Todo se edita en `/admin` → Tarifas y ajustes.

## Qué incluye

| Dirección | Para quién | Qué hace |
|---|---|---|
| `/` | Todos | Página principal, cotizador de precios y rastreo |
| `/registro`, `/entrar` | Clientes | Crear cuenta e iniciar sesión |
| `/enviar`, `/mi-cuenta` | Clientes | Enviar paquetes (vehículo, peso, mapa), seguirlos en el mapa, imprimir la guía |
| `/mensajero` | Mensajeros | Ver entregas asignadas, navegar con Google Maps o Waze, marcar recogido/entregado, compartir ubicación |
| `/rastreo` | Todos | Seguir un envío con el número de guía |
| `/admin` | Administrador | Asignar mensajeros, cambiar estados, mapa de la flota, clientes, vehículos, zonas y precios |

## Tecnología

- **Node.js 22**, sin paquetes externos (no hace falta `npm install`).
- **SQLite** como base de datos: un solo archivo en `/var/lib/vaelo/vaelo.db`, con copia de seguridad diaria en `/var/lib/vaelo/respaldos/` (se guardan 14 días).
- **Nginx** recibe las visitas y se las pasa al sistema.
- **Mapas:** Leaflet con OpenStreetMap (gratis, sin llave). Kilómetros por calle con el servicio público de OSRM; si no responde, se estima con la distancia en línea recta × 1.4.

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

## Logo

`public/img/logo-blanco.png` (barra y pie), `public/img/logo-negro.png` (guías) y los íconos de la app `icono-192.png`, `icono-512.png`, `apple-touch-icon.png`, `favicon.png`.
