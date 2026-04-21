import { describe, test, expect } from "vitest";

import {
  getPrfSalt,
  bufToBase64,
  bufToBase64url,
  base64urlToBuf,
  createPrfCredential,
  getPrfKey,
  isPrfLikelySupported,
} from "./webauthn.ts";

describe("bufToBase64", () => {
  test("base64 ArrayBuffer", () => {
    expect(bufToBase64(new Uint8Array([72, 101, 108, 108, 111]).buffer)).toBe(btoa("Hello"));
  });
  test("base64 Uint8Array", () => {
    expect(bufToBase64(new Uint8Array([72, 101, 108, 108, 111]))).toBe(btoa("Hello"));
  });
  test("base64 empty", () => {
    expect(bufToBase64(new ArrayBuffer(0))).toBe("");
  });
  test("base64 subarray offset", () => {
    const full = new Uint8Array([0, 0, 72, 101, 108, 108, 111]);
    const sub = full.subarray(2);
    expect(bufToBase64(sub)).toBe(btoa("Hello"));
  });
});

describe("bufToBase64url", () => {
  // 0xfb,0xff,0xfe -> base64 "u//+" -> base64url "u__-"
  const specialBytes = new Uint8Array([0xfb, 0xff, 0xfe]);

  test("base64url no plus", () => {
    expect(bufToBase64url(specialBytes.buffer).includes("+")).toBe(false);
  });
  test("base64url no slash", () => {
    expect(bufToBase64url(specialBytes.buffer).includes("/")).toBe(false);
  });
  test("base64url no padding", () => {
    expect(bufToBase64url(specialBytes.buffer).includes("=")).toBe(false);
  });
});

describe("base64urlToBuf round-trip", () => {
  test("roundtrip length", () => {
    const original = new Uint8Array([1, 2, 3, 4, 5, 100, 200, 255]);
    const encoded = bufToBase64url(original.buffer);
    const decoded = new Uint8Array(base64urlToBuf(encoded));
    expect(decoded.length).toBe(original.length);
  });

  test("roundtrip bytes", () => {
    const original = new Uint8Array([1, 2, 3, 4, 5, 100, 200, 255]);
    const encoded = bufToBase64url(original.buffer);
    const decoded = new Uint8Array(base64urlToBuf(encoded));
    for (let i = 0; i < original.length; i++) {
      expect(decoded[i]).toBe(original[i]);
    }
  });

  test("roundtrip single byte", () => {
    const one = new Uint8Array([42]);
    const oneRt = new Uint8Array(base64urlToBuf(bufToBase64url(one.buffer)));
    expect(oneRt[0]).toBe(42);
  });

  test("roundtrip two bytes length", () => {
    const two = new Uint8Array([42, 43]);
    const twoRt = new Uint8Array(base64urlToBuf(bufToBase64url(two.buffer)));
    expect(twoRt.length).toBe(2);
  });
});

describe("getPrfSalt", () => {
  test("salt is 32 bytes", async () => {
    const salt1 = new Uint8Array(await getPrfSalt());
    expect(salt1.byteLength).toBe(32);
  });
  test("salt is deterministic (cached)", async () => {
    const salt1 = new Uint8Array(await getPrfSalt());
    const salt2 = new Uint8Array(await getPrfSalt());
    expect(bufToBase64(salt1)).toBe(bufToBase64(salt2));
  });
});

describe("isPrfLikelySupported", () => {
  test("isPrfLikelySupported returns boolean", () => {
    // In Bun there's no PublicKeyCredential, so should be false
    expect(typeof isPrfLikelySupported()).toBe("boolean");
  });
});

