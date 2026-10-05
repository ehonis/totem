# Totem in a container: the bridge, the built dashboard, and (by default) the
# Claude Code and Codex CLIs it uses for AI. Data, OAuth tokens and the CLIs'
# own logins live in volumes; see docker-compose.yml.
FROM node:22-bookworm-slim

# Agent CLIs to bake in. Set to "" to build without any (then add one by
# extending the image), or add "opencode-ai" for OpenCode.
ARG AGENT_CLIS="@anthropic-ai/claude-code @openai/codex"
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git \
  && rm -rf /var/lib/apt/lists/* \
  && if [ -n "$AGENT_CLIS" ]; then npm install -g $AGENT_CLIS && npm cache clean --force; fi

WORKDIR /app
COPY package.json package-lock.json ./
COPY web/package.json web/package-lock.json ./web/
# node-pty (the optional web terminal) needs a compiler toolchain; it is left out
# here and the terminal stays off. ffmpeg-static fetches its binary in a script.
RUN npm ci --omit=optional --ignore-scripts --no-audit --no-fund \
  && (npm rebuild ffmpeg-static || true) \
  && npm --prefix web ci --no-audit --no-fund

COPY . .
RUN npm --prefix web run build && rm -rf web/node_modules \
  && mkdir -p data secrets && chown -R node:node /app

ENV NODE_ENV=production BRIDGE_PORT=8787
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://localhost:'+(process.env.BRIDGE_PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "bridge.mjs"]
