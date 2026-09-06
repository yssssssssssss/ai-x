ARG BASE_IMAGE=node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5
FROM ${BASE_IMAGE}

USER root
RUN apt-get update \
  && apt-get install --yes --no-install-recommends bash python3 \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --uid 65532 --no-create-home --shell /usr/sbin/nologin skillrunner

USER 65532:65532
WORKDIR /skill
