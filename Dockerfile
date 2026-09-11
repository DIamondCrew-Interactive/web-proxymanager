# Only the rebuilt static frontend crosses into the exact production base.
FROM node:24.14.0-bookworm@sha256:5a593d74b632d1c6f816457477b6819760e13624455d587eef0fa418c8d0777b AS frontend
WORKDIR /work
COPY upstream.lock.json ./
COPY scripts/prepare.mjs scripts/prepare.mjs
COPY branding branding
RUN node scripts/prepare.mjs
WORKDIR /work/.build/frontend
RUN yarn --version | grep -x '1.22.22' \
    && yarn install --frozen-lockfile --non-interactive \
    && yarn locale-compile \
    && yarn build

FROM jc21/nginx-proxy-manager:2.15.1@sha256:52b2c59994f3d36acfcf70a1626f29734df0ed8c71bacc0269f78b6f939858bb
RUN node -e "if(require('/app/package.json').version !== '2.15.1') process.exit(1)"
COPY --from=frontend /work/.build/frontend/dist/ /app/frontend/
COPY --from=frontend /work/.build/LICENSE.upstream /usr/share/licenses/diamondcrew-proxy-manager/LICENSE.upstream
LABEL org.opencontainers.image.title="DiamondCrew Interactive Proxy Manager" \
      org.opencontainers.image.version="2.15.1-dci.1.0.0" \
      org.opencontainers.image.source="https://github.com/DIamondCrew-Interactive/web-proxymanager" \
      net.diamondcrew.upstream.version="2.15.1"
