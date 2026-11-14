FROM oven/bun:1-alpine
RUN apk add --no-cache util-linux curl openssl
WORKDIR /app
COPY package.json ./
RUN bun install --production
COPY src ./src
COPY public ./public
ENV PORT=3100
EXPOSE 3100
CMD ["bun", "run", "src/server.ts"]
