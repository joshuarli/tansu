let buildId;

function assetUrls(document, selector) {
  return [...document.querySelectorAll(selector)]
    .map((element) => new URL(element.getAttribute(selector.startsWith("script") ? "src" : "href"), location.href))
    .filter((url) => url.pathname.startsWith("/assets/"))
    .map((url) => url.pathname);
}

async function updateStyles(nextDocument) {
  const current = [...document.querySelectorAll('link[rel="stylesheet"][href]')]
    .filter((link) => new URL(link.href).pathname.startsWith("/assets/"));
  const next = [...nextDocument.querySelectorAll('link[rel="stylesheet"][href]')]
    .filter((link) => new URL(link.href).pathname.startsWith("/assets/"));

  if (current.length !== next.length) {
    location.reload();
    return;
  }

  for (let index = 0; index < current.length; index++) {
    const oldLink = current[index];
    const newUrl = new URL(next[index].href);
    if (new URL(oldLink.href).pathname === newUrl.pathname) continue;
    const newLink = document.createElement("link");
    newLink.rel = "stylesheet";
    newLink.href = newUrl.href;
    newLink.media = oldLink.media;
    await new Promise((resolve, reject) => {
      newLink.addEventListener("load", resolve, { once: true });
      newLink.addEventListener("error", () => {
        newLink.remove();
        reject(new Error(`Stylesheet update failed: ${newUrl.pathname}`));
      }, { once: true });
      oldLink.after(newLink);
    });
    oldLink.remove();
  }
}

async function reconcilePage() {
  const page = await fetch(location.pathname, { cache: "no-store" });
  if (!page.ok) throw new Error(`Page request returned ${page.status}`);
  const nextDocument = new DOMParser().parseFromString(await page.text(), "text/html");
  if (JSON.stringify(assetUrls(document, "script[src]")) !== JSON.stringify(assetUrls(nextDocument, "script[src]"))) {
    location.reload();
    return false;
  }
  await updateStyles(nextDocument);
  return true;
}

async function checkBuild() {
  try {
    const response = await fetch("/__dev/hmr", { cache: "no-store" });
    if (!response.ok) return;
    const build = await response.json();
    if (buildId === undefined) {
      if (!await reconcilePage()) return;
      buildId = build.id;
      return;
    }
    if (build.id === buildId) return;
    if (!await reconcilePage()) return;
    buildId = build.id;
  } catch (error) {
    console.error("HMR update failed", error);
  } finally {
    setTimeout(checkBuild, 500);
  }
}

checkBuild();
