FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/permissions/package.json packages/permissions/package.json
COPY packages/shared/package.json packages/shared/package.json
# `npm ci` installs exactly the locked tree, so an image built today and one
# built in six months contain the same dependency versions.
RUN npm ci
COPY apps/api apps/api
COPY packages packages
RUN npm run build -w @commonwax/permissions && npm run build -w @commonwax/shared && npm run build -w @commonwax/db && npm run build -w @commonwax/api

FROM node:22-alpine
RUN apk add --no-cache wget
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/db/node_modules ./packages/db/node_modules
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/package.json ./apps/api/package.json
COPY --from=build /app/packages/db/dist ./packages/db/dist
COPY --from=build /app/packages/db/package.json ./packages/db/package.json
COPY --from=build /app/packages/db/prisma ./packages/db/prisma
COPY --from=build /app/packages/permissions/dist ./packages/permissions/dist
COPY --from=build /app/packages/permissions/package.json ./packages/permissions/package.json
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json

# The API accepts file uploads, so it must not run as root. Creating the mount
# points here covers /staging, which only this image mounts and so is
# initialised with this ownership. /music is shared with Navidrome and cannot
# be settled here — see the `music-permissions` service in docker-compose.yml.
RUN mkdir -p /music /staging && chown -R node:node /music /staging /app
USER node

CMD ["sh", "-c", "./packages/db/node_modules/.bin/prisma migrate deploy --schema packages/db/prisma/schema.prisma && node apps/api/dist/server.js"]