describe("createPrfCredential / getPrfKey", () => {
  const fakePrfOutput = crypto.getRandomValues(new Uint8Array(32));
  const fakeRawId = crypto.getRandomValues(new Uint8Array(16));

  function mockCredentials(prfResult: unknown) {
    const fakeCredential = {
      rawId: fakeRawId.buffer,
      getClientExtensionResults: () => ({ prf: prfResult }),
    };
    const origNav = globalThis.navigator;
    const nav = {
      ...origNav,
      credentials: {
        create: async () => fakeCredential,
        get: async () => fakeCredential,
      },
    };
    (globalThis as Record<string, unknown>)["navigator"] = nav;
    // createPrfCredential uses location.hostname
    if (typeof globalThis.location === "undefined") {
      (globalThis as Record<string, unknown>)["location"] = { hostname: "localhost" } as Location;
    }
    return () => {
      (globalThis as Record<string, unknown>)["navigator"] = origNav;
    };
  }

  // Also need PublicKeyCredential for isPrfLikelySupported
  const origPKC = (globalThis as Record<string, unknown>)["PublicKeyCredential"];

  test("create returns credentialId string", async () => {
    const restore = mockCredentials({ results: { first: fakePrfOutput.buffer } });
    const result = await createPrfCredential();
    expect(typeof result.credentialId).toBe("string");
    restore();
  });

  test("create returns prfKeyB64 string", async () => {
    const restore = mockCredentials({ results: { first: fakePrfOutput.buffer } });
    const result = await createPrfCredential();
    expect(typeof result.prfKeyB64).toBe("string");
    restore();
  });

  test("credentialId decodes to correct length", async () => {
    const restore = mockCredentials({ results: { first: fakePrfOutput.buffer } });
    const result = await createPrfCredential();
    const decodedId = new Uint8Array(base64urlToBuf(result.credentialId));
    expect(decodedId.length).toBe(fakeRawId.length);
    restore();
  });

  test("credentialId bytes match", async () => {
    const restore = mockCredentials({ results: { first: fakePrfOutput.buffer } });
    const result = await createPrfCredential();
    const decodedId = new Uint8Array(base64urlToBuf(result.credentialId));
    for (let i = 0; i < fakeRawId.length; i++) {
      expect(decodedId[i]).toBe(fakeRawId[i]);
    }
    restore();
  });

  test("prfKey decodes to correct length", async () => {
    const restore = mockCredentials({ results: { first: fakePrfOutput.buffer } });
    const result = await createPrfCredential();
    const decodedKey = Uint8Array.from(atob(result.prfKeyB64), (c) => c.charCodeAt(0));
    expect(decodedKey.length).toBe(fakePrfOutput.length);
    restore();
  });

  test("create rejects without PRF results", async () => {
    const restore = mockCredentials({ results: {} });
    await expect(createPrfCredential()).rejects.toThrow();
    restore();
  });

  test("create rejects with null PRF", async () => {
    const restore = mockCredentials(null);
    await expect(createPrfCredential()).rejects.toThrow();
    restore();
  });

  test("getPrfKey returns string", async () => {
    const restore = mockCredentials({ results: { first: fakePrfOutput.buffer } });
    const credId = bufToBase64url(fakeRawId.buffer);
    const key = await getPrfKey([credId]);
    expect(typeof key).toBe("string");
    restore();
  });

  test("getPrfKey output correct length", async () => {
    const restore = mockCredentials({ results: { first: fakePrfOutput.buffer } });
    const credId = bufToBase64url(fakeRawId.buffer);
    const key = await getPrfKey([credId]);
    const decoded = Uint8Array.from(atob(key), (c) => c.charCodeAt(0));
    expect(decoded.length).toBe(fakePrfOutput.length);
    restore();
  });

  test("getPrfKey rejects without PRF output", async () => {
    const restore = mockCredentials({ results: {} });
    await expect(getPrfKey(["AAAA"])).rejects.toThrow();
    restore();
  });

  test("supported when globals exist", () => {
    (globalThis as Record<string, unknown>)["PublicKeyCredential"] = class {
      isUserVerifyingPlatformAuthenticatorAvailable() {
        return Promise.resolve(true);
      }
    };
    const restore = mockCredentials({});
    expect(isPrfLikelySupported()).toBe(true);
    restore();
    (globalThis as Record<string, unknown>)["PublicKeyCredential"] = origPKC;
  });
});
