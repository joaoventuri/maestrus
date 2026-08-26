# Imagem do relay do Maestrus remoto (Node + ws). Sem estado.
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund
COPY protocol.js link.js server.js ./
COPY bin ./bin
ENV PORT=8787
EXPOSE 8787
CMD ["node", "bin/relay.js"]
