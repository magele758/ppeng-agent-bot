# Trusted execution image preparation, outside project code and dependency scripts.
# Pin the selected base and use the resulting local sha256 image ID in Lab.
ARG NODE_BASE=docker.m.daocloud.io/library/node@sha256:9f6d5975c7dca860947d3915877f85607946403fc55349f39b4bc3688448bb6e
FROM ${NODE_BASE}
RUN apt-get update && apt-get install -y --no-install-recommends git python3 ca-certificates \
    && rm -rf /var/lib/apt/lists/*
USER 1000:1000
