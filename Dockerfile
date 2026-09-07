FROM oven/bun AS deps

WORKDIR /app

# Cache packages installation
COPY package.json package.json
COPY bun.lock bun.lock

RUN bun install --frozen-lockfile

FROM oven/bun AS runtime

WORKDIR /app

# sharp is a native module: its .node addon and bundled libvips cannot be
# embedded by `bun build --compile`, which resolves native addons against the
# executable's own virtual root rather than the filesystem. The server
# therefore runs from source with node_modules present, instead of shipping a
# single compiled binary on distroless.
COPY --from=deps /app/node_modules ./node_modules

COPY tsconfig.json tsconfig.json
COPY ./src ./src

ENV NODE_ENV=production

CMD ["bun", "run", "src/index.ts"]

EXPOSE 3000
