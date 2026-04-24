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
  it("base64 ArrayBuffer", () => {
    expect(bufToBase64(new Uint8Array([72, 101, 108, 108, 111]).buffer)).toBe(btoa("Hello"));
  });
  it("base64 Uint8Array", () => {
    expect(bufToBase64(new Uint8Array([72, 101, 108, 108, 111]))).toBe(btoa("Hello"));
  });
  it("base64 empty", () => {
    expect(bufToBase64(new ArrayBuffer(0))).toBe("");
  });
  it("base64 subarray offset", () => {
    const full = new Uint8Array([0, 0, 72, 101, 108, 108, 111]);
    const sub = full.subarray(2);
    expect(bufToBase64(sub)).toBe(btoa("Hello"));
  });
});

describe("bufToBase64url", () => {
  // 0xfb,0xff,0xfe -> base64 "u//+" -> base64url "u__-"
  const specialBytes = new Uint8Array([0xfb, 0xff, 0xfe]);

  it("base64url no plus", () => {
    expect(bufToBase64url(specialBytes.buffer)).not.toContain("+");
  });
  it("base64url no slash", () => {
    expect(bufToBase64url(specialBytes.buffer)).not.toContain("/");
  });
  it("base64url no padding", () => {
    expect(bufToBase64url(specialBytes.buffer)).not.toContain("=");
  });
});

describe("base64urlToBuf round-trip", () => {
  it("roundtrip length", () => {
    const original = new Uint8Array([1, 2, 3, 4, 5, 100, 200, 255]);
    const encoded = bufToBase64url(original.buffer);
    const decoded = new Uint8Array(base64urlToBuf(encoded));
    expect(decoded).toHaveLength(original.length);
  });

  it("roundtrip bytes", () => {
    const original = new Uint8Array([1, 2, 3, 4, 5, 100, 200, 255]);
    const encoded = bufToBase64url(original.buffer);
    const decoded = new Uint8Array(base64urlToBuf(encoded));
    for (let i = 0; i < original.length; i++) {
      expect(decoded[i]).toBe(original[i]);
    }
  });

  it("roundtrip single byte", () => {
    const one = new Uint8Array([42]);
    const oneRt = new Uint8Array(base64urlToBuf(bufToBase64url(one.buffer)));
    expect(oneRt[0]).toBe(42);
  });

  it("roundtrip two bytes length", () => {
    const two = new Uint8Array([42, 43]);
    const twoRt = new Uint8Array(base64urlToBuf(bufToBase64url(two.buffer)));
    expect(twoRt).toHaveLength(2);
  });
});

describe("getPrfSalt", () => {
  it("salt is 32 bytes", async () => {
    const salt1 = new Uint8Array(await getPrfSalt());
    expect(salt1.byteLength).toBe(32);
  });
  it("salt is deterministic (cached)", async () => {
    const salt1 = new Uint8Array(await getPrfSalt());
    const salt2 = new Uint8Array(await getPrfSalt());
    expect(bufToBase64(salt1)).toBe(bufToBase64(salt2));
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
    if (globalThis.location === undefined) {
      (globalThis as Record<string, unknown>)["location"] = { hostname: "localhost" } as Location;
    }
    return () => {
      (globalThis as Record<string, unknown>)["navigator"] = origNav;
    };
  }

  // Also need PublicKeyCredential for isPrfLikelySupported
  const origPKC = (globalThis as Record<string, unknown>)["PublicKeyCredential"];

  it("create returns credentialId string", async () => {
    const restore = mockCredentials({ results: { first: fakePrfOutput.buffer } });
    const result = await createPrfCredential();
    expectTypeOf(result.credentialId).toBeString();
    restore();
  });

  it("create returns prfKeyB64 string", async () => {
    const restore = mockCredentials({ results: { first: fakePrfOutput.buffer } });
    const result = await createPrfCredential();
    expectTypeOf(result.prfKeyB64).toBeString();
    restore();
  });

  it("credentialId decodes to correct length", async () => {
    const restore = mockCredentials({ results: { first: fakePrfOutput.buffer } });
    const result = await createPrfCredential();
    const decodedId = new Uint8Array(base64urlToBuf(result.credentialId));
    expect(decodedId).toHaveLength(fakeRawId.length);
    restore();
  });

  it("credentialId bytes match", async () => {
    const restore = mockCredentials({ results: { first: fakePrfOutput.buffer } });
    const result = await createPrfCredential();
    const decodedId = new Uint8Array(base64urlToBuf(result.credentialId));
    for (let i = 0; i < fakeRawId.length; i++) {
      expect(decodedId[i]).toBe(fakeRawId[i]);
    }
    restore();
  });

  it("prfKey decodes to correct length", async () => {
    const restore = mockCredentials({ results: { first: fakePrfOutput.buffer } });
    const result = await createPrfCredential();
    const decodedKey = Uint8Array.from(atob(result.prfKeyB64), (c) => c.codePointAt(0)!);
    expect(decodedKey).toHaveLength(fakePrfOutput.length);
    restore();
  });

  it("create rejects without PRF results", async () => {
    const restore = mockCredentials({ results: {} });
    await expect(createPrfCredential()).rejects.toThrow();
    restore();
  });

  it("create rejects with null PRF", async () => {
    const restore = mockCredentials(null);
    await expect(createPrfCredential()).rejects.toThrow();
    restore();
  });

  it("getPrfKey returns string", async () => {
    const restore = mockCredentials({ results: { first: fakePrfOutput.buffer } });
    const credId = bufToBase64url(fakeRawId.buffer);
    const key = await getPrfKey([credId]);
    expectTypeOf(key).toBeString();
    restore();
  });

  it("getPrfKey output correct length", async () => {
    const restore = mockCredentials({ results: { first: fakePrfOutput.buffer } });
    const credId = bufToBase64url(fakeRawId.buffer);
    const key = await getPrfKey([credId]);
    const decoded = Uint8Array.from(atob(key), (c) => c.codePointAt(0)!);
    expect(decoded).toHaveLength(fakePrfOutput.length);
    restore();
  });

  it("getPrfKey rejects without PRF output", async () => {
    const restore = mockCredentials({ results: {} });
    await expect(getPrfKey(["AAAA"])).rejects.toThrow();
    restore();
  });

  it("supported when globals exist", () => {
    (globalThis as Record<string, unknown>)["PublicKeyCredential"] = class {
      isUserVerifyingPlatformAuthenticatorAvailable() {
        return Promise.resolve(true);
      }
    };
    const restore = mockCredentials({});
    expect(isPrfLikelySupported()).toBeTruthy();
    restore();
    (globalThis as Record<string, unknown>)["PublicKeyCredential"] = origPKC;
  });
});
