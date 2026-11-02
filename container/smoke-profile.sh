#!/bin/sh
set -eu
export HOME=/tmp
DSH_HOME="/tmp/dshhome-smoke-$$"
export DSH_HOME
mkdir -p "$DSH_HOME/profiles/test/node_modules"
ln -s /work/plugin "$DSH_HOME/profiles/test/node_modules/dsh-cmd-guard"
ln -s /opt/dsh/node_modules/@deepseek-ai "$DSH_HOME/profiles/test/node_modules/@deepseek-ai"
cat > "$DSH_HOME/profiles/test/package.json" <<'EOF'
{
  "name": "dsh-profile-test",
  "private": true,
  "dependencies": {
    "@deepseek-ai/dsh-base": "0.2.1-rc.3",
    "@deepseek-ai/dsh-web-app": "0.2.1-rc.3",
    "dsh-cmd-guard": "file:/work/plugin"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-cmd-guard"
      ]
    }
  }
}
EOF
cat > "$DSH_HOME/profiles/test/cordis.patch.yml" <<'EOF'
[]
EOF
node /opt/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js --profile test --dump-config
