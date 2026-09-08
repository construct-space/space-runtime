// Actions-bundle signature verification (cloud runner side).
//
// Mirrors construct-app/frontend/space_loader/signature.ts — SAME pinned key,
// SAME scheme (ECDSA P-256 / SHA-256, signature = raw r||s base64, signed over
// the UTF-8 bytes of the JS) — but verifies the headless `actions.js` bundle
// using `manifest.build.actionsSignature` instead of the UI bundle's
// `signature`. The private half lives in developer-api (SPACE_SIGNING_KEY_PEM).
//
// The cloud runs third-party code, so unlike the desktop's staged "warn"
// rollout the runner is strict by default: a present signature MUST verify, and
// (under the default 'require' policy) an UNSIGNED bundle is rejected too. Set
// SPACE_SIGNATURE_POLICY=warn to allow unsigned during migration, or =off only
// for trusted local/dev runs.

export type SignaturePolicy = 'off' | 'warn' | 'require'

export interface SpaceSigningKey {
  id: string
  /** Base64 (standard, padded) SPKI DER of a P-256 public key. */
  spkiB64: string
}

// Pinned marketplace key — identical to the desktop's TRUSTED_SPACE_KEYS.
export const TRUSTED_SPACE_KEYS: SpaceSigningKey[] = [
  { id: 'marketplace-2026-05', spkiB64: 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEYZuLBMtamjiDyFzmZRMl8I6S7WMMuyfXU9Z2ka7AMleB+loajtTrvZkGUp7087IABve/ccjEHae1fQEtcbC2Aw==' },
]

// Cloud default is STRICT (require) — third-party code on our servers.
export function signaturePolicy(): SignaturePolicy {
  const v = process.env.SPACE_SIGNATURE_POLICY
  if (v === 'off' || v === 'warn' || v === 'require') return v
  return 'require'
}

export interface BuildMeta {
  actionsSignature?: string
  signKeyId?: string
}

export interface SignatureResult {
  ok: boolean
  state: 'signed-valid' | 'signed-invalid' | 'unsigned'
  reason?: string
}

function base64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(Buffer.from(b64, 'base64'))
}

async function importKey(spkiB64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'spki',
    base64ToBytes(spkiB64),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  )
}

/**
 * Verify the headless actions bundle before it is imported/run.
 *
 * @param actionsJs the exact actions.js text the signature was produced over
 * @param build     manifest.build (carries actionsSignature + signKeyId)
 */
export async function verifyActionsSignature(
  actionsJs: string,
  build: BuildMeta | undefined,
  opts: { policy?: SignaturePolicy; keys?: SpaceSigningKey[] } = {},
): Promise<SignatureResult> {
  const policy = opts.policy ?? signaturePolicy()
  if (policy === 'off') {
    return { ok: true, state: build?.actionsSignature ? 'signed-valid' : 'unsigned', reason: 'enforcement off' }
  }

  const keys = opts.keys ?? TRUSTED_SPACE_KEYS
  const sig = build?.actionsSignature

  if (!sig) {
    if (policy === 'require') {
      return { ok: false, state: 'unsigned', reason: 'actions bundle is unsigned and policy is "require"' }
    }
    return { ok: true, state: 'unsigned', reason: 'unsigned (allowed under "warn")' }
  }

  const key = keys.find(k => k.id === build?.signKeyId) ?? keys[0]
  if (!key) {
    return { ok: false, state: 'signed-invalid', reason: 'signed but no trusted key is pinned to verify it' }
  }
  try {
    const pub = await importKey(key.spkiB64)
    const valid = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      pub,
      base64ToBytes(sig),
      new TextEncoder().encode(actionsJs),
    )
    if (!valid) {
      return { ok: false, state: 'signed-invalid', reason: `signature did not verify against key "${key.id}"` }
    }
    return { ok: true, state: 'signed-valid' }
  } catch (e) {
    return { ok: false, state: 'signed-invalid', reason: `verification error: ${e instanceof Error ? e.message : String(e)}` }
  }
}
