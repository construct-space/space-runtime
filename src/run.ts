// CLI harness: run one space action headless.
//   bun src/run.ts <spaceDir> <spaceId> <action> '<jsonParams>'
// Token comes from POC_PROFILE's auth.json (dev), or RUNTIME_TOKEN env.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { runAction } from './runtime.ts'

function devToken(): string {
  if (process.env.RUNTIME_TOKEN) return process.env.RUNTIME_TOKEN
  const profile = process.env.POC_PROFILE || '1c932cb7-fa41-4ea9-bf46-54a2033c50b9'
  const p = join(homedir(), 'Library', 'Application Support', 'Construct', 'profiles', profile, 'auth.json')
  return JSON.parse(readFileSync(p, 'utf8')).token
}

const [spaceId, action, paramsJson, spaceDir] = process.argv.slice(2)
if (!spaceId || !action) {
  console.error("usage: bun src/run.ts <spaceId> <action> '<jsonParams>' [spaceDir]")
  process.exit(1)
}

const params = paramsJson ? JSON.parse(paramsJson) : {}
console.log(`[runtime] running ${spaceId}.${action} headless (no desktop)…`)
try {
  const result = await runAction(spaceId, action, params, { token: devToken() }, spaceDir)
  console.log('[runtime] ✅ result:')
  console.log(JSON.stringify(result, null, 2).slice(0, 2000))
} catch (e) {
  console.log('[runtime] ❌', e instanceof Error ? `${e.name}: ${e.message}` : String(e))
  process.exit(1)
}
