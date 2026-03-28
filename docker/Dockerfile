FROM rust:1.90-bookworm@sha256:3914072ca0c3b8aad871db9169a651ccfce30cf58303e5d6f2db16d1d8a7e58f

ENV DEBIAN_FRONTEND=noninteractive
ENV RUSTFLAGS=-Awarnings

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    git \
    nodejs \
    npm \
    python3 \
    make \
    g++ \
    pkg-config \
    libssl-dev \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/sherpa-rescue

COPY . .

RUN npm install \
  && cargo build --release --manifest-path phase2-bn254/phase2/Cargo.toml

RUN chmod +x /opt/sherpa-rescue/docker/docker-entrypoint.sh

ENTRYPOINT ["/opt/sherpa-rescue/docker/docker-entrypoint.sh"]
CMD []
