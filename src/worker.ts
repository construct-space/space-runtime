// worker.ts — sandboxed action executor.
//
// Runs as a CHILD process spawned by runtime.ts (runActionSandboxed) with a
// SCRUBBED environment and a hard timeout. It receives one job on stdin, runs
// exactly one ALREADY-VERIFIED action, writes the JSON result to stdout, and
// exits. Process isolation is the security boundary for third-party space code:
//
//   - Scrubbed env: the parent passes only PATH, so a malicious action cannot
//     read the runner's secrets (INTERNAL_SHARED_SECRET, etc.) from process.env.
//     The user token + Graph URL arrive on STDIN, never as env vars.
//   - Hard timeout + OOM: the parent kills this process on timeout; a runaway
//     or memory-bomb action dies with it instead of taking down the runner.
//   - One action per process: no state bleeds between runs/users.
//
// NOT covered here (must be enforced at deploy, see ADR §5): network EGRESS
// restriction. A child process can still open arbitrary outbound sockets — only
// a container netns / network policy limiting it to Graph closes that. This
// worker is the in-code half; the deploy is the other half.
import { configure } from '@construct-space/graph'
import { setHeadlessContext } from './headless-sdk.ts'

interface Job {
  actionsPath: string // path to the verified actions.js (parent verified it)
  spaceId: string
  action: string
  params: Record<string, unknown>
  token: string
  graphUrl?: string
}

function emit(v: unknown): void {
  // Single JSON line on stdout — the parent reads exactly this.
  process.stdout.write(JSON.stringify(v))
}

const raw = await Bun.stdin.text()
let job: Job
try {
  job = JSON.parse(raw) as Job
} catch {
  emit({ ok: false, error: 'worker: invalid job' })
  process.exit(1)
}

configure({
  url: job.graphUrl || 'https://graph.lisaos.dev',
  spaceId: job.spaceId,
  getAccessToken: async () => job.token,
})
setHeadlessContext({ token: job.token })

try {
  const mod = await import(job.actionsPath)
  const actions = (mod.actions ?? mod.default?.actions) as Record<string, { run?: (p: unknown) => Promise<unknown> }> | undefined
  const a = actions?.[job.action]
  if (!a || typeof a.run !== 'function') {
    throw new Error(`unknown action "${job.action}" (have: ${actions ? Object.keys(actions).join(', ') : 'none'})`)
  }
  const result = await a.run(job.params || {})
  emit({ ok: true, result })
  process.exit(0)
} catch (e) {
  emit({ ok: false, error: e instanceof Error ? e.message : String(e) })
  process.exit(1)
}
