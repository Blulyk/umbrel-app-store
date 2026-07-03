FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache docker-cli docker-cli-compose

COPY package*.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY public ./public

ENV NODE_ENV=production
ENV PORT=3018

EXPOSE 3018

CMD ["node", "server.js"]
