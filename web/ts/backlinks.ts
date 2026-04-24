import { getBacklinks } from "./api.ts";
import { openTab } from "./tabs.ts";
import { stemFromPath } from "./util.ts";

/// Load and render backlinks for a note into the given container.
export async function loadBacklinks(el: HTMLElement, path: string) {
  try {
    const links = await getBacklinks(path);
    if (links.length === 0) {
      el.style.display = "none";
      return;
    }

    el.style.display = "";
    el.innerHTML = "";

    const header = document.createElement("div");
    header.className = "backlinks-header";
    header.textContent = `${links.length} backlink${links.length > 1 ? "s" : ""}`;
    el.append(header);

    const list = document.createElement("div");
    list.className = "backlinks-list";
    for (const linkPath of links) {
      const item = document.createElement("div");
      item.className = "backlink-item";
      item.textContent = stemFromPath(linkPath);
      item.onclick = () => openTab(linkPath);
      list.append(item);
    }
    el.append(list);
  } catch {
    el.style.display = "none";
  }
}
