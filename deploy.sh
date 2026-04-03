#!/bin/bash
set -e

echo "⬡ Átrio Office — Deploy"
echo "========================"

APP_DIR="/opt/atrio-office"

# Cria diretório
mkdir -p $APP_DIR
cd $APP_DIR

# Clona ou atualiza (se tiver git) — por enquanto copia local
echo "[1/4] Preparando arquivos..."

# docker-compose.yml
cat > docker-compose.yml << 'COMPOSE'
services:
  db:
    image: postgres:17-alpine
    restart: unless-stopped
    environment:
      POSTGRES_DB: atrio_office
      POSTGRES_USER: atrio
      POSTGRES_PASSWORD: ${DB_PASSWORD}
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./server/src/db/schema.sql:/docker-entrypoint-initdb.d/01-schema.sql
      - ./server/src/db/seed.sql:/docker-entrypoint-initdb.d/02-seed.sql
      - ./server/src/db/migrate_tools_schema.sql:/docker-entrypoint-initdb.d/03-migrate.sql
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U atrio -d atrio_office"]
      interval: 5s
      timeout: 3s
      retries: 5

  server:
    build: ./server
    restart: unless-stopped
    depends_on:
      db:
        condition: service_healthy
    environment:
      DATABASE_URL: postgresql://atrio:${DB_PASSWORD}@db:5432/atrio_office
      MINIMAX_API_KEY: ${MINIMAX_API_KEY}
      MINIMAX_MODEL: ${MINIMAX_MODEL}
      GESTHUB_API_URL: ${GESTHUB_API_URL}
      PORT: 3010
      NODE_ENV: production
      CORS_ORIGIN: "*"
    ports:
      - "3010:3010"

  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    depends_on:
      - server
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile
      - caddy_data:/data
      - caddy_config:/config

volumes:
  pgdata:
  caddy_data:
  caddy_config:
COMPOSE

# Caddyfile
cat > Caddyfile << 'CADDY'
:80 {
  reverse_proxy server:3010
}
CADDY

# .env
cat > .env << 'ENV'
MINIMAX_API_KEY=sk-api-ygSY27o4Bg2i6q7Uu7UA0qgVlzYKL4CSQo2R8-gAntBEUbXjyn0lhfURJJBgGcLG8W5s9qx0f-WhNAiG1RbwGIa6vI7rpc28H3QgSWjYt-aD2oAlo_6LRvk
MINIMAX_MODEL=MiniMax-M2.5
GESTHUB_API_URL=https://gesthub-xlvb.onrender.com
DB_PASSWORD=AtrioDB2026!
ENV

echo "[2/4] Copiando código do servidor..."

# Cria estrutura
mkdir -p server/src/db server/src/services server/src/tools

# package.json
cat > server/package.json << 'PKG'
{
  "name": "atrio-office-server",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "start": "node src/index.js"
  },
  "dependencies": {
    "cors": "^2.8.5",
    "dotenv": "^16.4.7",
    "express": "^4.21.2",
    "openai": "^4.0.0",
    "pg": "^8.13.1",
    "uuid": "^11.1.0",
    "ws": "^8.18.0"
  }
}
PKG

# Dockerfile
cat > server/Dockerfile << 'DOCKER'
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY src/ ./src/
EXPOSE 3010
CMD ["node", "src/index.js"]
DOCKER

echo "[3/4] Baixando código fonte do repositório..."
echo "Os arquivos src/ precisam ser copiados manualmente ou via git."
echo ""
echo "Por favor, copie a pasta server/src/ do seu computador para $APP_DIR/server/src/"
echo ""

echo "[4/4] Para iniciar após copiar os arquivos:"
echo "  cd $APP_DIR"
echo "  docker compose up -d --build"
echo ""
echo "Para verificar:"
echo "  docker compose logs -f server"
echo "  curl http://localhost:3010/api/health"
echo ""
echo "⬡ Deploy preparado em $APP_DIR"
