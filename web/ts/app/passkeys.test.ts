import { describe, expect, it, vi } from "vitest";

import { enrollPasskey, loginWithPasskey } from "./passkeys.ts";
import type { V2AuthClient, V2AuthCeremony } from "./v2-api.ts";

describe("passkey browser operations", () => {
  it("decodes assertion options and submits the browser response", async () => {
    const auth = {
      beginLogin: vi.fn(async () => ceremony({
        challenge: "AQID",
        rpId: "notes.example.test",
        allowCredentials: [{ type: "public-key", id: "BAUG" }],
        userVerification: "required",
      })),
      finishLogin: vi.fn(async () => {}),
    } as unknown as V2AuthClient;
    const assertion = {
      id: "credential-id",
      rawId: binary(10, 11, 12),
      type: "public-key",
      response: {
        clientDataJSON: binary(1),
        authenticatorData: binary(2),
        signature: binary(3),
        userHandle: binary(4),
      },
    } as unknown as Credential;
    const requestOptions: CredentialRequestOptions[] = [];
    const credentials = {
      get: vi.fn(async (options?: CredentialRequestOptions) => {
        requestOptions.push(options!);
        return assertion;
      }),
      create: vi.fn(async () => null),
    } as unknown as NonNullable<Parameters<typeof loginWithPasskey>[1]>;

    await loginWithPasskey(auth, credentials);

    const publicKey = requestOptions[0]?.publicKey as PublicKeyCredentialRequestOptions;
    expect([...new Uint8Array(publicKey.challenge as ArrayBuffer)]).toStrictEqual([1, 2, 3]);
    expect(publicKey.rpId).toBe("notes.example.test");
    expect([...new Uint8Array(publicKey.allowCredentials![0]!.id as ArrayBuffer)]).toStrictEqual([4, 5, 6]);
    expect(auth.finishLogin).toHaveBeenCalledWith("ceremony-1", {
      id: "credential-id",
      rawId: "CgsM",
      type: "public-key",
      response: {
        clientDataJSON: "AQ",
        authenticatorData: "Ag",
        signature: "Aw",
        userHandle: "BA",
      },
    });
  });

  it("decodes registration options and submits the browser response", async () => {
    const auth = {
      beginEnrollment: vi.fn(async () => ceremony({
        challenge: "AQID",
        rp: { id: "notes.example.test", name: "Tansu" },
        user: { id: "BAUG", name: "owner", displayName: "Owner" },
        pubKeyCredParams: [{ type: "public-key", alg: -7 }],
        excludeCredentials: [{ type: "public-key", id: "BwgJ" }],
      })),
      finishEnrollment: vi.fn(async () => {}),
    } as unknown as V2AuthClient;
    const attestation = {
      id: "credential-id",
      rawId: binary(10, 11, 12),
      type: "public-key",
      response: { clientDataJSON: binary(1), attestationObject: binary(2) },
    } as unknown as Credential;
    const creationOptions: CredentialCreationOptions[] = [];
    const credentials = {
      get: vi.fn(async () => null),
      create: vi.fn(async (options?: CredentialCreationOptions) => {
        creationOptions.push(options!);
        return attestation;
      }),
    } as unknown as NonNullable<Parameters<typeof enrollPasskey>[2]>;

    await enrollPasskey(auth, "first-use-capability", credentials);

    expect(auth.beginEnrollment).toHaveBeenCalledWith("first-use-capability");
    const publicKey = creationOptions[0]?.publicKey as PublicKeyCredentialCreationOptions;
    expect([...new Uint8Array(publicKey.challenge as ArrayBuffer)]).toStrictEqual([1, 2, 3]);
    expect([...new Uint8Array(publicKey.user.id as ArrayBuffer)]).toStrictEqual([4, 5, 6]);
    expect([...new Uint8Array(publicKey.excludeCredentials![0]!.id as ArrayBuffer)]).toStrictEqual([7, 8, 9]);
    expect(auth.finishEnrollment).toHaveBeenCalledWith("ceremony-1", {
      id: "credential-id",
      rawId: "CgsM",
      type: "public-key",
      response: { clientDataJSON: "AQ", attestationObject: "Ag" },
    });
  });

  it("rejects malformed browser options before invoking the authenticator", async () => {
    const auth = { beginLogin: vi.fn(async () => ceremony({ challenge: "" })) } as unknown as V2AuthClient;
    const credentials = {
      get: vi.fn(async () => null),
      create: vi.fn(async () => null),
    } as unknown as NonNullable<Parameters<typeof loginWithPasskey>[1]>;

    await expect(loginWithPasskey(auth, credentials)).rejects.toThrow("Passkey challenge is invalid");
    expect(credentials.get).not.toHaveBeenCalled();
  });
});

function ceremony(publicKey: Record<string, unknown>): V2AuthCeremony {
  return { ceremonyId: "ceremony-1", expiresAt: 50, publicKey };
}

function binary(...values: number[]): ArrayBuffer {
  return new Uint8Array(values).buffer;
}
