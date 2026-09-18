FROM node:24-bookworm-slim

WORKDIR /app

COPY package.json ./
COPY index.html login.html teacher.html student.html 404.html ./
COPY assets ./assets
COPY server ./server
COPY data ./data

RUN mkdir -p /app/data/runtime /var/data && chown -R node:node /app/data/runtime /var/data

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8080
ENV ZHIXUE_DATA_DIR=/var/data
ENV ZHIXUE_COOKIE_SECURE=1
ENV ZHIXUE_TRUST_PROXY=1
ENV ZHIXUE_SANDBOX_TTL_HOURS=24
ENV ZHIXUE_STORAGE_BACKEND=persistent-filesystem

USER node
EXPOSE 8080

HEALTHCHECK --interval=20s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "server/local-api.mjs"]
