import assert from "node:assert/strict";
import { test } from "vitest";
import {
  applyTotalImageCap,
  bytesToBase64,
  fetchTansuImage,
  IMAGE_ACCEPT_HEADER,
  IMAGE_USER_AGENT,
  isRetryableImageStatus,
  mapWithConcurrency,
  MAX_IMAGE_BYTES,
  MAX_TOTAL_IMAGE_BYTES,
  planTansuImages,
  prepareTansuImport,
  retryWithExponentialBackoff,
  type ImageFetchOutcome,
} from "../src/tansu-import.ts";

const SOURCE = "https://example.com/articles/hello",
  SUBSTACK_IMAGE_DISPLAY_URL =
    "https://substackcdn.com/image/fetch/$s_!3fbT!,w_1456,c_limit,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F4d386d33-e530-49fd-9619-a8d72cbbc10d_1049x655.png",
  SUBSTACK_IMAGE_LINK_URL =
    "https://substackcdn.com/image/fetch/$s_!3fbT!,f_auto,q_auto:good,fl_progressive:steep/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F4d386d33-e530-49fd-9619-a8d72cbbc10d_1049x655.png",
  noSleep = { attempts: 3, initialDelayMs: 1, maxDelayMs: 2, sleep: async () => {} };

function imageResponse(
  body: Uint8Array,
  headers: Record<string, string> = { "content-type": "image/png" },
  status = 200,
): Response {
  return new Response(body as BodyInit, { status, headers });
}

test("rewrites every standard embed to a placeholder token and deduplicates URLs", () => {
  const planned = planTansuImages(
    "![a](/a.jpg) text ![b](https://example.com/a.jpg)\n\n![c](https://example.com/c.png)",
    SOURCE,
  );

  assert.deepEqual(planned.urls, ["https://example.com/a.jpg", "https://example.com/c.png"]);
  assert.equal(
    planned.markdown,
    "![a](tansu-import-image:0) text ![b](tansu-import-image:0)\n\n![c](tansu-import-image:1)",
  );
});

test("unwraps Substack links that point to the same image", () => {
  const planned = planTansuImages(
    `[![](${SUBSTACK_IMAGE_DISPLAY_URL})](${SUBSTACK_IMAGE_LINK_URL})`,
    SOURCE,
  );

  assert.deepEqual(planned.urls, [SUBSTACK_IMAGE_DISPLAY_URL]);
  assert.equal(planned.markdown, "![](tansu-import-image:0)");
});

test("preserves links around images when they point elsewhere", () => {
  const planned = planTansuImages(
    `[![report](${SUBSTACK_IMAGE_DISPLAY_URL})](https://example.com/report)`,
    SOURCE,
  );

  assert.equal(
    planned.markdown,
    `[![report](tansu-import-image:0)](https://example.com/report)`,
  );
});

test("rewrite preserves unrelated bytes, titles are dropped, and non-web or code embeds stay", () => {
  const markdown = [
    "---",
    'title: "T"',
    "---",
    "",
    '![angle](<https://example.com/a b.jpg> "title")',
    String.raw`![escaped](https://example.com/b\(1\).jpg)`,
    "![[z-images/existing.webp]]",
    "![file](file:///tmp/existing.jpg)",
    "![data](data:image/png;base64,AAAA)",
    "`![code](https://example.com/code.jpg)`",
    "```",
    "![fenced](https://example.com/fenced.jpg)",
    "```",
  ].join("\n");
  const planned = planTansuImages(markdown, SOURCE);

  assert.deepEqual(planned.urls, ["https://example.com/a%20b.jpg", "https://example.com/b(1).jpg"]);
  assert.equal(
    planned.markdown,
    [
      "---",
      'title: "T"',
      "---",
      "",
      "![angle](tansu-import-image:0)",
      "![escaped](tansu-import-image:1)",
      "![[z-images/existing.webp]]",
      "![file](file:///tmp/existing.jpg)",
      "![data](data:image/png;base64,AAAA)",
      "`![code](https://example.com/code.jpg)`",
      "```",
      "![fenced](https://example.com/fenced.jpg)",
      "```",
    ].join("\n"),
  );
});

