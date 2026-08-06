/**
 * Polyfill crypto.randomUUID for non-secure HTTP contexts (e.g. LAN IP access).
 * crypto.randomUUID is restricted to secure contexts (HTTPS / localhost) in modern browsers,
 * but crypto.getRandomValues works everywhere. This must be imported before any library
 * that calls crypto.randomUUID (e.g. livekit-client).
 */
function randomUuidV4(): `${string}-${string}-${string}-${string}-${string}` {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  // Set version 4 and variant bits per RFC 4122
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` as `${string}-${string}-${string}-${string}-${string}`;
}

if (typeof globalThis !== 'undefined' &&
    typeof globalThis.crypto !== 'undefined' &&
    typeof globalThis.crypto.randomUUID !== 'function') {
  Object.defineProperty(globalThis.crypto, 'randomUUID', {
    configurable: true,
    writable: true,
    value: randomUuidV4,
  });
}

/**
 * Generate an idempotency/request ID in LAN HTTP contexts as well as HTTPS.
 * `crypto.randomUUID()` is not exposed by every browser outside a secure context.
 */
export function createClientRequestId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    return randomUuidV4();
  }
  // Last-resort compatibility for very old webviews. This ID is used for
  // request de-duplication, not as an authentication secret.
  return `lifeos-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
