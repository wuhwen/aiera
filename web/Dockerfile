ARG NODE_IMAGE=m.daocloud.io/docker.io/library/node:22-alpine
ARG NPM_REGISTRY=https://registry.npmmirror.com
FROM ${NODE_IMAGE} AS deps
ARG NPM_REGISTRY
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm config set registry "${NPM_REGISTRY}" \
    && npm install --fetch-retries=3 --fetch-timeout=120000

FROM ${NODE_IMAGE} AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ARG NEXT_PUBLIC_API_URL=/api
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_API_KEY=
ENV NEXT_PUBLIC_API_KEY=$NEXT_PUBLIC_API_KEY
RUN npm run build

FROM ${NODE_IMAGE} AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
EXPOSE 3000
CMD ["node", "server.js"]
