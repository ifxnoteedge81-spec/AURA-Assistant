FROM node:22-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install dependencies (including devDependencies for Vite PWA build)
COPY package*.json ./
RUN npm install --include=dev --no-audit --no-fund

# Copy project source (excluding local state/node_modules via .dockerignore)
COPY . .

# Build Vite + PWA client bundle into /app/dist
RUN npm run build

# Ensure non-root UID 1000 (required by Hugging Face Spaces Docker runtime) owns runtime directories
RUN mkdir -p /app/auth_info_baileys /app/client_sessions \
    && chown -R 1000:1000 /app

USER 1000

ENV NODE_ENV=production
ENV PORT=7860
ENV HOST=0.0.0.0
ENV ENABLE_SELF_PING=true

EXPOSE 7860

HEALTHCHECK --interval=30s --timeout=10s --start-period=25s --retries=3 \
  CMD curl -fsS http://127.0.0.1:7860/health || exit 1

CMD ["npm", "start"]
