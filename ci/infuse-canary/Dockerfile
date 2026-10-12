FROM node@sha256:51b1100cc2a83d370c6a60952e3f2989c8a43159d0e38586e090f3b3326efefd

# Only trusted public tooling enters this image. No candidate source is in its context.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      bash ca-certificates curl git ripgrep python3 procps build-essential pkg-config \
      cmake ninja-build libpam0g-dev \
    && rm -rf /var/lib/apt/lists/*
COPY install-pnpm.py /opt/install-pnpm.py
RUN python3 -I /opt/install-pnpm.py \
    && test "$(node --version)" = "v24.21.0" \
    && test "$(pnpm --version)" = "12.5.1" \
    && groupadd --gid 501 fixture \
    && useradd --uid 501 --gid 501 --no-create-home --home-dir /work/home fixture
COPY binding.json identity.py probe.py run-container.sh /harness/
RUN chmod -R a-w /harness /opt/pnpm
USER 501:501
WORKDIR /work
ENTRYPOINT ["/usr/bin/env", "-i", "PATH=/usr/local/bin:/usr/bin:/bin", "HOME=/work/home", "USER=fixture", "LOGNAME=fixture", "/bin/bash", "/harness/run-container.sh"]
