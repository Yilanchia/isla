# 多阶段构建：workspace 依赖必须整仓安装，所以先装再裁。
FROM node:24-slim AS build
RUN corepack enable
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps

RUN pnpm install --no-frozen-lockfile --filter @isla/qq-service... --filter @isla/personas...
RUN pnpm --filter @isla/core build \
 && pnpm --filter @isla/providers build \
 && pnpm --filter @isla/store-sqlite build \
 && pnpm --filter @isla/personas build \
 && pnpm --filter @isla/qq-service build

FROM node:24-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/pnpm-workspace.yaml ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps ./apps
WORKDIR /app/apps/qq-service
EXPOSE 8790
CMD ["node", "dist/server.js"]
