#!/usr/bin/env bash
# Instalador de Vaelo para Ubuntu 24.04 (DigitalOcean)
# Uso:  bash /opt/vaelo/deploy/install.sh
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR=/var/lib/vaelo
DOMINIO="${DOMINIO:-vaelomensajeria.com}"
NODE_FLAGS="--disable-warning=ExperimentalWarning"

paso() { echo; echo "==> $1"; }

if [ "$(id -u)" -ne 0 ]; then echo "Ejecuta este instalador como root."; exit 1; fi
export DEBIAN_FRONTEND=noninteractive

paso "1/8 Actualizando el sistema"
apt-get update -y
apt-get install -y curl ca-certificates git nginx ufw

paso "2/8 Instalando Node.js 22"
NODE_MAYOR="$(node -v 2>/dev/null | sed 's/^v\([0-9]*\).*/\1/' || echo 0)"
if [ "${NODE_MAYOR:-0}" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node -v

paso "3/8 Creando usuario y carpeta de datos"
id vaelo >/dev/null 2>&1 || useradd --system --home "$DATA_DIR" --shell /usr/sbin/nologin vaelo
mkdir -p "$DATA_DIR"
chown -R vaelo:vaelo "$DATA_DIR"
chmod 750 "$DATA_DIR"

paso "4/8 Configurando el servicio (arranca solo si el servidor se reinicia)"
cat > /etc/systemd/system/vaelo.service <<EOF
[Unit]
Description=Vaelo Mensajeria
After=network.target

[Service]
User=vaelo
Group=vaelo
WorkingDirectory=$APP_DIR
Environment=NODE_ENV=production
Environment=PORT=3000
Environment=HOST=127.0.0.1
Environment=VAELO_DATA=$DATA_DIR
ExecStart=$(command -v node) $NODE_FLAGS $APP_DIR/server.js
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$DATA_DIR

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable vaelo >/dev/null
systemctl restart vaelo
sleep 2
systemctl is-active --quiet vaelo && echo "Servicio vaelo: funcionando" || { journalctl -u vaelo -n 30 --no-pager; exit 1; }

paso "5/8 Configurando Nginx para $DOMINIO"
cat > /etc/nginx/sites-available/vaelo <<EOF
map \$http_x_forwarded_proto \$proto_real {
  default \$http_x_forwarded_proto;
  ''      \$scheme;
}
server {
  listen 80 default_server;
  listen [::]:80 default_server;
  server_name $DOMINIO www.$DOMINIO;
  client_max_body_size 1m;

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$proto_real;
  }
}
EOF
ln -sf /etc/nginx/sites-available/vaelo /etc/nginx/sites-enabled/vaelo
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

paso "6/8 Firewall y memoria extra"
ufw allow OpenSSH >/dev/null
ufw allow 'Nginx Full' >/dev/null
ufw --force enable >/dev/null
if ! swapon --show | grep -q .; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  echo "Swap de 2 GB activado"
fi

paso "7/8 Copia de seguridad diaria (3:30 a. m.)"
cat > /etc/cron.d/vaelo-respaldo <<EOF
30 9 * * * vaelo VAELO_DATA=$DATA_DIR $(command -v node) $NODE_FLAGS $APP_DIR/herramientas/respaldo.js >/dev/null 2>&1
EOF
chmod 644 /etc/cron.d/vaelo-respaldo

paso "8/8 Cuenta de administrador"
HAY_ADMIN="$(runuser -u vaelo -- env VAELO_DATA=$DATA_DIR node $NODE_FLAGS -e "const {db}=require('$APP_DIR/db');console.log(db.prepare(\"SELECT COUNT(*) n FROM usuarios WHERE rol='admin'\").get().n)")"
if [ "$HAY_ADMIN" = "0" ]; then
  echo "Vamos a crear tu cuenta de administrador para entrar al panel."
  read -r -p "Tu correo: " ADMIN_EMAIL </dev/tty
  while :; do
    read -r -s -p "Contraseña (mínimo 8 caracteres, no se ve al escribir): " ADMIN_PASS </dev/tty; echo
    [ "${#ADMIN_PASS}" -ge 8 ] && break
    echo "Muy corta, inténtalo de nuevo."
  done
  runuser -u vaelo -- env VAELO_DATA="$DATA_DIR" VAELO_ADMIN_EMAIL="$ADMIN_EMAIL" VAELO_ADMIN_PASSWORD="$ADMIN_PASS" VAELO_ADMIN_NOMBRE="Administrador" \
    node $NODE_FLAGS "$APP_DIR/herramientas/crear-admin.js"
  unset ADMIN_PASS
else
  echo "Ya existe un administrador."
fi

# Certificado de seguridad en el servidor (para el modo SSL "Completo (estricto)" de Cloudflare)
if [ -n "${ADMIN_EMAIL:-}" ] && [ ! -d "/etc/letsencrypt/live/$DOMINIO" ]; then
  echo
  echo "==> Extra: certificado SSL en el servidor"
  apt-get install -y certbot python3-certbot-nginx >/dev/null
  if certbot --nginx -d "$DOMINIO" -d "www.$DOMINIO" --non-interactive --agree-tos -m "$ADMIN_EMAIL" --no-redirect; then
    echo "Certificado instalado. Ya puedes poner Cloudflare en SSL 'Completo (estricto)'."
  else
    echo "No se pudo instalar el certificado ahora. La página igual funciona con Cloudflare en modo 'Flexible'."
  fi
fi

echo
echo "============================================="
echo " Vaelo está instalado."
echo " Abre:  https://$DOMINIO"
echo " Panel: https://$DOMINIO/admin"
echo "============================================="
