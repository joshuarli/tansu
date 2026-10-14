import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loginWithPasskey: vi.fn(async (_auth: unknown) => {}),
  enrollPasskey: vi.fn(async (_auth: unknown, _capability?: string) => {}),
  logout: vi.fn(async () => {}),
}));

vi.mock(import("./passkeys.ts"), () => ({
  loginWithPasskey: mocks.loginWithPasskey,
  enrollPasskey: mocks.enrollPasskey,
}));

vi.mock(import("./v2-api.ts"), () => ({
  createV2ApiClient: () => ({
    auth: {
      beginLogin: vi.fn(async () => ({ ceremonyId: "login", expiresAt: 1, publicKey: {} })),
      finishLogin: vi.fn(async () => {}),
      beginEnrollment: vi.fn(async () => ({ ceremonyId: "enrollment", expiresAt: 1, publicKey: {} })),
      finishEnrollment: vi.fn(async () => {}),
      logout: mocks.logout,
    },
    bootstrap: vi.fn(async () => ({ apiVersion: 2 as const, serverInstanceId: "server-1", vaults: [] })),
    forVault: vi.fn(() => {
      throw new Error("unexpected vault lookup");
    }),
  }),
}));

describe("default app services", () => {
  it("connects passkey and workspace lifecycle services", async () => {
    const { defaultServices } = await import("./services.ts");
    await defaultServices.passkeys.login();
    await defaultServices.passkeys.enroll("capability");
    await defaultServices.passkeys.logout();

    expect(mocks.loginWithPasskey).toHaveBeenCalledWith(defaultServices.api.auth);
    expect(mocks.enrollPasskey).toHaveBeenCalledWith(defaultServices.api.auth, "capability");
    expect(mocks.logout).toHaveBeenCalledTimes(1);

    const journal = defaultServices.workspace.createJournal(() => {});
    const detach = defaultServices.workspace.attachVisibilityFlush(journal);
    detach();
    expect(defaultServices.workspace.serverIdentity("server-1", "vault-1")).toStrictEqual({
      serverInstanceId: "server-1",
      vaultId: "vault-1",
    });
    await expect(defaultServices.storage.requestPersistent()).resolves.toBeFalsy();
  });
});
