FROM node:22-alpine AS client-build
WORKDIR /client
COPY ../client/package.json ../client/package-lock.json* ./
RUN npm ci
COPY ../client/ .
RUN npx vite build

FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
COPY src/ ./src/
COPY --from=client-build /client/dist ./client-dist/
EXPOSE 3010
CMD ["node", "src/index.js"]
