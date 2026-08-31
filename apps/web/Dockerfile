FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY tsconfig.base.json ./
COPY apps/web/package.json apps/web/package.json
COPY packages/permissions/package.json packages/permissions/package.json
COPY packages/shared/package.json packages/shared/package.json
# `npm ci` installs exactly the locked tree, so an image built today and one
# built in six months contain the same dependency versions.
RUN npm ci
COPY apps/web apps/web
COPY packages/permissions packages/permissions
COPY packages/shared packages/shared
RUN npm run build -w @commonwax/permissions && npm run build -w @commonwax/shared && npm run build -w @commonwax/web

FROM nginx:1.27-alpine
RUN apk add --no-cache wget
COPY infrastructure/security-headers.conf /etc/nginx/security-headers.conf
COPY infrastructure/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost/ >/dev/null || exit 1
