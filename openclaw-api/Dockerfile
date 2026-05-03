FROM node:22-alpine

ARG OPENCLAW_VERSION=2026.5.2

WORKDIR /app

RUN npm install -g "openclaw@${OPENCLAW_VERSION}"

COPY package.json ./
COPY src ./src

ENV NODE_ENV=production
ENV OPENCLAW_API_HOST=0.0.0.0
ENV OPENCLAW_API_PORT=8788

CMD ["sh", "-lc", "rm -rf /root/.openclaw/workspace && mkdir -p /root/.openclaw/workspace && cp -a /opt/dokobasho/openclaw/. /root/.openclaw/workspace/ && node src/server.js"]
