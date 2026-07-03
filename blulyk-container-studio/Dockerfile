FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./
COPY public ./public

ENV NODE_ENV=production
ENV PORT=3018

EXPOSE 3018

CMD ["node", "server.js"]