test("a markdown without images is unchanged", () => {
  const planned = planTansuImages("# Title\n\nBody", SOURCE);

  assert.equal(planned.markdown, "# Title\n\nBody");
  assert.deepEqual(planned.urls, []);
});

test("identifies transient image response statuses", () => {
  for (const status of [408, 425, 429, 500, 503, 599]) {
    assert.equal(isRetryableImageStatus(status), true, String(status));
  }
  for (const status of [200, 301, 400, 401, 403, 404, 600]) {
    assert.equal(isRetryableImageStatus(status), false, String(status));
  }
});

test("retries transient results with exponential delays", async () => {
  let attempts = 0;
  const delays: number[] = [];
  const result = await retryWithExponentialBackoff(
    async () => {
      attempts++;
      return attempts < 3 ? 503 : 200;
    },
    (status) => isRetryableImageStatus(status),
    {
      attempts: 4,
      initialDelayMs: 25,
      maxDelayMs: 100,
      sleep: async (delayMs) => {
        delays.push(delayMs);
      },
    },
  );

  assert.equal(result, 200);
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [25, 50]);
});

test("retries thrown operations and rethrows the final error", async () => {
  let attempts = 0;
  const delays: number[] = [];
  await assert.rejects(
    retryWithExponentialBackoff(
      async () => {
        attempts++;
        throw new Error("offline");
      },
      () => false,
      {
        attempts: 3,
        initialDelayMs: 10,
        maxDelayMs: 100,
        sleep: async (delayMs) => {
          delays.push(delayMs);
        },
      },
    ),
    /offline/,
  );

  assert.equal(attempts, 3);
  assert.deepEqual(delays, [10, 20]);
});

test("bounded mapping preserves order", async () => {
  const results = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (item) => item * 10);

  assert.deepEqual(results, [10, 20, 30, 40, 50]);
});

test("bounded mapping limits concurrent work", async () => {
  let active = 0;
  let maximumActive = 0;

  await mapWithConcurrency([1, 2, 3, 4, 5], 2, async () => {
    active++;
    maximumActive = Math.max(maximumActive, active);
    await Promise.resolve();
    active--;
  });

  assert.equal(maximumActive, 2);
});

test("fetches an image with browser-like headers", async () => {
  let seen: { url: string; init: RequestInit | undefined } | undefined;
  const outcome = await fetchTansuImage(
    "https://example.com/a.png",
    async (url, init) => {
      seen = { url: String(url), init };
      return imageResponse(new Uint8Array([1, 2, 3]), { "content-type": "Image/PNG; charset=x" });
    },
    noSleep,
  );

  assert.deepEqual(outcome, {
    status: "fetched",
    contentType: "image/png",
    bytes: new Uint8Array([1, 2, 3]),
  });
  assert.deepEqual(seen?.init?.headers, {
    Accept: IMAGE_ACCEPT_HEADER,
    "User-Agent": IMAGE_USER_AGENT,
  });
});

test("retries 503 responses then succeeds", async () => {
  let calls = 0;
  const outcome = await fetchTansuImage(
    "https://example.com/a.png",
    async () => {
      calls++;
      return calls < 3
        ? new Response("busy", { status: 503 })
        : imageResponse(new Uint8Array([9]));
    },
    noSleep,
  );

  assert.equal(outcome.status, "fetched");
  assert.equal(calls, 3);
});

