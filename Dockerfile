FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json server.js reset-password.js ./
COPY public ./public
EXPOSE 8080
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
