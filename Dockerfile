### Stage 1: Build frontend
FROM node:22-alpine AS client
WORKDIR /client
COPY client/package.json client/package-lock.json* ./
RUN npm ci
COPY client/ .
RUN npx vite build

### Stage 2: Production server
FROM node:22-alpine
WORKDIR /app

COPY server/package.json server/package-lock.json* ./
RUN npm ci --omit=dev

COPY server/src/ ./src/
COPY --from=client /client/dist ./client/dist/

EXPOSE 3010
CMD ["node", "src/index.js"]