test("rejects non-image content types and HTTP errors without retrying 404", async () => {
  let calls = 0;
  assert.deepEqual(
    await fetchTansuImage(
      "https://example.com/a",
      async () => imageResponse(new Uint8Array([1]), { "content-type": "text/html" }),
      noSleep,
    ),
    { status: "failed", reason: "not-image" },
  );
  assert.deepEqual(
    await fetchTansuImage(
      "https://example.com/a",
      async () => imageResponse(new Uint8Array([1]), {}),
      noSleep,
    ),
    { status: "failed", reason: "not-image" },
  );
  assert.deepEqual(
    await fetchTansuImage(
      "https://example.com/a",
      async () => {
        calls++;
        return new Response("no", { status: 404 });
      },
      noSleep,
    ),
    { status: "failed", reason: "http" },
  );
  assert.equal(calls, 1);
});

test("a network failure after retries fails soft", async () => {
  let calls = 0;
  const outcome = await fetchTansuImage(
    "https://example.com/a.png",
    async () => {
      calls++;
      throw new TypeError("offline");
    },
    noSleep,
  );

  assert.deepEqual(outcome, { status: "failed", reason: "network" });
  assert.equal(calls, 3);
});

test("an image over the per-image cap stays remote", async () => {
  assert.deepEqual(
    await fetchTansuImage(
      "https://example.com/big.png",
      async () =>
        imageResponse(new Uint8Array(1), {
          "content-type": "image/png",
          "content-length": String(MAX_IMAGE_BYTES + 1),
        }),
      noSleep,
    ),
    { status: "failed", reason: "too-large" },
  );
  assert.deepEqual(
    await fetchTansuImage(
      "https://example.com/big.png",
      async () => imageResponse(new Uint8Array(MAX_IMAGE_BYTES + 1)),
      noSleep,
    ),
    { status: "failed", reason: "too-large" },
  );
  assert.equal(
    (
      await fetchTansuImage(
        "https://example.com/limit.png",
        async () => imageResponse(new Uint8Array(MAX_IMAGE_BYTES)),
        noSleep,
      )
    ).status,
    "fetched",
  );
});

test("images beyond the total cap stay remote in source order", () => {
  const fetched = (size: number): ImageFetchOutcome => ({
      status: "fetched",
      contentType: "image/png",
      bytes: { byteLength: size } as Uint8Array,
    }),
    capped = applyTotalImageCap([
      fetched(MAX_IMAGE_BYTES),
      fetched(MAX_IMAGE_BYTES),
      fetched(MAX_IMAGE_BYTES),
      fetched(MAX_IMAGE_BYTES),
      fetched(1),
      { status: "failed", reason: "http" },
    ]);

  assert.equal(MAX_TOTAL_IMAGE_BYTES, 4 * MAX_IMAGE_BYTES);
  assert.deepEqual(
    capped.map((outcome) => (outcome.status === "fetched" ? "ok" : outcome.reason)),
    ["ok", "ok", "ok", "ok", "total-cap", "http"],
  );
});

test("encodes bytes as base64 across chunk boundaries", () => {
  const bytes = Uint8Array.from({ length: 0x8000 * 2 + 5 }, (_, index) => index % 251);

  assert.equal(bytesToBase64(bytes), Buffer.from(bytes).toString("base64"));
});

test("prepares markdown and images with failures left as null base64", async () => {
  const prepared = await prepareTansuImport(
    "![a](/a.png) ![b](/b.png) ![c](/c.png)",
    SOURCE,
    {
      retryOptions: noSleep,
      fetchImpl: async (url) => {
        const path = new URL(String(url)).pathname;
        if (path === "/a.png") return imageResponse(new Uint8Array([1, 2]));
        if (path === "/b.png") return new Response("gone", { status: 404 });
        return imageResponse(new Uint8Array([3]), { "content-type": "image/webp" });
      },
    },
  );

  assert.equal(
    prepared.markdown,
    "![a](tansu-import-image:0) ![b](tansu-import-image:1) ![c](tansu-import-image:2)",
  );
  assert.deepEqual(prepared.images, [
    { id: 0, url: "https://example.com/a.png", contentType: "image/png", base64: "AQI=" },
    { id: 1, url: "https://example.com/b.png", contentType: "", base64: null },
    { id: 2, url: "https://example.com/c.png", contentType: "image/webp", base64: "Aw==" },
  ]);
});
