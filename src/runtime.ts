// space-runtime — load a space's actions and run them headless against Graph.
//
// This is the executor's action layer: no desktop, no webview. It configures
// the Graph SDK with an injected token (so org is resolved server-side from
// the token, exactly like the desktop), bundles the space's authored
// `actions.ts` (Vue/DOM-free) with Bun, and dispatches actions by name.
//
// The same module runs in two homes: next to the brain on the desktop (the
// preferred, local-first executor) and in the cloud fallback executor.
import { configure } from '@construct-space/graph'
import { setHeadlessContext } from './headless-sdk.ts'
import { mkdtempSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, isAbsolute } from 'node:path'
import { fetchAndVerifyActions } from './remote.ts'

// Build output goes UNDER the package root (not /tmp) so the bundle's external
// `@construct-space/graph` resolves to THIS package's node_modules — the same
// module instance the runtime configured. From /tmp it would resolve to a
// different copy and `configure()` wouldn't apply.
const PKG_ROOT = join(import.meta.dir, '..')

// Absolute path to the headless SDK host — aliased in for @construct-space/sdk
// when bundling a space's actions, so its useAuth/useOrg/useDelivery resolve
// to our headless impls instead of the (host-injected, desktop-only) package.
const HEADLESS_SDK = join(import.meta.dir, 'headless-sdk.ts')

export interface RuntimeConfig {
  graphUrl?: string // defaults to https://graph.lisaos.dev
  token: string // cat_ / cst_live_ / csk_live_ — Graph resolves the user+org from it
}

export interface SpaceAction {
  description?: string
  params?: Record<string, unknown>
  run: (p: any) => Promise<unknown>
}

export interface LoadedSpace {
  id: string
  actions: Record<string, SpaceAction>
}

// configureGraph wires the SDK so every useGraph() in the loaded space talks
// to the right endpoint as the right user. Call once per request/token.
export function configureGraph(spaceId: string, cfg: RuntimeConfig): void {
  configure({
    url: cfg.graphUrl || process.env.VITE_GRAPH_URL || 'https://graph.lisaos.dev',
    spaceId,
    getAccessToken: async () => cfg.token,
  })
  // Make the same token/context available to the headless SDK host (useAuth,
  // useOrg, …) — shared via globalThis so the bundled copy sees it too.
  setHeadlessContext({ token: cfg.token })
}

// loadSpaceActions bundles a space's actions entry (default: <dir>/src/actions.ts)
// with Bun, keeping @construct-space/* external so the loaded module shares the
// SAME (already-configured) Graph SDK instance as this runtime. Returns the
// space's action map. Works from source today; in production it loads the
// CLI-emitted logic bundle the same way.
export async function loadSpaceActions(spaceDir: string, actionsEntry = 'src/actions.ts'): Promise<Record<string, SpaceAction>> {
  const entry = isAbsolute(actionsEntry) ? actionsEntry : join(spaceDir, actionsEntry)
  const out = mkdtempSync(join(PKG_ROOT, '.runtime-cache-'))
  const built = await Bun.build({
    entrypoints: [entry],
    outdir: out,
    target: 'bun',
    format: 'esm',
    // Graph stays external → the loaded actions share THIS runtime's
    // already-configured Graph singleton.
    external: ['@construct-space/graph'],
    // @construct-space/sdk is host-injected on desktop; alias it to our
    // headless host so useAuth/useOrg/useDelivery resolve to real impls.
    plugins: [
      {
        name: 'alias-construct-sdk',
        setup(b) {
          b.onResolve({ filter: /^@construct-space\/sdk$/ }, () => ({ path: HEADLESS_SDK }))
        },
      },
    ],
  })
  if (!built.success) {
    throw new Error('space build failed: ' + built.logs.map(l => String(l)).join('; '))
  }
  const outfile = built.outputs.find(o => o.path.endsWith('.js'))?.path
  if (!outfile) throw new Error('space build produced no js output')
  const mod = await import(outfile)
  const actions = (mod.actions ?? mod.default?.actions) as Record<string, SpaceAction> | undefined
  if (!actions || typeof actions !== 'object') {
    throw new Error('space actions module did not export `actions`')
  }
  return actions
}

