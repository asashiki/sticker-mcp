FROM node:22-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm install --include=optional --os=linux --libc=musl --cpu=x64 --no-audit --no-fund

FROM deps AS build
COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build
RUN npm prune --omit=dev --include=optional

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/app/data
ENV NODE_OPTIONS=--enable-source-maps
COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
RUN mkdir -p /app/data/images && chown -R node:node /app
USER node
EXPOSE 3000
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
