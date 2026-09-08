# space-runtime — headless executor for space actions.
# Runs next to the brain on the desktop, and in the cloud fallback executor.
#
# SECURITY (cloud): this process executes third-party space code in a sandboxed
# child (src/worker.ts — scrubbed env + hard timeout). The container is the
# OTHER half of the boundary and is hardened here:
#   - runs as a NON-ROOT user
#   - writable only where it must be (bundle cache + per-run temp)
# STILL REQUIRED at the orchestrator (not expressible in this Dockerfile):
#   - NETWORK EGRESS limited to Graph (+ developer-api) via netns/network policy
#     — the child can otherwise open arbitrary sockets (exfiltration risk)
#   - memory/CPU limits; deploy INTERNAL-ONLY (no public route)
# See construct-app/docs/2026-05-30-cloud-automations-and-operator.md §5.
FROM oven/bun:1
WORKDIR /app

# Deps first (cached) — frozen to the committed lockfile.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY src ./src

# Verified-bundle cache lives here; keep it off the (ideally read-only) rootfs
# and writable by the non-root user.
ENV SPACE_BUNDLE_CACHE=/cache
RUN mkdir -p /cache && chown -R bun:bun /app /cache

ENV PORT=60190
ENV SPACES_DIR=/spaces
# Graph endpoint (token is supplied per-request, org resolved server-side).
ENV VITE_GRAPH_URL=https://graph.lisaos.dev
# Cloud default: reject unsigned/invalid action bundles (third-party code).
ENV SPACE_SIGNATURE_POLICY=require

# Drop root — the runner and the sandboxed child both run unprivileged.
USER bun

EXPOSE 60190
CMD ["bun", "src/server.ts"]
