// Remote space loading for the cloud runner.
//
// The desktop runs a space's actions from local disk (~/Spaces/space-<id>).
// The cloud runner has no such disk — it fetches the published, SIGNED bundle
// from developer-api, VERIFIES the actions.js signature against the pinned
// marketplace key, then runs it. Verification happens BEFORE the bundle is ever
// imported: unverified third-party code never executes.
//
// The .space bundle (inside the downloaded tarball) carries:
//   manifest.json   — build.actionsSignature + build.signKeyId
//   actions.js      — the DOM-free actions bundle the CLI emits (Phase 2)
//
// Bundles are cached per {space,version} so a hot rule doesn't re-download.

import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { verifyActionsSignature, type BuildMeta } from './signature.ts'

// Where developer-api serves published bundles. Internal address in cloud.
function developerBase(): string {
  return (process.env.DEVELOPER_URL || 'https://developer.lisaos.dev').replace(/\/+$/, '')
}

function cacheRoot(): string {
  const root = process.env.SPACE_BUNDLE_CACHE || join(import.meta.dir, '..', '.bundle-cache')
  mkdirSync(root, { recursive: true })
  return root
}

export interface RemoteActions {
  /** Verified actions.js source text. */
  actionsJs: string
  /** Path to the verified actions.js on disk (importable). */
  actionsPath: string
  signKeyId?: string
}

// fetchAndVerifyActions downloads the published bundle for {name,version},
// extracts manifest.json + actions.js, verifies the signature, and returns the
// verified actions.js. Throws if the bundle is missing actions.js or fails
// verification — the caller must NOT run anything on error.
export async function fetchAndVerifyActions(name: string, version: string): Promise<RemoteActions> {
  const dir = join(cacheRoot(), `${name}@${version}`)
  const actionsPath = join(dir, 'actions.js')
  const manifestPath = join(dir, 'manifest.json')

  // Cache hit: re-verify from disk (cheap; never trust an unverified cache).
  if (existsSync(actionsPath) && existsSync(manifestPath)) {
    return verifyFromDisk(actionsPath, manifestPath)
  }

  mkdirSync(dir, { recursive: true })
  const url = `${developerBase()}/api/downloads/${encodeURIComponent(name)}/${encodeURIComponent(version)}/bundle.tar.gz`
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`fetch bundle ${name}@${version}: HTTP ${res.status}`)
  }
  const tarball = join(dir, 'bundle.tar.gz')
  writeFileSync(tarball, Buffer.from(await res.arrayBuffer()))

  // Extract with the system tar (present in the runner image). The .space dir
  // inside holds manifest.json + actions.js.
  const proc = Bun.spawnSync(['tar', '-xzf', tarball, '-C', dir])
  if (proc.exitCode !== 0) {
    throw new Error(`extract bundle ${name}@${version}: ${proc.stderr?.toString() || 'tar failed'}`)
  }

  const found = locateBundleFiles(dir)
  if (!found) {
    throw new Error(`bundle ${name}@${version} has no actions.js — space has no headless actions, or was published before Phase 2`)
  }
  // Normalize to the cache top so future cache hits are a fixed path.
  if (found.actionsPath !== actionsPath) writeFileSync(actionsPath, readFileSync(found.actionsPath))
  if (found.manifestPath !== manifestPath) writeFileSync(manifestPath, readFileSync(found.manifestPath))

  return verifyFromDisk(actionsPath, manifestPath)
}

async function verifyFromDisk(actionsPath: string, manifestPath: string): Promise<RemoteActions> {
  const actionsJs = readFileSync(actionsPath, 'utf8')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { build?: BuildMeta }
  const result = await verifyActionsSignature(actionsJs, manifest.build)
  if (!result.ok) {
    throw new Error(`actions bundle signature rejected: ${result.reason}`)
  }
  return { actionsJs, actionsPath, signKeyId: manifest.build?.signKeyId }
}

// locateBundleFiles finds manifest.json + actions.js inside the extracted tree.
// The tarball contains a single <id>.space directory; search one level down.
function locateBundleFiles(dir: string): { actionsPath: string; manifestPath: string } | null {
  const { readdirSync, statSync } = require('node:fs') as typeof import('node:fs')
  const candidates = [dir, ...readdirSync(dir).map(e => join(dir, e)).filter(p => safeIsDir(statSync, p))]
  for (const c of candidates) {
    const a = join(c, 'actions.js')
    const m = join(c, 'manifest.json')
    if (existsSync(a) && existsSync(m)) return { actionsPath: a, manifestPath: m }
  }
  return null
}

function safeIsDir(statSync: typeof import('node:fs').statSync, p: string): boolean {
  try { return statSync(p).isDirectory() } catch { return false }
}

// resolveLatestVersion asks developer-api for a space's current published
// version, so callers (the cloud /run + /space introspection) don't have to
// know it. The space-detail endpoint is public (no token).
export async function resolveLatestVersion(name: string): Promise<string> {
  const res = await fetch(`${developerBase()}/api/spaces/${encodeURIComponent(name)}`)
  if (!res.ok) throw new Error(`resolve version for "${name}": HTTP ${res.status}`)
  const body = (await res.json()) as { space?: { version?: string } }
  const v = body?.space?.version
  if (!v) throw new Error(`no published version for space "${name}"`)
  return v
}

// fetchBundleDir fetches + extracts the published bundle for {name,version}
// (cached) and returns the directory holding its .space contents — manifest.json
// + agent/ + skills. This is READ-ONLY introspection: it does NOT require
// actions.js and does NOT verify the signature, so it works for spaces that ship
// skills/persona but no headless actions. Execution (fetchAndVerifyActions) still
// verifies before running any code. Throws only if fetch/extract fails or no
// manifest is found.
export async function fetchBundleDir(name: string, version: string): Promise<string> {
  const root = join(cacheRoot(), `${name}@${version}`)
  const cached = findBundleSubdir(root)
  if (cached) return cached

  mkdirSync(root, { recursive: true })
  const url = `${developerBase()}/api/downloads/${encodeURIComponent(name)}/${encodeURIComponent(version)}/bundle.tar.gz`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`fetch bundle ${name}@${version}: HTTP ${res.status}`)
  const tarball = join(root, 'bundle.tar.gz')
  writeFileSync(tarball, Buffer.from(await res.arrayBuffer()))
  const proc = Bun.spawnSync(['tar', '-xzf', tarball, '-C', root])
  if (proc.exitCode !== 0) {
    throw new Error(`extract bundle ${name}@${version}: ${proc.stderr?.toString() || 'tar failed'}`)
  }
  const found = findBundleSubdir(root)
  if (!found) throw new Error(`bundle ${name}@${version} has no manifest.json`)
  return found
}

// findBundleSubdir locates the extracted bundle dir (the <id>.space dir carrying
// manifest.json), or the root if the layout is flat. null if not extracted yet.
function findBundleSubdir(root: string): string | null {
  const { readdirSync, statSync } = require('node:fs') as typeof import('node:fs')
  let entries: string[]
  try { entries = readdirSync(root) } catch { return null }
  for (const e of entries) {
    const p = join(root, e)
    try { if (statSync(p).isDirectory() && existsSync(join(p, 'manifest.json'))) return p } catch { /* skip */ }
  }
  if (existsSync(join(root, 'manifest.json'))) return root
  return null
}
