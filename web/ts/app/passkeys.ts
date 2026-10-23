import type { V2AuthClient, V2AuthCeremony } from "./v2-api.ts";

type CredentialPort = {
  get: (options?: CredentialRequestOptions) => Promise<Credential | null>;
  create: (options?: CredentialCreationOptions) => Promise<Credential | null>;
};

export async function loginWithPasskey(
  auth: V2AuthClient,
  credentials: CredentialPort = navigator.credentials,
): Promise<void> {
  const ceremony = await auth.beginLogin();
  const credential = await credentials.get({ publicKey: decodeRequestOptions(ceremony) });
  if (!isPublicKeyCredential(credential) || !isAssertionResponse(credential.response)) {
    throw new Error("The browser did not return a passkey assertion");
  }
  await auth.finishLogin(ceremony.ceremonyId, encodeAssertion(credential));
}

export async function enrollPasskey(
  auth: V2AuthClient,
  capability?: string,
  credentials: CredentialPort = navigator.credentials,
): Promise<void> {
  const ceremony = await auth.beginEnrollment(capability);
  const credential = await credentials.create({ publicKey: decodeCreationOptions(ceremony) });
  if (!isPublicKeyCredential(credential) || !isAttestationResponse(credential.response)) {
    throw new Error("The browser did not return a passkey registration");
  }
  await auth.finishEnrollment(ceremony.ceremonyId, encodeAttestation(credential));
}

function decodeRequestOptions(ceremony: V2AuthCeremony): PublicKeyCredentialRequestOptions {
  const options = { ...ceremony.publicKey };
  const challenge = stringField(options, "challenge");
  const allowCredentials = options["allowCredentials"];
  return {
    ...options,
    challenge: decodeBase64Url(challenge),
    ...(Array.isArray(allowCredentials)
      ? { allowCredentials: allowCredentials.map((value) => decodeCredentialDescriptor(value)) }
      : {}),
  } as PublicKeyCredentialRequestOptions;
}

function decodeCreationOptions(ceremony: V2AuthCeremony): PublicKeyCredentialCreationOptions {
  const options = { ...ceremony.publicKey };
  const user = recordField(options, "user");
  return {
    ...options,
    challenge: decodeBase64Url(stringField(options, "challenge")),
    user: { ...user, id: decodeBase64Url(stringField(user, "id")) },
    ...(Array.isArray(options["excludeCredentials"])
      ? {
        excludeCredentials: (options["excludeCredentials"] as unknown[])
          .map((value) => decodeCredentialDescriptor(value)),
      }
      : {}),
  } as PublicKeyCredentialCreationOptions;
}

function encodeAssertion(credential: PublicKeyCredential): unknown {
  const response = credential.response;
  if (!isAssertionResponse(response)) {
    throw new TypeError("Passkey assertion response is required");
  }
  return {
    id: credential.id,
    rawId: encodeBase64Url(credential.rawId),
    type: credential.type,
    response: {
      clientDataJSON: encodeBase64Url(response.clientDataJSON),
      authenticatorData: encodeBase64Url(response.authenticatorData),
      signature: encodeBase64Url(response.signature),
      userHandle: response.userHandle === null ? null : encodeBase64Url(response.userHandle),
    },
  };
}

function encodeAttestation(credential: PublicKeyCredential): unknown {
  const response = credential.response;
  if (!isAttestationResponse(response)) {
    throw new TypeError("Passkey registration response is required");
  }
  return {
    id: credential.id,
    rawId: encodeBase64Url(credential.rawId),
    type: credential.type,
    response: {
      clientDataJSON: encodeBase64Url(response.clientDataJSON),
      attestationObject: encodeBase64Url(response.attestationObject),
    },
  };
}

function decodeCredentialDescriptor(value: unknown): PublicKeyCredentialDescriptor {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Passkey credential descriptor is malformed");
  }
  const descriptor = value as Record<string, unknown>;
  return {
    ...descriptor,
    id: decodeBase64Url(stringField(descriptor, "id")),
  } as PublicKeyCredentialDescriptor;
}

function decodeBase64Url(value: string): ArrayBuffer {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

function encodeBase64Url(value: ArrayBuffer): string {
  const bytes = new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function stringField(value: Record<string, unknown>, name: string): string {
  const field = value[name];
  if (typeof field !== "string" || field.length === 0) throw new TypeError(`Passkey ${name} is invalid`);
  return field;
}

function recordField(value: Record<string, unknown>, name: string): Record<string, unknown> {
  const field = value[name];
  if (typeof field !== "object" || field === null || Array.isArray(field)) {
    throw new TypeError(`Passkey ${name} is invalid`);
  }
  return field as Record<string, unknown>;
}

function isPublicKeyCredential(value: Credential | null): value is PublicKeyCredential {
  return value !== null && value.type === "public-key" && "rawId" in value && "response" in value;
}

function isAssertionResponse(value: AuthenticatorResponse): value is AuthenticatorAssertionResponse {
  return "authenticatorData" in value && "signature" in value && "userHandle" in value;
}

function isAttestationResponse(value: AuthenticatorResponse): value is AuthenticatorAttestationResponse {
  return "attestationObject" in value;
}
