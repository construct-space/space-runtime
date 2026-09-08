// Space introspection for the cloud operator.
//
// The operator is a light agent harness: to act as a space's agent it needs to
// see what the space offers — its actions, its skills, and its persona. All of
// that already ships inside the signed bundle space-runtime fetches + verifies
// for /run; this just reads those files back out (no execution, signature still
// enforced before we trust the bundle).
//
// Returns, for a published space:
//   actions  — { id: { description, params } }   (manifest.actions, build-inlined)
//   skills   — [{ id, name, description, body }]  (SKILL.md + agent/skills/*.md)
//   agent    — the agent/config.md persona (markdown), or ''
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { resolveLatestVersion, fetchBundleDir } from './remote.ts'

export interface SpaceSkill {
  id: string
  name?: string
  description?: string
  body: string
}

export interface SpaceInfo {
  name: string
  version: string
  description?: string
  actions: Record<string, { description?: string; params?: unknown }>
  skills: SpaceSkill[]
  agent: string
}

// inspectSpace resolves the latest version (if not given), ensures the signed
// bundle is fetched + verified, then reads its manifest/actions, agent persona,
// and skills off disk.
export async function inspectSpace(name: string, version?: string): Promise<SpaceInfo> {
  const v = version || (await resolveLatestVersion(name))
  const dir = await fetchBundleDir(name, v)

  let manifest: any = {}
  const manifestPath = join(dir, 'manifest.json')
  if (existsSync(manifestPath)) {
    try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) } catch { /* tolerate */ }
  }

  // actions is build-inlined as an object; if it's still a path string it
  // wasn't inlined (older bundle) — return empty rather than a useless string.
  const actions = manifest.actions && typeof manifest.actions === 'object' ? manifest.actions : {}

  const agent = readIfExists(join(dir, 'agent', 'config.md'))

  const skills: SpaceSkill[] = []
  const rootSkill = join(dir, 'SKILL.md')
  if (existsSync(rootSkill)) skills.push(parseSkill('SKILL', readFileSync(rootSkill, 'utf8')))
  const skillsDir = join(dir, 'agent', 'skills')
  if (existsSync(skillsDir)) {
    for (const f of readdirSync(skillsDir)) {
      // Skip dotfiles + macOS AppleDouble (._foo) junk that leaks into bundles.
      if (f.startsWith('.') || !f.endsWith('.md')) continue
      skills.push(parseSkill(f.replace(/\.md$/, ''), readFileSync(join(skillsDir, f), 'utf8')))
    }
  }

  return {
    name,
    version: v,
    description: typeof manifest.description === 'string' ? manifest.description : undefined,
    actions,
    skills,
    agent,
  }
}

function readIfExists(p: string): string {
  return existsSync(p) ? readFileSync(p, 'utf8') : ''
}

// parseSkill pulls the YAML-ish frontmatter (id/name/description) and body out
// of a skill markdown file. A tiny parser — skills only use simple scalar
// frontmatter, so we don't pull in a YAML dependency.
function parseSkill(fallbackId: string, raw: string): SpaceSkill {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!m) return { id: fallbackId, body: raw.trim() }
  const fm: Record<string, string> = {}
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/)
    if (kv) fm[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '')
  }
  return {
    id: fm.id || fallbackId,
    name: fm.name,
    description: fm.description,
    body: m[2].trim(),
  }
}
