# Jev as a service beside a Steel browser (browser-box). There is no browser in this image: it
# attaches to Steel over CDP and serves only the bearer-gated HTTP API. No brain key belongs in
# its environment; there it decides elements, nothing more.
FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    ELECTRON_SKIP_BINARY_DOWNLOAD=1

WORKDIR /app
COPY package.json package-lock.json ./
# Runtime dependencies, plus tsx at the version the lockfile pins (it runs the TypeScript).
# Globally: as a devDependency, a local install is skipped under --omit=dev.
RUN npm ci --omit=dev --ignore-scripts \
 && npm install --global "tsx@$(node -p "require('./package-lock.json').packages['node_modules/tsx'].version")" \
 && npm cache clean --force
COPY tsconfig.json ./
COPY core ./core
COPY server ./server

ENV PORT=3111 \
    JEV_HOST=0.0.0.0 \
    CDP_URL=ws://steel:3000/ \
    JEV_BLOCK_PRIVATE=1 \
    START_URL=about:blank \
    JEV_DEFAULT_SESSION=playwright \
    JEV_MAC=off \
    JEV_COMPUTER=off
USER node
EXPOSE 3111
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["tsx", "server/index.ts"]
