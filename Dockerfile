# ---------------------------------------------------------------------------
# Lumo Panel imajı.
# Panel yalnızca KONTROL DÜZLEMİDİR: botlar bu imajın içinde değil, panelin
# başlattığı ayrı ve izole konteynerlerde çalışır. Bu yüzden imajda docker CLI
# bulunur ve /var/run/docker.sock mount edilir (aşağıdaki uyarıya bak).
# ---------------------------------------------------------------------------
FROM node:22-alpine

RUN apk add --no-cache docker-cli tini

WORKDIR /app

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    PANEL_DATA_DIR=/app/data \
    PANEL_BOTS_DIR=/app/bots \
    PANEL_BOT_DRIVER=docker

# Sıfır çalışma zamanı bağımlılığı: npm install adımı yok.
COPY package.json ./
COPY server ./server
COPY public ./public

RUN mkdir -p /app/data /app/bots

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server/index.js"]
