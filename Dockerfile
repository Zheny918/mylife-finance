# syntax=docker/dockerfile:1
#
# Finance MCP Server — 容器镜像
# 给 Octop（Docker 部署）用的 streamable HTTP MCP 服务。
#
# 构建：docker build -t mylife-finance-mcp:1.2.3 .
# 运行：见 docker-compose.mylife-finance.yml
# 一条命令构建 + 全量验收：node scripts/docker-build-verify.mjs
#
# 说明：node:sqlite 是 Node 内置模块，无需任何 npm 依赖，镜像里没有 npm install 步骤。

FROM node:22-alpine

WORKDIR /app

# 版本门槛校验（node:sqlite 在 22.13+ 无需 --experimental-sqlite）
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

COPY package.json ./
COPY server-http.js server.js ./
COPY src ./src

ENV NODE_ENV=production \
    MYLF_DATA_DIR=/data \
    MYLF_HTTP_PORT=3458 \
    MYLF_HTTP_HOST=0.0.0.0

RUN mkdir -p /data
VOLUME ["/data"]
EXPOSE 3458

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.MYLF_HTTP_PORT||3458)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "--no-warnings", "server-http.js"]
