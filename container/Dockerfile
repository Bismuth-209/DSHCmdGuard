FROM node:24-slim

ARG DSH_VERSION=0.2.1-rc.3

ENV NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false

# DSH CLI is installed only to prove the test container is a real DSH
# environment. The unit/integration tests below do not need model credentials
# and never execute destructive host commands.
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssh-client ca-certificates \
    && mkdir -p /opt/dsh \
    && npm install --prefix /opt/dsh --no-audit --no-fund "@deepseek-ai/dsh@${DSH_VERSION}"

WORKDIR /work/plugin
COPY . /work/plugin/
COPY container/smoke-profile.sh /work/smoke-profile.sh

CMD ["npm", "test"]
