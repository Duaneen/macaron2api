FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8787
ENV MACARON_BROWSER_EXECUTABLE=/usr/bin/chromium-browser

RUN apk add --no-cache \
  ca-certificates \
  chromium \
  freetype \
  harfbuzz \
  nss \
  ttf-freefont

COPY package*.json ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev --audit=false --fund=false; else npm install --omit=dev --audit=false --fund=false; fi

COPY src ./src

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8787) + '/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

USER node

CMD ["npm", "start"]
