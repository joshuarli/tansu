import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createServer as createHttpsServer, request as httpsRequest } from "node:https";
import net from "node:net";
import { join, resolve } from "node:path";

import { chromium, type Browser, type BrowserContext } from "playwright";
import { expect, describe, it } from "vitest";

type Fixture = {
  configHome: string;
  dataHome: string;
  vaultOne: string;
  vaultTwo: string;
};

describe("authenticated Chromium server", () => {
  it("enrolls and logs in with a virtual authenticator, then revokes protected access", async () => {
    const scratchRoot = join(process.cwd(), ".work", "tmp");
    await mkdir(scratchRoot, { recursive: true });
    const root = await mkdtemp(join(scratchRoot, "h2-auth-"));
    const fixture = JSON.parse(
      execFileSync(process.execPath, ["scripts/test-fixture.mjs", root, "--copy-vaults"], {
        cwd: process.cwd(),
        encoding: "utf8",
      }),
    ) as Fixture;
    const upstreamPort = await freePort();
    const publicPort = await freePort();
    const origin = `https://localhost:${publicPort}`;
    const environment = {
      ...process.env,
      TMPDIR: scratchRoot,
      TANSU2_LOGS: "buffer",
      XDG_CONFIG_HOME: fixture.configHome,
      XDG_DATA_HOME: fixture.dataHome,
    };
    const configPath = join(fixture.configHome, "tansu", "config.toml");
    await writeFile(
      configPath,
      `[[vaults]]\nname = "One"\npath = ${JSON.stringify(fixture.vaultOne)}\n\n[[vaults]]\nname = "Two"\npath = ${JSON.stringify(fixture.vaultTwo)}\n\n[auth]\nmode = "authenticated"\nexternal_origin = ${JSON.stringify(origin)}\nrp_id = "localhost"\nrp_name = "Tansu"\nstate_directory = "auth"\n`,
      "utf8",
    );
    execFileSync("cargo", ["build", "--quiet", "--bin", "tansu2"], {
      cwd: process.cwd(),
      env: environment,
      stdio: "pipe",
    });
    const targetDirectory = resolve(process.env["CARGO_TARGET_DIR"] ?? "target");
    const serverBinary = join(targetDirectory, "debug", process.platform === "win32" ? "tansu2.exe" : "tansu2");
    const capability = execFileSync(serverBinary, ["auth", "enroll"], {
      cwd: process.cwd(),
      env: environment,
      encoding: "utf8",
    }).trim();
    const keyPath = join(root, "localhost-key.pem");
    const certificatePath = join(root, "localhost-cert.pem");
    execFileSync("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-keyout",
      keyPath,
      "-out",
      certificatePath,
      "-days",
      "1",
      "-nodes",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,DNS:evil.localhost",
    ], { cwd: process.cwd(), env: environment, stdio: "ignore" });

    let server: ChildProcess | undefined;
    let browser: Browser | undefined;
    let browserContext: BrowserContext | undefined;
    let proxy: ReturnType<typeof createHttpsServer> | undefined;
    let checkingEmbeddedApp = false;
    const iframeCspPolicies: string[] = [];
    const embeddedAppScripts: string[] = [];
    const serverOutput: string[] = [];
    try {
      server = spawn(serverBinary, ["--port", String(upstreamPort)], {
        cwd: process.cwd(),
        env: environment,
        stdio: ["ignore", "pipe", "pipe"],
      });
      server.stdout?.on("data", (chunk: Buffer) => serverOutput.push(chunk.toString("utf8")));
      server.stderr?.on("data", (chunk: Buffer) => serverOutput.push(chunk.toString("utf8")));
      await waitForReady(
        upstreamPort,
        new URL(origin).host,
        server,
        serverOutput,
      );
      proxy = createHttpsServer(
        { key: await readFile(keyPath), cert: await readFile(certificatePath) },
        (incoming, outgoing) => {
          if (incoming.headers.host === `evil.localhost:${publicPort}` && incoming.url === "/iframe-ceremony") {
            outgoing.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            outgoing.end(`<!doctype html><iframe id="tansu" allow="publickey-credentials-get" src="${origin}/"></iframe>`);
            return;
          }
          const isEmbeddedApp = checkingEmbeddedApp && incoming.headers.host === `localhost:${publicPort}`;
          if (isEmbeddedApp && incoming.headers["sec-fetch-dest"] === "script") {
            embeddedAppScripts.push(incoming.url ?? "");
          }
          const upstream = httpRequest({
            hostname: "127.0.0.1",
            port: upstreamPort,
            path: incoming.url,
            method: incoming.method,
            headers: incoming.headers,
          }, (response) => {
            if (isEmbeddedApp && incoming.headers["sec-fetch-dest"] === "iframe") {
              iframeCspPolicies.push(String(response.headers["content-security-policy"] ?? ""));
            }
            outgoing.writeHead(response.statusCode ?? 502, response.headers);
            response.pipe(outgoing);
          });
          upstream.on("error", () => {
            if (!outgoing.headersSent) outgoing.writeHead(502);
            outgoing.end();
          });
          incoming.pipe(upstream);
        },
      );
      await new Promise<void>((resolve, reject) => {
        proxy!.once("error", reject);
        proxy!.listen(publicPort, () => resolve());
      });
      browser = await chromium.launch();
      browserContext = await browser.newContext({ ignoreHTTPSErrors: true });
      const page = await browserContext.newPage();
      const cdp = await browserContext.newCDPSession(page);
      await cdp.send("WebAuthn.enable");
      const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
        options: {
          protocol: "ctap2",
          transport: "internal",
          hasResidentKey: true,
          hasUserVerification: true,
          isUserVerified: true,
          automaticPresenceSimulation: true,
        },
      });

      await page.goto(origin);
      await page.waitForSelector(".auth-gate");
      const deniedEnrollment = page.waitForResponse((response) =>
        response.url().endsWith("/api/v2/auth/enrollment/options")
      );
      await page.getByTitle("Register first passkey").click();
      expect((await deniedEnrollment).status()).toBe(401);

      await page.locator('[data-key="enrollment-capability"]').fill(capability);
      const enrollmentOptions = page.waitForResponse((response) =>
        response.url().endsWith("/api/v2/auth/enrollment/options")
      );
      const enrollmentFinish = page.waitForResponse((response) =>
        response.url().endsWith("/api/v2/auth/enrollment/finish")
      );
      await page.getByTitle("Register first passkey").click();
      expect((await enrollmentOptions).status()).toBe(200);
      expect((await enrollmentFinish).status()).toBe(200);
      await page.waitForSelector(".main");

      const globalBootstrap = await page.evaluate(async () => {
        const response = await fetch("/api/v2/bootstrap");
        return { status: response.status, body: await response.json() };
      }) as {
        status: number;
        body: {
          serverInstanceId: string;
          vaults: { vaultId: string; name: string }[];
        };
      };
      expect(globalBootstrap.status).toBe(200);
      const serverInstanceId = globalBootstrap.body.serverInstanceId;
      const vaultOneId = globalBootstrap.body.vaults.find((vault) => vault.name === "One")?.vaultId;
      const vaultTwoId = globalBootstrap.body.vaults.find((vault) => vault.name === "Two")?.vaultId;
      if (vaultOneId === undefined || vaultTwoId === undefined) throw new Error("missing configured vault IDs");
      const vaultBootstrap = await page.evaluate(async ({ vaultId, serverInstanceId }) => {
        const response = await fetch(`/api/v2/vaults/${encodeURIComponent(vaultId)}/bootstrap`, {
          headers: { "X-Tansu-Server-Instance": serverInstanceId },
        });
        return { status: response.status, body: await response.json() };
      }, { vaultId: vaultOneId, serverInstanceId }) as {
        status: number;
        body: { notes: { noteId: string; path: string }[] };
      };
      expect(vaultBootstrap.status).toBe(200);
      const note = vaultBootstrap.body.notes.find((item) => item.path === "one.md");
      if (note === undefined) throw new Error("missing seeded One note");
      const protectedReads = await page.evaluate(async ({ vaultOneId, vaultTwoId, noteId, serverInstanceId }) => {
        const headers = { "X-Tansu-Server-Instance": serverInstanceId };
        const paths = [
          `/api/v2/vaults/${encodeURIComponent(vaultOneId)}/assets?name=${encodeURIComponent("z-images/sample.webp")}`,
          `/api/v2/vaults/${encodeURIComponent(vaultOneId)}/notes/${encodeURIComponent(noteId)}/revisions`,
          `/api/v2/vaults/${encodeURIComponent(vaultOneId)}/notes/${encodeURIComponent(noteId)}/conflicts/1`,
          `/api/v2/vaults/${encodeURIComponent(vaultTwoId)}/notes/${encodeURIComponent(noteId)}`,
        ];
        const responses = await Promise.all(paths.map((path) => fetch(path, { headers })));
        const eventResponse = await fetch(`/api/v2/vaults/${encodeURIComponent(vaultOneId)}/events?after=0`, {
          headers,
        });
        const eventReader = eventResponse.body?.getReader();
        if (eventReader === undefined) throw new Error("event stream body missing");
        const eventClosed = (async () => {
          while (true) {
            if ((await eventReader.read()).done) return true;
          }
        })();
        (window as unknown as { __h2EventClosed?: Promise<boolean> }).__h2EventClosed = eventClosed;
        return { statuses: responses.map((response) => response.status), eventStatus: eventResponse.status };
      }, { vaultOneId, vaultTwoId, noteId: note.noteId, serverInstanceId });
      expect(protectedReads.statuses).toStrictEqual([200, 200, 404, 404]);
      expect(protectedReads.eventStatus).toBe(200);

      const cookies = await browserContext.cookies(origin);
      const session = cookies.find((cookie) => cookie.name === "__Host-tansu_session");
      if (session === undefined) throw new Error("login did not issue a session cookie");
      const csrf = cookies.find((cookie) => cookie.name === "__Host-tansu_csrf");
      if (csrf === undefined) throw new Error("login did not issue a CSRF cookie");
      const csrfRejected = await page.evaluate(async () => {
        const response = await fetch("/api/v2/auth/logout", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Tansu-CSRF": "forged" },
          body: "{}",
        });
        return response.status;
      });
      expect(csrfRejected).toBe(403);

      await page.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+k`);
      await page.locator(".command-input").fill("Settings");
      await page.locator(".command-row", { hasText: "Settings" }).evaluate((row) => (row as HTMLElement).click());
      await page.getByTitle("Lock this session").click();
      await page.waitForSelector(".auth-gate");
      await expect(page.evaluate(() => (
        window as unknown as { __h2EventClosed: Promise<boolean> }
      ).__h2EventClosed)).resolves.toBeTruthy();

      const deniedAfterLogout = await page.evaluate(async ({ vaultId, noteId, serverInstanceId }) => {
        const headers = { "X-Tansu-Server-Instance": serverInstanceId };
        const paths = [
          "/api/v2/bootstrap",
          `/api/v2/vaults/${encodeURIComponent(vaultId)}/notes/${encodeURIComponent(noteId)}/revisions`,
          `/api/v2/vaults/${encodeURIComponent(vaultId)}/notes/${encodeURIComponent(noteId)}/conflicts/1`,
          `/api/v2/vaults/${encodeURIComponent(vaultId)}/assets?name=${encodeURIComponent("z-images/sample.webp")}`,
          `/api/v2/vaults/${encodeURIComponent(vaultId)}/events?after=0`,
        ];
        const responses = await Promise.all(paths.map((path) => fetch(path, { headers })));
        return responses.map((response) => response.status);
      }, { vaultId: vaultOneId, noteId: note.noteId, serverInstanceId });
      expect(deniedAfterLogout).toStrictEqual([401, 401, 401, 401, 401]);

      const staleSession = await secureRequest(
        publicPort,
        origin,
        "/api/v2/bootstrap",
        `__Host-tansu_session=${session.value}`,
        serverInstanceId,
      );
      expect(staleSession.status).toBe(401);
      const forgedSession = await secureRequest(
        publicPort,
        origin,
        "/api/v2/bootstrap",
        "__Host-tansu_session=forged",
        serverInstanceId,
      );
      expect(forgedSession.status).toBe(401);
      const loginOptions = page.waitForResponse((response) =>
        response.url().endsWith("/api/v2/auth/login/options")
      );
      const loginFinish = page.waitForResponse((response) =>
        response.url().endsWith("/api/v2/auth/login/finish")
      );
      await page.getByTitle("Sign in with passkey").click();
      expect((await loginOptions).status()).toBe(200);
      expect((await loginFinish).status()).toBe(200);
      await page.waitForSelector(".main");

      await page.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+k`);
      await page.locator(".command-input").fill("Settings");
      await page.locator(".command-row", { hasText: "Settings" }).evaluate((row) => (row as HTMLElement).click());
      await page.getByTitle("Lock this session").click();
      await page.waitForSelector(".auth-gate");
      expect((await browserContext.cookies(origin)).some((cookie) => cookie.name === "__Host-tansu_session"))
        .toBeFalsy();

      const attackerOrigin = `https://evil.localhost:${publicPort}`;
      const attackerUrl = `${attackerOrigin}/iframe-ceremony`;
      const iframeCeremonyRequests: string[] = [];
      page.on("request", (request) => {
        if (request.url().includes("/api/v2/auth/login/")) iframeCeremonyRequests.push(request.url());
      });
      checkingEmbeddedApp = true;
      const attackerResponse = await page.goto(attackerUrl);
      expect(attackerResponse?.status()).toBe(200);
      expect(await page.evaluate(() => location.origin)).toBe(attackerOrigin);
      expect(iframeCspPolicies).toHaveLength(1);
      expect(iframeCspPolicies[0]).toContain("frame-ancestors 'none'");
      expect(embeddedAppScripts).toStrictEqual([]);
      expect(iframeCeremonyRequests).toStrictEqual([]);
      expect((await browserContext.cookies(origin)).some((cookie) => cookie.name === "__Host-tansu_session"))
        .toBeFalsy();
      const crossOriginSession = await secureRequest(
        publicPort,
        origin,
        "/api/v2/bootstrap",
        "",
        serverInstanceId,
      );
      expect(crossOriginSession.status).toBe(401);
      await cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId });
      await cdp.detach();
      await page.close();
    } finally {
      await browserContext?.close();
      await browser?.close();
      if (proxy !== undefined) {
        proxy.closeAllConnections();
        await new Promise<void>((resolve, reject) => {
          proxy!.close((error) => error === undefined ? resolve() : reject(error));
        });
      }
      await stopServer(server);
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);
});

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      const address = listener.address();
      listener.close(() => {
        if (address !== null && typeof address === "object") resolve(address.port);
        else reject(new Error("no free port"));
      });
    });
  });
}

