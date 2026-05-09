# ── Stage 1: Dependencies ─────────────────────────────────────────────────────
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --only=production

# ── Stage 2: Builder ─────────────────────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ── Stage 3: Runner ──────────────────────────────────────────────────────────
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Security: create non-root user
RUN addgroup --system --gid 1001 prayaas && \
    adduser --system --uid 1001 prayaas

COPY --from=builder /app/public ./public
COPY --from=builder --chown=prayaas:prayaas /app/.next/standalone ./
COPY --from=builder --chown=prayaas:prayaas /app/.next/static ./.next/static

USER prayaas

EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

CMD ["node", "server.js"]
