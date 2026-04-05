FROM node:20-alpine AS builder

# Install build dependencies for native modules (better-sqlite3)
RUN apk add --no-cache python3 make g++ gcc

WORKDIR /app

COPY package*.json ./
# Full install with native compilation
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/

# Compile TypeScript
RUN npm run build

# ── Production image ──────────────────────────────────────────────────────────
FROM node:20-alpine

RUN apk add --no-cache wget

WORKDIR /app

COPY package*.json ./
# Production deps with native compilation
RUN apk add --no-cache python3 make g++ gcc && \
    npm ci --omit=dev && \
    apk del python3 make g++ gcc

COPY --from=builder /app/dist ./dist

EXPOSE 3000

CMD ["node", "dist/index.js"]
