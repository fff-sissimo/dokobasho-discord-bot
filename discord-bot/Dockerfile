FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY index.js deploy-commands.js scheduler.js ./

CMD ["node", "index.js"]