async function waitForReady(
  port: number,
  host: string,
  server: ChildProcess,
  serverOutput: string[],
): Promise<void> {
  const deadline = Date.now() + 20_000;
  let lastAttempt = "no response";
  while (Date.now() < deadline) {
    try {
      const status = await new Promise<number>((resolve, reject) => {
        const request = httpRequest({
          hostname: "127.0.0.1",
          port,
          path: "/api/v2/health",
          headers: { Host: host },
        }, (response) => {
          response.resume();
          response.on("end", () => resolve(response.statusCode ?? 0));
        });
        request.on("error", reject);
        request.end();
      });
      if (status === 200) return;
      lastAttempt = `HTTP ${status}`;
    } catch (error) {
      lastAttempt = error instanceof Error ? error.message : String(error);
    }
    if (server.exitCode !== null || server.signalCode !== null) {
      throw new Error(`server exited before readiness (${server.exitCode ?? server.signalCode}): ${serverOutput.join("")}`);
    }
    if (lastAttempt !== "no response") {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`server did not become ready on ${port} (${lastAttempt})\n${serverOutput.join("")}`);
}

async function secureRequest(
  port: number,
  origin: string,
  path: string,
  cookie: string,
  serverInstanceId: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(origin);
    const request = httpsRequest({
      hostname: url.hostname,
      port,
      path,
      method: "GET",
      headers: {
        Host: url.host,
        Cookie: cookie,
        "X-Tansu-Server-Instance": serverInstanceId,
      },
      agent: false,
      rejectUnauthorized: false,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.on("error", reject);
    request.end();
  });
}

async function stopServer(server: ChildProcess | undefined): Promise<void> {
  if (server === undefined) return;
  let didExit = false;
  const exited = once(server, "exit").then(() => {
    didExit = true;
  });
  if (server.exitCode === null && server.signalCode === null) server.kill("SIGTERM");
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
  if (!didExit && server.exitCode === null && server.signalCode === null) {
    server.kill("SIGKILL");
    await exited;
  }
}
