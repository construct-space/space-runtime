// space-runtime HTTP service — what the brain (capability router) and the
// cloud operator call to run a space action headless, and to introspect what a
// space offers.
//   POST /run          { spaceDir?, spaceId, action, params, token, name?, version? } -> { ok, result }
//   GET  /space/{name}[/{version}]  -> { ok, name, version, actions, skills, agent }
//   GET  /health
import { runAction } from './runtime.ts'
import { resolveLatestVersion } from './remote.ts'
import { inspectSpace } from './introspect.ts'

const port = Number(process.env.PORT || 60190)

// In the cloud there is no local ~/Spaces disk, so a /run without an explicit
// {name,version} resolves the latest published (signed) bundle. The desktop /
// dev runner keeps using spaceDir / ~/Spaces. SPACE_SIGNATURE_POLICY=require is
// the cloud deploy's signal.
const CLOUD = process.env.SPACE_SIGNATURE_POLICY === 'require'

Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url)

    if (req.method === 'GET' && url.pathname === '/health') {
      return Response.json({ ok: true, service: 'space-runtime' })
    }

    // GET /space/{name}[/{version}] — actions + skills + agent persona, read
    // from the verified bundle. Lets the operator act as the space's agent.
    if (req.method === 'GET' && url.pathname.startsWith('/space/')) {
      const parts = url.pathname.slice('/space/'.length).split('/').filter(Boolean)
      const name = parts[0] ? decodeURIComponent(parts[0]) : ''
      const version = parts[1] ? decodeURIComponent(parts[1]) : undefined
      if (!name) {
        return Response.json({ ok: false, error: 'space name required' }, { status: 400 })
      }
      try {
        const info = await inspectSpace(name, version)
        return Response.json({ ok: true, ...info })
      } catch (e) {
        return Response.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 })
      }
    }

    if (req.method === 'POST' && url.pathname === '/run') {
      let body: any
      try {
        body = await req.json()
      } catch {
        return Response.json({ ok: false, error: 'invalid json' }, { status: 400 })
      }
      const { spaceDir, spaceId, action, params, token, name, version } = body || {}
      if (!spaceId || !action || !token) {
        return Response.json({ ok: false, error: 'spaceId, action, token required' }, { status: 400 })
      }
      try {
        // Cloud callers pass {name, version} to pin a signed bundle; if they
        // don't, resolve the latest published version here so the operator
        // doesn't have to know it. Desktop/dev (spaceDir present) runs local.
        let remote = name && version ? { name, version } : undefined
        if (!remote && !spaceDir && CLOUD) {
          const n = name || spaceId
          remote = { name: n, version: await resolveLatestVersion(n) }
        }
        const result = await runAction(spaceId, action, params || {}, { token }, spaceDir, remote)
        return Response.json({ ok: true, result })
      } catch (e) {
        return Response.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 })
      }
    }

    return new Response('not found', { status: 404 })
  },
})

console.log(`[space-runtime] listening on :${port}  (POST /run, GET /space/{name}, GET /health)`)
