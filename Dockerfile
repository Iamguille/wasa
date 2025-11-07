# Dockerfile

# ---- Etapa 1: Construcción (Instalar dependencias) ----
FROM node:20-bullseye-slim AS builder
WORKDIR /usr/src/app

COPY package.json pnpm-lock.yaml ./

RUN npm install -g pnpm
RUN pnpm install --frozen-lockfile --prod

# ---- Etapa 2: Producción (La imagen final) ----
FROM node:20-bullseye-slim
WORKDIR /usr/src/app

COPY --from=builder /usr/src/app/node_modules ./node_modules
COPY . .

# Exponemos el puerto que usará el servidor API
EXPOSE 3000

# El comando para iniciar la API
CMD [ "node", "index.js" ]