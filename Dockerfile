FROM node:24-bookworm-slim

WORKDIR /app

COPY package.json ./
COPY index.html login.html teacher.html student.html 404.html ./
COPY assets ./assets
COPY server ./server
COPY data ./data

RUN mkdir -p /app/data/runtime && chown -R node:node /app/data/runtime

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8080

USER node
EXPOSE 8080

HEALTHCHECK --interval=20s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "server/local-api.mjs"]
