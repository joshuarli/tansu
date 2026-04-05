// WebAuthn PRF extension helpers for biometric unlock

// Fixed PRF salt — domain separation so the same authenticator produces
// different outputs for different apps. Not secret.
let prfSalt: ArrayBuffer | null = null;

export async function getPrfSalt(): Promise<ArrayBuffer> {
  if (!prfSalt) {
    prfSalt = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("tansu-prf-salt-v1"));
  }
  return prfSalt;
}

export function bufToBase64(buf: BufferSource): string {
  const bytes =
    buf instanceof ArrayBuffer
      ? new Uint8Array(buf)
      : new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  return btoa(String.fromCharCode(...bytes));
}

export function bufToBase64url(buf: ArrayBuffer): string {
  return bufToBase64(buf).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64urlToBuf(b64: string): ArrayBuffer {
  const padded =
    b64.replace(/-/g, "+").replace(/_/g, "/") + "==".slice(0, (4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const buf = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) buf[i] = binary.charCodeAt(i);
  return buf.buffer;
}

export interface PrfRegistrationResult {
  credentialId: string;
  prfKeyB64: string;
}

// Register a new PRF credential (Face ID / Touch ID).
// Returns the credential ID (base64url) and PRF output (base64).
// Throws if PRF is not supported or the user cancels.
export async function createPrfCredential(): Promise<PrfRegistrationResult> {
  const salt = await getPrfSalt();

  const credential = (await navigator.credentials.create({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rp: { name: "Tansu", id: location.hostname },
      user: {
        id: new Uint8Array([1]),
        name: "owner",
        displayName: "Owner",
      },
      pubKeyCredParams: [
        { alg: -7, type: "public-key" }, // ES256
        { alg: -257, type: "public-key" }, // RS256 fallback
      ],
      authenticatorSelection: { userVerification: "required" },
      extensions: {
        prf: { eval: { first: salt } },
      },
    },
  })) as PublicKeyCredential;

  const prfResult = credential.getClientExtensionResults().prf;
  if (!prfResult?.results?.first) {
    throw new Error("PRF extension not supported by this authenticator");
  }

  return {
    credentialId: bufToBase64url(credential.rawId),
    prfKeyB64: bufToBase64(prfResult.results.first),
  };
}

// Authenticate with an existing PRF credential to get the PRF output for unlock.
// `credentialIds` are base64url-encoded credential IDs from /api/status.
export async function getPrfKey(credentialIds: string[]): Promise<string> {
  const salt = await getPrfSalt();

  const allowCredentials = credentialIds.map((id) => ({
    type: "public-key" as const,
    id: base64urlToBuf(id),
  }));

  const assertion = (await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rpId: location.hostname,
      allowCredentials,
      userVerification: "required",
      extensions: {
        prf: { eval: { first: salt } },
      },
    },
  })) as PublicKeyCredential;

  const prfResult = assertion.getClientExtensionResults().prf;
  if (!prfResult?.results?.first) {
    throw new Error("PRF output not available");
  }

  return bufToBase64(prfResult.results.first);
}

// Check if WebAuthn + PRF is likely supported in this browser.
export function isPrfLikelySupported(): boolean {
  return typeof PublicKeyCredential !== "undefined" && typeof navigator.credentials !== "undefined";
}
