# Multi-stage build: Vite frontend, then cargo release, then a minimal
# runtime image. The final image is ~25 MB (alpine + one static binary +
# dist assets) and contains no toolchain.

FROM node:26-alpine3.24 AS frontend
WORKDIR /fe
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

FROM rust:1-alpine3.24 AS backend
WORKDIR /b
# ring (via rustls) needs a C toolchain on musl.
RUN apk add --no-cache musl-dev
COPY Cargo.toml Cargo.lock ./
# Build dependencies first for layer caching; the dummy main is replaced below.
RUN mkdir src && echo 'fn main() {}' > src/main.rs && cargo build --release && rm -rf src
COPY src ./src
RUN touch src/main.rs && cargo build --release

FROM alpine:3.24
RUN adduser -D -u 10001 app
WORKDIR /app
COPY --from=backend /b/target/release/weather-ui /app/weather-ui
COPY --from=frontend /fe/dist /app/dist

# rustls uses webpki-roots, so no system CA bundle is needed at runtime.
ENV HOST=0.0.0.0 \
    PORT=8087 \
    WEATHER_UI_STATIC_DIR=/app/dist
EXPOSE 8087
USER 10001
HEALTHCHECK --interval=60s --timeout=5s --start-period=10s \
    CMD wget -q -O /dev/null http://127.0.0.1:8087/api/health || exit 1
ENTRYPOINT ["/app/weather-ui"]
