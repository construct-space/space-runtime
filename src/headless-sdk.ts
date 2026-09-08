// Headless Construct SDK host.
//
// On the desktop, `@construct-space/sdk`'s composables (useAuth, useOrg,
// useDelivery, …) are DECLARED stubs whose runtime impls the desktop injects
// from Pinia/Tauri. This module is the same surface for a NON-desktop host: it
// supplies those impls from an injected token (shared via globalThis so it
// works whether bundled in or not). `@construct-space/sdk` is aliased to this
// file when the runtime bundles a space's actions.
//
// Implemented for real: useGraph (re-exported, configured by the runtime),
// useAuth / useOrg (from the injected context). Everything a space *might*
// import is exported too — as working headless impls where it's safe, or
// explicit "not available headless" throwers — so the module always loads and
// read-style actions run; consequential host-only features fail loudly rather
// than silently doing nothing.
import { useGraph, useGraphList, configure, defineModel, field, access } from '@construct-space/graph'
export { useGraph, useGraphList, configure, defineModel, field, access }

export interface HeadlessContext {
  token: string
  user?: { id?: string; email?: string; name?: string } | null
  orgId?: string
  sourceUrl?: string // defaults to the gateway
}

function ctx(): HeadlessContext {
  return ((globalThis as any).__CONSTRUCT_HEADLESS as HeadlessContext) || { token: '' }
}

/** The runtime calls this before loading a space so the SDK impls have a token. */
export function setHeadlessContext(c: HeadlessContext): void {
  ;(globalThis as any).__CONSTRUCT_HEADLESS = c
}

const notHeadless = (what: string) => () => {
  throw new Error(`${what} is not available in the headless runtime`)
}

// ── Identity / org (real, from the injected token) ────────────────────────
export function useAuth() {
  const c = ctx()
  return {
    user: c.user ?? null,
    token: c.token,
    authenticated: !!c.token,
    isAuthenticated: !!c.token,
  }
}

export function useConstructAuth() {
  return useAuth()
}

export function useOrg() {
  const c = ctx()
  return { orgId: c.orgId ?? '', id: c.orgId ?? '', name: '', isOrg: !!c.orgId }
}

// Members/teams/departments: fetch from source-api with the token (the brain's
// org_members pattern). Read-only; safe headless.
async function sourceGet<T>(path: string): Promise<T> {
  const c = ctx()
  const base = (c.sourceUrl || 'https://my.lisaos.dev/api/source').replace(/\/$/, '')
  const res = await fetch(base + path, { headers: { Authorization: `Bearer ${c.token}` } })
  if (!res.ok) throw new Error(`source ${path}: HTTP ${res.status}`)
  return res.json() as Promise<T>
}

export function useOrgMembers() {
  return {
    members: [],
    loading: false,
    refresh: async () => {},
    find: async () => sourceGet<unknown[]>('/org/members').catch(() => []),
  }
}

// ── Delivery (email) — route through delivery via source if wired ─────────
export function useDelivery() {
  return {
    // Conservative: in the headless runtime we don't send mail unless a real
    // path is wired. Returns a clear no-op so read flows that merely import
    // this don't break, and senders see why.
    sendEmail: async () => ({ ok: false, skipped: 'headless: delivery not wired yet' }),
  }
}

// ── Host-only UI/runtime surfaces: not meaningful headless ────────────────
export const useNotification = () => ({ add: () => {}, list: [] })
export const useToast = () => ({ add: () => {}, success: () => {}, error: () => {} })
export const useToolbar = () => ({ registerItem: () => {}, clear: () => {} })
export const useBreadcrumb = () => ({ set: () => {}, clear: () => {} })
export const useSpaceShortcuts = () => {}
export const publishSpaceContext = () => {}
export const subscribeSpaceContext = () => () => {}
export const getLatestSpaceContext = () => undefined
export const registerContextHandler = () => () => {}
export const requestSpaceData = notHeadless('requestSpaceData')
export const useStorage = notHeadless('useStorage')
export const useLocalStorage = () => ({ get: () => null, set: () => {}, remove: () => {} })
