FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY central/ ./central/
RUN npm run build:central
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src/ ./src/
COPY --from=build /app/central/public ./central/public
USER node
EXPOSE 3000
CMD ["node", "src/start.js"]