// resolveSpaceDir maps a space id to its source/bundle dir. Dev spaces live at
// $SPACES_DIR/space-<id> (default ~/Spaces/space-<id>). Installed spaces will
// resolve to their on-disk bundle once the CLI emits a logic bundle.
export function resolveSpaceDir(spaceId: string): string {
  const base = process.env.SPACES_DIR || join(homedir(), 'Spaces')
  const dir = join(base, `space-${spaceId}`)
  if (!existsSync(dir)) throw new Error(`space "${spaceId}" not found at ${dir}`)
  return dir
}

// runActionSandboxed runs an ALREADY-VERIFIED actions bundle in an isolated
// child process (worker.ts) with a SCRUBBED environment + hard timeout. This is
// the cloud execution boundary for third-party code: the action cannot read the
// runner's secrets (only PATH is inherited; token/graphUrl go via stdin) and a
// runaway/OOM/timeout run is killed without harming the runner. See worker.ts
// for what this does and does NOT cover (network egress = deploy-time).
async function runActionSandboxed(job: {
  actionsPath: string
  spaceId: string
  action: string
  params: Record<string, unknown>
  token: string
  graphUrl?: string
}): Promise<unknown> {
  const worker = join(import.meta.dir, 'worker.ts')
  const timeoutMs = Number(process.env.SPACE_RUN_TIMEOUT_MS || 120_000)
  const proc = Bun.spawn(['bun', worker], {
    // Scrubbed env — NO inherited secrets. PATH so `bun` resolves; nothing else.
    env: { PATH: process.env.PATH || '' },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  proc.stdin.write(JSON.stringify(job))
  proc.stdin.end()

  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    proc.kill()
  }, timeoutMs)

  const out = await new Response(proc.stdout).text()
  await proc.exited
  clearTimeout(timer)

  if (timedOut) {
    throw new Error(`action timed out after ${timeoutMs}ms (sandbox killed)`)
  }
  let parsed: { ok: boolean; result?: unknown; error?: string }
  try {
    parsed = JSON.parse(out)
  } catch {
    throw new Error('sandbox produced no result (crashed or killed)')
  }
  if (!parsed.ok) throw new Error(parsed.error || 'action failed')
  return parsed.result
}

// runAction resolves a space's actions and runs one by name. Resolution order:
//   1. remote {name,version} (cloud)   → fetch + VERIFY SIGNATURE + SANDBOXED run
//   2. explicit spaceDir (dev / local) → bundle from source, in-process
//   3. local dev dir ~/Spaces/space-<id> → bundle from source, in-process
// The remote path is the cloud runner's: it never executes unverified code, and
// the verified code runs in an isolated child (runActionSandboxed). The dev/
// local paths are the developer's own code on their own machine — in-process.
export async function runAction(
  spaceId: string,
  action: string,
  params: Record<string, unknown>,
  cfg: RuntimeConfig,
  spaceDir?: string,
  remote?: { name: string; version: string },
): Promise<unknown> {
  if (remote) {
    // Cloud: verify in the trusted parent, then run third-party code sandboxed.
    const verified = await fetchAndVerifyActions(remote.name, remote.version)
    return runActionSandboxed({
      actionsPath: verified.actionsPath,
      spaceId,
      action,
      params: params || {},
      token: cfg.token,
      graphUrl: cfg.graphUrl || process.env.VITE_GRAPH_URL,
    })
  }
  // Dev / local: developer's own code, in-process.
  configureGraph(spaceId, cfg)
  const dir = spaceDir || resolveSpaceDir(spaceId)
  const actions = await loadSpaceActions(dir)
  const a = actions[action]
  if (!a || typeof a.run !== 'function') {
    throw new Error(`unknown action "${action}" (have: ${Object.keys(actions).join(', ')})`)
  }
  return a.run(params || {})
}
