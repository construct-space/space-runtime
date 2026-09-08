# space-runtime

Headless executor for Construct space actions. Runs a space's `actions.ts`
against Graph with **no desktop and no webview** — used both on the desktop
(next to the brain) and as the cloud fallback executor.

This is its own repo (`construct-space/space-runtime`). It lived in
`construct-app/` during the 1.2.x execution-mesh scaffold and was moved out on
2026-05-31 (the desktop never ran it; construct-app shipped v1.2.6 without it).

## Why

A space's actions normally run in the desktop webview. To run them when the
app is closed (scheduled automations) or on a server (cloud fallback), this
service executes the space's `actions.ts` against the Graph SDK with a
per-request token — same code, no DOM.

## Two execution paths

`runAction()` (src/runtime.ts) resolves actions three ways:

1. **remote `{name, version}` (cloud)** — fetch the published, **signed** bundle
   from developer-api, **verify the signature**, then run it in a **sandboxed
   child**. Third-party code never runs unverified or in-process.
2. **explicit `spaceDir` (dev/local)** — bundle from source, in-process.
3. **local `~/Spaces/space-<id>`** — bundle from source, in-process.

### Cloud security model (the remote path)

- **Fetch** (`src/remote.ts`) — downloads `bundle.tar.gz` for `{name,version}`
  from `DEVELOPER_URL`, extracts `manifest.json` + `actions.js`, caches per
  version under `SPACE_BUNDLE_CACHE`.
- **Verify** (`src/signature.ts`) — checks `manifest.build.actionsSignature`
  against the pinned marketplace public key (ECDSA P-256 / SHA-256, raw r||s,
  signed over the actions.js UTF-8 text — identical key + scheme to the
  desktop's `frontend/space_loader/signature.ts`). Default policy `require`
  (rejects unsigned/invalid); `SPACE_SIGNATURE_POLICY=warn|off` for dev.
- **Sandbox** (`src/worker.ts`) — verified actions run in an isolated child
  process with a **scrubbed env** (only PATH; token + graphUrl arrive on stdin,
  so the action can't read service secrets) and a **hard timeout**
  (`SPACE_RUN_TIMEOUT_MS`, default 120s). One action per process.

**Deploy-time gates NOT enforceable in code (required for untrusted/personal
spaces):** restrict network egress to Graph (+ developer-api) via a container
network policy; mem/cpu limits; deploy **internal-only** (no public route). The
Dockerfile covers non-root + `require` policy + cache dir.

## API

`POST /run`
```json
{ "spaceId": "notes", "action": "createNote", "params": { },
  "token": "cat_...",
  "name": "notes", "version": "1.2.0" }
```
`name` + `version` (optional) select the cloud fetch+verify+sandbox path; omit
them (with `spaceDir`, or for a local `~/Spaces` space) to bundle from source.

`GET /health`

## Run

```bash
bun src/server.ts        # listens on :60190 (PORT overridable)
```

## Env

| Var | Purpose | Default |
|---|---|---|
| `PORT` | HTTP port | `60190` |
| `VITE_GRAPH_URL` | Graph endpoint | `https://graph.lisaos.dev` |
| `DEVELOPER_URL` | where to fetch published bundles | `https://developer.lisaos.dev` |
| `SPACE_SIGNATURE_POLICY` | `require` \| `warn` \| `off` | `require` |
| `SPACE_RUN_TIMEOUT_MS` | sandbox hard timeout | `120000` |
| `SPACE_BUNDLE_CACHE` | verified-bundle cache dir | `.bundle-cache` (`/cache` in Docker) |
| `SPACES_DIR` | local dev spaces root | `~/Spaces` |

## Related

- Design + phased plan: `construct-app/docs/2026-05-30-cloud-automations-and-operator.md`
  (on the `execution-mesh-operator` branch).
- The publish-side signing lives in `developer-api` (`internal/builder/sign.go`,
  `build.actionsSignature`) + the CLI emits `dist/actions.js`
  (`construct-cli/src/lib/actionsBundle.ts`).
