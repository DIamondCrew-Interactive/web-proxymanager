# Experimental SSO overlay. Does not alter the approved reskin Dockerfile.
FROM node:24.14.0-bookworm@sha256:5a593d74b632d1c6f816457477b6819760e13624455d587eef0fa418c8d0777b AS context-check
WORKDIR /work
COPY upstream.lock.json ./
COPY scripts/prepare.mjs scripts/prepare.mjs
COPY branding branding
COPY sso/prepare.mjs sso/SSOLogin.tsx sso/core.mjs sso/router.mjs sso/routes.mjs sso/links.mjs sso/cli.mjs sso/upstream-guards.json sso/dci-proxymanager /work/sso/
RUN node --check /work/sso/prepare.mjs && node --check /work/sso/routes.mjs

FROM context-check AS frontend
RUN node scripts/prepare.mjs && node sso/prepare.mjs frontend /work/.build/frontend
WORKDIR /work/.build/frontend
RUN yarn install --frozen-lockfile --non-interactive && yarn locale-compile && yarn build
FROM jc21/nginx-proxy-manager:2.15.1@sha256:52b2c59994f3d36acfcf70a1626f29734df0ed8c71bacc0269f78b6f939858bb
RUN node -e "if(require('/app/package.json').version !== '2.15.1') process.exit(1)"
COPY --from=frontend /work/.build/frontend/dist/ /app/frontend/
COPY --from=frontend /work/.build/LICENSE.upstream /usr/share/licenses/diamondcrew-proxy-manager/LICENSE.upstream
COPY sso/core.mjs sso/router.mjs sso/routes.mjs sso/links.mjs sso/cli.mjs sso/prepare.mjs sso/upstream-guards.json /app/dci-sso/
COPY sso/dci-proxymanager /usr/local/bin/dci-proxymanager
RUN node /app/dci-sso/prepare.mjs backend /app && chmod 755 /usr/local/bin/dci-proxymanager
LABEL net.diamondcrew.upstream.version="2.15.1" net.diamondcrew.sso="experimental-local"
