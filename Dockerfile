# ---- build ----
FROM node:20-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

# ---- runtime ----
FROM node:20-bookworm-slim
WORKDIR /app
# Video downloads for bookmarks (yt-dlp + ffmpeg, about 120 MB). Build with
# --build-arg SCUTE_MEDIA_TOOLS=off to leave them out; Scute then saves pages only.
ARG SCUTE_MEDIA_TOOLS=on
RUN if [ "$SCUTE_MEDIA_TOOLS" != "off" ]; then \
      apt-get update && apt-get install -y --no-install-recommends python3 ffmpeg ca-certificates curl \
      && rm -rf /var/lib/apt/lists/* \
      && mkdir -p /opt/yt-dlp \
      && curl -fsSL -o /opt/yt-dlp/yt-dlp https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
      && chmod 755 /opt/yt-dlp/yt-dlp && chown -R node:node /opt/yt-dlp; \
    fi
ENV NODE_ENV=production \
    PORT=5000 \
    SCUTE_DATA_DIR=/data \
    PATH=/opt/yt-dlp:$PATH
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 5000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||5000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.cjs"]
