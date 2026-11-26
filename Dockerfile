FROM oven/bun:1-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV ROCKSOUL_MCP_HOST=0.0.0.0
ENV ROCKSOUL_MCP_PORT=4530

COPY package.json tsconfig.json ./
COPY scripts ./scripts
COPY src ./src

RUN addgroup -S rocksoul && adduser -S rocksoul -G rocksoul \
  && chown -R rocksoul:rocksoul /app

USER rocksoul
EXPOSE 4530

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:' + (process.env.ROCKSOUL_MCP_PORT || '4530') + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["bun", "run", "src/server.ts"]
