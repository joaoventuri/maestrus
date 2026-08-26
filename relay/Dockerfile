# Relay: broker WebSocket que faz client e host se acharem atras de NAT.
# Sem estado — nao persiste mensagem nem sessao, so encaminha.
FROM node:22-alpine
WORKDIR /app
# Instala deps primeiro para aproveitar o cache de camada entre builds.
COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev
COPY . .
# Nao roda como root: se o processo for comprometido, o estrago fica contido.
USER node
ENV PORT=8080
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "require('net').connect(process.env.PORT||8080,'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))"
CMD ["node", "server.js"]
