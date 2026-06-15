FROM node:20-alpine

WORKDIR /app

# Instalar dependências primeiro (cache layer)
COPY package*.json ./
RUN npm ci --omit=dev

# Copiar código
COPY src/ ./src/

# Porta exposta
EXPOSE 3000

# Variáveis de ambiente padrão (sobrescritas pelo EasyPanel)
ENV NODE_ENV=production
ENV PORT=3000

CMD ["node", "src/index.js"]
