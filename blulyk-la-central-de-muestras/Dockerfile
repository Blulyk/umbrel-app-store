FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY lib ./lib
COPY public ./public
COPY server.js ./

EXPOSE 3000

CMD ["node", "server.js"]
