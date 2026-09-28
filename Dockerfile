# Lumo Panel — üretim imajı.
#
# Bağımlılık yok: npm install adımı da yok, sadece kaynak kopyalanır.
# Panel botları çalıştırmak için host'un Docker soketini kullanır; bu yüzden
# imaj içinde root olarak çalışır (bkz. README "Bilinen sınırlar").
# Daha sıkı bir kurulum istiyorsan `--user` ve `group_add: docker` kullan.

FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production \
    PANEL_PORT=8080 \
    PANEL_HOST=0.0.0.0 \
    PANEL_DATA_DIR=/data \
    PANEL_BOT_DRIVER=docker

COPY package.json ./
COPY server ./server
COPY public ./public

RUN mkdir -p /data /servers && chmod 700 /data

EXPOSE 8080
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O - http://127.0.0.1:8080/api/health >/dev/null || exit 1

CMD ["node", "server/index.js"]
