### Stage 1: Build frontend
FROM node:22-alpine AS client
WORKDIR /client
COPY client/package.json client/package-lock.json* ./
RUN npm ci
COPY client/ .
RUN npx vite build

### Stage 2: Production server
FROM node:22-slim
WORKDIR /app

# Install Chromium + dependencies for whatsapp-web.js / Puppeteer
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-liberation \
    libnss3 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libgbm1 \
    libasound2 \
    && rm -rf /var/lib/apt/lists/*

# Tell Puppeteer to use system Chromium instead of downloading its own
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

COPY server/package.json server/package-lock.json* ./
RUN npm ci --omit=dev

COPY server/src/ ./src/
COPY --from=client /client/dist ./client/dist/

EXPOSE 3010
CMD ["node", "src/index.js"]
