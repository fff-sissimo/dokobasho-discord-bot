FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY scripts ./scripts
COPY index.js deploy-commands.js scheduler.js resource-server.js ./

CMD ["node", "index.js"]
