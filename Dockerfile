ARG NODE_VERSION=stable

FROM gcr.io/connectedcars-staging/node-builder.master:$NODE_VERSION as builder

ARG NPM_TOKEN
ARG COMMIT_SHA=master

WORKDIR /app

USER builder

# Copy application code.
COPY --chown=builder:builder . /app

RUN npm i

RUN npm run build

RUN npm run ci-auto
