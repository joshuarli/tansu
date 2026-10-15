import type { CommandItem, ViewEvent } from "./app/events.ts";
import { button, el, span } from "./dom.ts";
import { frontmatterSupportsTags } from "./markdown-tags.ts";
import {
  activeTab,
  loadedDraft,
  tabIsDirty,
  tabIdentity,
  toNoteId,
  toRevisionEventId,
  type State,
  type Tab,
} from "./state.ts";
import { vaultId } from "./app/identity.ts";
import { sameTabIdentity, type TabIdentity } from "./app/tab-identity.ts";
import type { V2OverlayCoverage, V2QuickOpenResponse, V2SearchHit } from "./types.generated.ts";
import type { FindMatch, Outline } from "./editor/source-navigation.js";

export type ViewActions = {
  dispatch: (event: ViewEvent) => void;
  commandItems: () => CommandItem[];
  recentPreview: (noteId: string) => string | null;
  findMatches: () => readonly FindMatch[];
  outline: () => Outline;
  activeHeadingFrom: number | null;
};

export function renderApp(state: State, actions: ViewActions): HTMLElement[] {
  const sidebar = renderSidebar(state, actions);
  const main = renderMain(state, actions);
  const overlays = renderOverlays(state, actions);
  sidebar.dataset["viewRegion"] = "sidebar";
  main.dataset["viewRegion"] = "main";
  overlays.dataset["viewRegion"] = "overlays";
  return [sidebar, main, overlays];
}

export function renderLoading(): HTMLElement {
  const loading = el("main", "loading", "Loading");
  loading.dataset["viewRegion"] = "startup";
  return loading;
}

export function renderNoVaultConfigured(): HTMLElement {
  const empty = el("main", "empty-state", el("h1", "empty-title", "No vault is configured"));
  empty.dataset["viewRegion"] = "startup";
  return empty;
}

export function renderAuthGate(state: State, actions: ViewActions): HTMLElement {
  const capability = document.createElement("input");
  capability.dataset["key"] = "enrollment-capability";
  capability.type = "password";
  capability.autocomplete = "one-time-code";
  capability.placeholder = "Enrollment capability";
  capability.value = state.authCapability;
  capability.addEventListener("input", () => actions.dispatch({ type: "auth.capability", value: capability.value }));
  const available = typeof navigator !== "undefined" && navigator.credentials !== undefined &&
    typeof window !== "undefined" && window.isSecureContext;
  const panel = el(
    "main",
    "auth-gate",
    el("div", "auth-card",
      el("p", "eyebrow", "Tansu2 vault"),
      el("h1", "auth-title", "Unlock your notes"),
      el("p", "auth-copy", "Use a passkey registered for this server."),
      state.authError === null ? el("span", "") : el("p", "auth-error", state.authError),
      button(
        state.authBusy === "login" ? "Waiting for passkey…" : "Sign in with passkey",
        "Sign in with passkey",
        () => actions.dispatch({ type: "auth.login" }),
        "primary-button",
      ),
      el("div", "auth-divider", "First credential"),
      el("label", "field-label", span("Enrollment capability"), capability),
      button(
        state.authBusy === "enroll" ? "Waiting for passkey…" : "Register first passkey",
        "Register first passkey",
        () => actions.dispatch({ type: "auth.enroll" }),
        "text-button",
      ),
      available ? span("") : el("p", "auth-error", "Passkeys require a supported browser in a secure context."),
    ),
  );
  panel.dataset["viewRegion"] = "auth";
  for (const control of panel.querySelectorAll<HTMLButtonElement>("button")) {
    control.disabled = !available || state.authBusy !== null;
  }
  return panel;
}

export function updateAppView(root: HTMLElement, regions: HTMLElement[]): void {
  const current = new Map(
    [...root.children].flatMap((node) => node instanceof HTMLElement && node.dataset["viewRegion"] !== undefined
      ? [[node.dataset["viewRegion"], node] as const]
      : []),
  );
  regions.forEach((next, index) => {
    const region = next.dataset["viewRegion"];
    if (region === undefined) throw new Error("App view region has no identity");
    const previous = current.get(region);
    const node = previous === undefined ? next : reconcileNode(previous, next);
    current.delete(region);
    const before = root.children.item(index);
    if (before !== node) root.insertBefore(node, before);
  });
  for (const obsolete of current.values()) {
    closeVaultOptionsIn(obsolete);
    obsolete.remove();
  }
}

export function disposeAppView(root: HTMLElement): void {
  closeVaultOptionsIn(root);
}

function closeVaultOptionsIn(root: ParentNode): void {
  if (root instanceof HTMLElement && root.matches(".vault-control.open")) closeVaultOptions(root);
  for (const control of root.querySelectorAll<HTMLElement>(".vault-control.open")) {
    closeVaultOptions(control);
  }
}

function reconcileNode(current: Node, next: Node): Node {
  if (current.nodeType !== next.nodeType ||
    current instanceof Element && next instanceof Element && current.tagName !== next.tagName) {
    current.parentNode?.replaceChild(next, current);
    return next;
  }
  if (current instanceof Text && next instanceof Text) {
    if (current.data !== next.data) current.data = next.data;
    return current;
  }
  if (!(current instanceof HTMLElement) || !(next instanceof HTMLElement)) return next;
  if (current.id === "editor-mount") return current;
  const obsoleteAttributes: string[] = [];
  for (const attribute of current.attributes) {
    if (!next.hasAttribute(attribute.name)) obsoleteAttributes.push(attribute.name);
  }
  for (const name of obsoleteAttributes) current.removeAttribute(name);
  for (const attribute of next.attributes) {
    if (current.getAttribute(attribute.name) !== attribute.value) {
      current.setAttribute(attribute.name, attribute.value);
    }
  }
  if (current instanceof HTMLInputElement && next instanceof HTMLInputElement) {
    if (current.value !== next.value) current.value = next.value;
    current.checked = next.checked;
    current.disabled = next.disabled;
  } else if (current instanceof HTMLSelectElement && next instanceof HTMLSelectElement) {
    current.value = next.value;
  } else if (current instanceof HTMLTextAreaElement && next instanceof HTMLTextAreaElement) {
    if (current.value !== next.value) current.value = next.value;
  }
  reconcileChildren(current, next);
  return current;
}

function reconcileChildren(current: HTMLElement, next: HTMLElement): void {
  const oldChildren = [...current.childNodes];
  const nextChildCount = next.childNodes.length;
  const used = new Set<Node>();
  [...next.childNodes].forEach((fresh, index) => {
    const key = childKey(fresh);
    const candidate = key === null
      ? oldChildren[index] !== undefined && !used.has(oldChildren[index]) && childKey(oldChildren[index]) === null
        ? oldChildren[index]
        : undefined
      : oldChildren.find((child) => !used.has(child) && childKey(child) === key);
    const node = candidate !== undefined && compatibleNodes(candidate, fresh)
      ? reconcileNode(candidate, fresh)
      : fresh;
    used.add(node);
    const before = current.childNodes.item(index);
    if (before !== node) current.insertBefore(node, before);
  });
  while (current.childNodes.length > nextChildCount) current.lastChild?.remove();
}

function childKey(node: Node): string | null {
  if (!(node instanceof HTMLElement)) return null;
  if (node.dataset["key"] !== undefined) return `key:${node.dataset["key"]}`;
  if (node.id !== "") return `id:${node.id}`;
  return null;
}

function compatibleNodes(left: Node, right: Node): boolean {
  return left.nodeType === right.nodeType &&
    (!(left instanceof Element) || !(right instanceof Element) || left.tagName === right.tagName);
}

export function renderStatusBar(state: State): HTMLElement {
  const active = activeTab(state);
  const text = active === undefined
    ? ""
    : active.saving
    ? "Saving"
    : tabIsDirty(active)
    ? "Unsaved"
    : "Saved";
  return el(
    "footer",
    "statusbar",
    span(text),
    span(state.boot?.searchStatus.degraded ? "Search degraded" : ""),
  );
}

export function updateStatusBar(status: HTMLElement, state: State): void {
  reconcileNode(status, renderStatusBar(state));
}

function renderSidebar(state: State, actions: ViewActions): HTMLElement {
  const sidebar = el(
    "aside",
    ["sidebar", state.readingMode ? "reading-sidebar" : "", state.sidebarCollapsed ? "sidebar-collapsed" : ""]
      .filter(Boolean).join(" "),
  );
  const vaultSelect = document.createElement("select");
  vaultSelect.className = "vault-select";
  vaultSelect.dataset["key"] = "vault-select";
  const vaults = state.boot?.vaults ?? [];
  for (const vault of vaults) {
    const option = document.createElement("option");
    option.value = vault.vaultId;
    option.textContent = vault.name;
    option.selected = vault.vaultId === state.vault;
    vaultSelect.append(option);
  }
  const vaultLabel = span(vaultSelect.selectedOptions[0]?.textContent ?? "", "vault-label");
  vaultSelect.addEventListener("change", () => {
    vaultLabel.textContent = vaultSelect.selectedOptions[0]?.textContent ?? "";
    actions.dispatch({ type: "vault.switch", vaultId: vaultId(vaultSelect.value) });
  });
  const vaultOptions = el("div", "vault-options");
  const vaultControl = el("div", "vault-control", vaultLabel, vaultSelect, vaultOptions);
  for (const vault of vaults) {
    if (vault.vaultId === state.vault) {
      continue;
    }
    const option = button(
      vault.name,
      vault.name,
      (event) => {
        event.stopPropagation();
        closeVaultOptions(vaultControl);
        if (vault.vaultId !== vaultSelect.value) {
          vaultSelect.value = vault.vaultId;
          vaultLabel.textContent = vault.name;
          actions.dispatch({ type: "vault.switch", vaultId: vaultId(vault.vaultId) });
        }
      },
      vault.vaultId === state.vault ? "vault-option active" : "vault-option",
    );
    vaultOptions.append(option);
  }
  vaultControl.style.setProperty("--vault-option-count", String(vaultOptions.childElementCount));
  vaultControl.setAttribute("aria-expanded", "false");
  vaultControl.addEventListener("click", () => toggleVaultOptions(vaultControl));

  const search = document.createElement("input");
  search.className = "search-input";
  search.dataset["key"] = "sidebar-search";
  search.type = "search";
  search.placeholder = "Search";
  search.value = state.searchQuery;
  search.addEventListener("input", () => {
    actions.dispatch({ type: "search.input", query: search.value });
  });

  const searchButton = button(
    "⌕",
    "Search notes",
    () => actions.dispatch({ type: "search.open" }),
    "icon-button",
  );
  const create = button(
    "+",
    "New note",
    () => actions.dispatch({ type: "command.run", id: "create" }),
    "icon-button",
  );
  const read = toolButton(state.readingMode ? "eyeOff" : "eye", "Read", () =>
    actions.dispatch({ type: "reading.toggle" }),
  );
  const palette = button(
    "⌘",
    "Commands",
    () => actions.dispatch({ type: "command.open" }),
    "icon-button",
  );
  const collapse = button(
    state.sidebarCollapsed ? "›" : "‹",
    state.sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar",
    () => actions.dispatch({ type: "sidebar.toggle" }),
    "icon-button sidebar-collapse",
  );
  const controls = el("div", "sidebar-controls", searchButton, create, read, palette, collapse);

  sidebar.append(vaultControl, controls, search);
  if (state.searchQuery.trim() !== "") {
    const results = el("div", "note-list search-results");
    for (const hit of state.searchHits ?? []) results.append(searchHitRow(hit, actions));
    if (state.searchHits !== null && state.searchHits.length === 0) results.append(span("No matches", "empty-outline"));
    const coverage = draftCoverageMessage(state.searchCoverage);
    if (coverage !== null) results.append(coverage);
    sidebar.append(section("Search", results));
  }
  const outline = state.outlineCollapsed || activeTab(state) === undefined
    ? { headings: [], complete: true }
    : actions.outline();
  const outlineList = el("div", "outline-list");
  for (const heading of outline.headings) {
    const item = button(
      heading.text,
      `Go to heading ${heading.text}`,
      () => actions.dispatch({ type: "outline.select", heading }),
      "outline-row",
    );
    item.style.setProperty("--outline-level", String(heading.level));
    item.dataset["headingFrom"] = String(heading.from);
    if (heading.from === actions.activeHeadingFrom) item.setAttribute("aria-current", "location");
    outlineList.append(item);
  }
  if (outline.headings.length === 0) outlineList.append(span("No headings", "empty-outline"));
  const outlineHeading = button(
    state.outlineCollapsed ? "Outline ›" : "Outline ‹",
    state.outlineCollapsed ? "Expand outline" : "Collapse outline",
    () => actions.dispatch({ type: "outline.toggle" }),
    "outline-toggle",
  );
  const outlineSection = el("section", "sidebar-section outline-section", outlineHeading);
  if (!state.outlineCollapsed) outlineSection.append(outlineList);
  sidebar.append(outlineSection);
  sidebar.append(section("Pinned", noteList(state, [...state.pinned], actions)));
  sidebar.append(section("Recent", noteList(state, recentNoteIds(state), actions)));
  return sidebar;
}

const vaultOptionClosers = new WeakMap<HTMLElement, () => void>();

function toggleVaultOptions(vaultControl: HTMLElement): void {
  if (vaultControl.classList.contains("open")) {
    closeVaultOptions(vaultControl);
    return;
  }
  openVaultOptions(vaultControl);
}

function openVaultOptions(vaultControl: HTMLElement): void {
  if (vaultOptionClosers.has(vaultControl)) {
    return;
  }
  const onPointerDown = (event: PointerEvent) => {
    if (!(event.target instanceof Node) || !vaultControl.contains(event.target)) {
      closeVaultOptions(vaultControl);
    }
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      closeVaultOptions(vaultControl);
    }
  };
  const cleanup = () => {
    window.removeEventListener("pointerdown", onPointerDown, true);
    window.removeEventListener("keydown", onKeyDown, true);
  };
  vaultOptionClosers.set(vaultControl, cleanup);
  vaultControl.classList.add("open");
  vaultControl.setAttribute("aria-expanded", "true");
  window.addEventListener("pointerdown", onPointerDown, true);
  window.addEventListener("keydown", onKeyDown, true);
}

function closeVaultOptions(vaultControl: HTMLElement): void {
  vaultControl.classList.remove("open");
  vaultControl.setAttribute("aria-expanded", "false");
  vaultOptionClosers.get(vaultControl)?.();
  vaultOptionClosers.delete(vaultControl);
}

function renderMain(state: State, actions: ViewActions): HTMLElement {
  const active = activeTab(state);
  const reading = state.readingMode;
  const main = el(
    "main",
    ["main", reading ? "reading-mode" : "", state.findOpen ? "find-open" : ""]
      .filter(Boolean)
      .join(" "),
  );
  const tabs = el("div", "tabs");
  for (const tab of state.tabs) {
    const identity = tabIdentity(tab);
    const active = sameTabIdentity(identity, state.activeTab);
    const tabEl = button(
      "",
      tab.title,
      () => actions.dispatch({ type: "tab.activate", tab: identity }),
      active ? "tab active" : "tab",
    );
    tabEl.dataset["key"] = `tab:${tab.key}`;
    if (tab.kind === "saved") {
      tabEl.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        actions.dispatch({
          type: "context.open",
          noteId: tab.noteId,
          x: event.clientX,
          y: event.clientY,
        });
      });
    }
    const closeHint = span("x to close", "tab-close-tooltip");
    closeHint.setAttribute("aria-hidden", "true");
    const hideCloseHint = bindTabCloseHint(tabEl, closeHint, identity, actions);
    const tabLabel = span("", "tab-label");
    const isPinned = tab.kind === "saved" && state.pinned.has(tab.noteId);
    if (isPinned) tabLabel.classList.add("pinned-tab-label");
    tabLabel.append(document.createTextNode(tab.title));
    const tabContent = [tabLabel];
    if (isPinned) tabContent.push(span("📌", "tab-pinned"));
    if (tabIsDirty(tab)) tabContent.push(span("•"));
    if (tab.saving) tabContent.push(span("Saving", "tab-saving"));
    if (tab.conflict) tabContent.push(span("!", "tab-conflict"));
    tabContent.push(closeButton(identity, actions, hideCloseHint), closeHint);
    tabEl.append(...tabContent);
    tabs.append(tabEl);
  }
  const topbar = el("div", "topbar", tabs);
  const findBar = state.findOpen ? renderFindBar(state, actions) : null;
  const workspace = el("section", "workspace");
  if (active === undefined) {
    workspace.append(emptyState(actions), renderEditorMount(true));
  } else if (loadedDraft(active) === null) {
    const unavailable = active.kind === "saved" && active.session?.state.status === "unavailable"
      ? active.session.state
      : null;
    if (unavailable === null) {
      workspace.append(el("div", "loading", "Loading"));
    } else {
      const unresolved = unavailable.reason.kind === "unresolved";
      const state = el(
        "div",
        "empty-state unavailable-state",
        el("h1", "empty-title", unresolved ? "Note needs recovery" : "Server unavailable"),
        el(
          "p",
          "",
          unresolved
            ? "The vault cannot load this note because its stored content needs recovery."
            : "The server could not load this note. Retry when the vault is available.",
        ),
      );
      if (!unresolved && active.kind === "saved") {
        state.append(
          button(
            "Retry",
            "Retry note load",
            () => actions.dispatch({ type: "note.retry", noteId: active.noteId }),
            "primary-button",
          ),
        );
      }
      workspace.append(state);
    }
    workspace.append(renderEditorMount(true));
  } else {
    if (!reading) {
      workspace.append(editorToolbar(actions));
    }
    const meta = el(
      "div",
      reading ? "editor-meta reader-meta" : "editor-meta",
      el("div", "meta-spacer"),
      renderTagRow(active, actions, reading),
    );
    workspace.append(meta, renderEditorMount(false));
    if (active.conflict) {
      const banner = el(
        "div",
        "conflict-banner",
        span("Save conflict. Your rejected draft is recoverable on the server."),
      );
      banner.append(
        button(
          "View draft",
          "View conflict draft",
          () => actions.dispatch({ type: "conflict.view" }),
          "text-button",
        ),
        button(
          "Restore draft",
          "Restore conflict draft",
          () => actions.dispatch({ type: "conflict.restore" }),
          "text-button",
        ),
      );
      workspace.append(banner);
    }
    if (activeDraftStorageFailed(active)) {
      workspace.append(
        el(
          "div",
          "storage-failure-banner",
          span("Local recovery storage failed. Export your draft before closing this tab."),
          button("Export draft", "Export draft", () => actions.dispatch({ type: "draft.export" }), "text-button"),
        ),
      );
    }
    if (active.kind === "saved" && active.session?.state.status === "unavailable" &&
      active.session.state.reason.kind === "unresolved" && active.session.state.draft !== null) {
      workspace.append(
        el(
          "div",
          "storage-failure-banner",
          span("This note is missing from the vault. Your checkpoint remains recoverable."),
          button("Export draft", "Export draft", () => actions.dispatch({ type: "draft.export" }), "text-button"),
          button("Recreate note", "Recreate note from draft", () => actions.dispatch({ type: "draft.recreate" }), "text-button"),
        ),
      );
    }
    if (active.kind === "saved" && active.session?.state.status === "unavailable" &&
      active.session.state.reason.kind !== "unresolved") {
      workspace.append(
        el(
          "div",
          "unavailable-banner",
          span("The server is unavailable. Your latest edits remain in local recovery."),
          button(
            "Retry",
            "Retry note load",
            () => actions.dispatch({ type: "note.retry", noteId: active.noteId }),
            "text-button",
          ),
        ),
      );
    }
  }
  if (!reading) main.append(topbar);
  main.append(workspace, renderStatusBar(state));
  if (findBar !== null) main.append(findBar);
  return main;
}

function renderFindBar(state: State, actions: ViewActions): HTMLElement {
  const input = document.createElement("input");
  input.className = "find-input";
  input.dataset["key"] = "current-note-find";
  input.value = state.findQuery;
  input.placeholder = "Find";
  input.setAttribute("aria-label", "Find in current note");
  input.addEventListener("input", () => actions.dispatch({ type: "find.input", query: input.value }));
  const matches = actions.findMatches();
  const count = state.findQuery === "" ? "" : matches.length === 0 ? "No matches" : `${state.findIndex + 1} of ${matches.length}`;
  const previous = button("‹", "Previous match", () => actions.dispatch({ type: "find.move", direction: -1 }), "find-control find-previous");
  const next = button("›", "Next match", () => actions.dispatch({ type: "find.move", direction: 1 }), "find-control find-next");
  previous.disabled = matches.length === 0;
  next.disabled = matches.length === 0;
  const close = button("×", "Close find", () => actions.dispatch({ type: "find.close" }), "find-control find-close");
  const bar = el("div", "find-bar", span("⌕", "find-icon"), input, span(count, "find-count"), previous, next, close);
  queueMicrotask(() => input.focus());
  return bar;
}

function renderEditorMount(hidden: boolean): HTMLElement {
  const mount = el("div", "editor-mount");
  mount.id = "editor-mount";
  mount.hidden = hidden;
  mount.inert = hidden;
  if (hidden) mount.setAttribute("aria-hidden", "true");
  return mount;
}

function editorToolbar(actions: ViewActions): HTMLElement {
  return el(
    "div",
    "toolbar",
    toolButton("bold", "Bold", () => actions.dispatch({ type: "editor.toolbar", command: "bold" })),
    toolButton("italic", "Italic", () =>
      actions.dispatch({ type: "editor.toolbar", command: "italic" }),
    ),
    toolButton("strikethrough", "Strikethrough", () =>
      actions.dispatch({ type: "editor.toolbar", command: "strikethrough" }),
    ),
    toolButton("highlight", "Highlight", () =>
      actions.dispatch({ type: "editor.toolbar", command: "highlight" }),
    ),
    toolButton("heading", "Heading", () =>
      actions.dispatch({ type: "editor.toolbar", command: "heading" }),
    ),
    toolButton("undo", "Undo", () => actions.dispatch({ type: "editor.toolbar", command: "undo" })),
    toolButton("redo", "Redo", () => actions.dispatch({ type: "editor.toolbar", command: "redo" })),
    toolButton("code", "Source", () =>
      actions.dispatch({ type: "editor.toolbar", command: "source" }),
    ),
    toolButton("save", "Save", () => actions.dispatch({ type: "editor.toolbar", command: "save" })),
  );
}

function activeDraftStorageFailed(tab: Tab): boolean {
  if (tab.session === null) return false;
  return tab.kind === "local-draft"
    ? tab.session.state.storage === "failed"
    : tab.session.state.storage.kind === "failed";
}

function renderOverlays(state: State, actions: ViewActions): HTMLElement {
  const host = el("div", "overlay-host");
  if (state.commandOpen) {
    const input = document.createElement("input");
    input.className = "command-input";
    input.dataset["key"] = "command-filter";
    input.value = state.commandFilter;
    input.placeholder = "Type a command";
    input.addEventListener("input", () => {
      actions.dispatch({ type: "command.filter", query: input.value });
    });
    const list = el("div", "command-list");
    for (const [index, command] of actions.commandItems().entries()) {
      const row = button(
        "",
        command.label,
        () => actions.dispatch({ type: "command.run", id: command.id }),
        "command-row palette-command-row",
      );
      row.dataset["commandId"] = command.id;
      row.setAttribute("aria-label", command.label);
      if (index === 0 && state.commandFilter === "") row.classList.add("selected");
      row.append(span(command.label, "palette-command-label"));
      if (command.shortcut !== undefined) row.append(span(command.shortcut, "palette-command-shortcut"));
      list.append(row);
    }
    const searchIcon = el("span", "command-search-icon");
    searchIcon.setAttribute("aria-hidden", "true");
    const field = el("div", "command-field", searchIcon, input);
    host.append(backdrop(actions), el("div", "command-panel command-palette-panel", field, list));
    queueMicrotask(() => input.focus());
  }
  if (state.searchOpen) {
    const input = document.createElement("input");
    input.className = "command-input";
    input.dataset["key"] = "search-overlay";
    input.value = state.searchOverlayQuery;
    input.placeholder = "Search notes";
    input.addEventListener("input", () => {
      actions.dispatch({ type: "search.overlayInput", query: input.value });
    });
    const list = el("div", "command-list");
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") actions.dispatch({ type: "search.overlaySubmit" });
    });
    if (state.searchOverlayQuery.trim() !== "") {
      const hits = state.searchOverlayHits ?? [];
      for (const hit of hits) {
        list.append(searchHitRow(hit, actions));
      }
      if (state.searchOverlayHits !== null && hits.length === 0) {
        list.append(el(
          "div",
          "empty-panel search-empty",
          el("strong", "search-empty-heading", `No results for “${state.searchOverlayQuery.trim()}”`),
          el("span", "search-empty-message", "Try a different word or phrase."),
        ));
      }
      const coverage = draftCoverageMessage(state.searchOverlayCoverage);
      if (coverage !== null) list.append(coverage);
    } else if (state.searchHistory.length > 0) {
      list.append(el("div", "search-history-heading", "Recent searches"));
      for (const query of state.searchHistory) {
        list.append(button(query, `Search for ${query}`, () => actions.dispatch({ type: "search.historySelect", query }), "search-history-row"));
      }
    }
    host.append(backdrop(actions), el("div", "command-panel search-panel", el("div", "search-field", span("", "search-icon"), input), list));
    queueMicrotask(() => input.focus());
  }
  if (state.quickOpen) {
    const input = document.createElement("input");
    input.className = "command-input";
    input.dataset["key"] = "quick-open-input";
    input.value = state.quickOpenQuery;
    input.placeholder = "Filter recent notes";
    input.addEventListener("input", () => actions.dispatch({ type: "quickOpen.input", query: input.value }));
    const hits = state.quickOpenHits ?? [];
    const orderedHits = state.quickOpenQuery.trim() === ""
      ? [...hits].toSorted((left, right) => {
        const leftIndex = state.recent.indexOf(left.noteId);
        const rightIndex = state.recent.indexOf(right.noteId);
        return (leftIndex === -1 ? Number.MAX_SAFE_INTEGER : leftIndex) -
          (rightIndex === -1 ? Number.MAX_SAFE_INTEGER : rightIndex);
      })
      : hits;
    const list = el("div", "command-list quick-open-results");
    for (const [index, hit] of orderedHits.entries()) {
      list.append(quickOpenHitRow(hit, actions, state.quickOpenQuery, index === 0));
    }
    const count = hits.length;
    const quickOpenIcon = el("span", "quick-open-search-icon");
    quickOpenIcon.setAttribute("aria-hidden", "true");
    const quickOpenField = el("div", "quick-open-field", quickOpenIcon, input);
    host.append(backdrop(actions), el(
      "div",
      "command-panel quick-open-panel",
      el("header", "recent-notes-header", el("h2", "", "Recent notes"), span(`${count} recent notes`, "recent-notes-count")),
      quickOpenField,
      list,
    ));
    queueMicrotask(() => input.focus());
  }
  if (state.revisionsOpen) {
    host.append(backdrop(actions), renderRevisionsPanel(state, actions));
  }
  if (state.settingsOpen && state.boot !== null) {
    host.append(backdrop(actions), renderSettingsPanel(state, actions));
  }
  if (state.conflictDraft !== null) {
    host.append(backdrop(actions), renderConflictPanel(state, actions));
  }
  if (state.noteDialog !== null) {
    host.append(backdrop(actions), renderNoteDialog(state, actions));
  }
  if (state.contextMenu !== null) {
    host.append(renderContextMenu(state, actions));
  }
  if (state.notice !== null) {
    host.append(el("div", "toast", state.notice));
  }
  if (state.imageUploads.size > 0) {
    const status = el(
      "div",
      "toast image-upload-status",
      state.imageUploads.size === 1 ? "Uploading image…" : `Uploading ${state.imageUploads.size} images…`,
    );
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    host.append(status);
  }
  return host;
}

function backdrop(actions: ViewActions): HTMLElement {
  const element = el("div", "overlay-backdrop");
  element.addEventListener("click", () => actions.dispatch({ type: "overlay.close" }));
  return element;
}

function renderRevisionsPanel(state: State, actions: ViewActions): HTMLElement {
  const active = activeTab(state);
  const revisionList = active?.kind === "saved" && state.revisionNoteId === active.noteId
    ? state.revisionList?.filter((revision) => revision.noteId === active.noteId) ?? null
    : null;
  const revisionDocument = active?.kind === "saved" && state.revisionNoteId === active.noteId &&
      state.revisionDocument?.revision.noteId === active.noteId
    ? state.revisionDocument
    : null;
  const list = el("div", "revision-list");
  for (const revision of revisionList ?? []) {
    list.append(
      button(
        `${revision.kind}  revision ${revision.revision}`,
        `Revision ${revision.revision}`,
        () =>
          actions.dispatch({
            type: "revisions.select",
            eventId: toRevisionEventId(revision.revision),
          }),
        revisionDocument?.revision.revision === revision.revision
          ? "revision-row active"
          : "revision-row",
      ),
    );
  }
  const current = active === undefined ? "" : (loadedDraft(active) ?? "");
  const preview =
    revisionDocument === null
      ? el("div", "empty-panel", "Select a revision")
      : el("pre", "diff-preview", diffPreview(current, revisionDocument.content));
  return el(
    "div",
    "modal-panel revisions-panel",
    el(
      "div",
      "modal-header",
      span("Revisions"),
      button("×", "Close", () => actions.dispatch({ type: "overlay.close" }), "tab-close"),
    ),
    el("div", "revision-body", list, preview),
    el(
      "div",
      "modal-actions",
      button(
        "Restore",
        "Restore selected revision",
        () => actions.dispatch({ type: "revisions.restore" }),
        "primary-button",
      ),
    ),
  );
}

function renderConflictPanel(state: State, actions: ViewActions): HTMLElement {
  const draft = state.conflictDraft;
  return el(
    "div",
    "modal-panel revisions-panel",
    el(
      "div",
      "modal-header",
      span("Conflict Draft"),
      button("×", "Close", () => actions.dispatch({ type: "overlay.close" }), "tab-close"),
    ),
    el("pre", "diff-preview", draft?.content ?? ""),
    el(
      "div",
      "modal-actions",
      button(
        "Restore Draft",
        "Restore conflict draft",
        () => actions.dispatch({ type: "conflict.restore" }),
        "primary-button",
      ),
    ),
  );
}

function renderSettingsPanel(state: State, actions: ViewActions): HTMLElement {
  const settings = state.boot!.settings;
  const excluded = input("Excluded folders", settings.excludedFolders.join(", "));
  const autosave = input("Autosave delay", String(settings.autosaveDelayMs), "number");
  const undo = input("Undo stack", String(settings.undoStackMax), "number");
  const quality = input(
    "Image quality",
    String(settings.imageWebpQuality),
    "number",
    "0.1",
    "1",
    "0.05",
  );
  return el(
    "div",
    "modal-panel settings-panel",
    el(
      "div",
      "modal-header",
      span("Settings"),
      button("×", "Close", () => actions.dispatch({ type: "overlay.close" }), "tab-close"),
    ),
    el("label", "field-label", span("Excluded folders"), excluded),
    el("label", "field-label", span("Autosave delay ms"), autosave),
    el("label", "field-label", span("Undo stack max"), undo),
    el("label", "field-label", span("Image WebP quality"), quality),
    el(
      "div",
      "storage-preference",
      span(state.storagePersisted === null
        ? "Browser storage may be cleared under storage pressure."
        : state.storagePersisted ? "Persistent browser storage is enabled." : "The browser declined persistent storage."),
      button("Request persistent storage", "Request persistent storage", () => actions.dispatch({ type: "storage.persist" }), "text-button"),
    ),
    el(
      "div",
      "auth-settings",
      button("Add passkey", "Add passkey", () => actions.dispatch({ type: "auth.enroll" }), "text-button"),
      button("Lock this session", "Lock this session", () => actions.dispatch({ type: "auth.logout" }), "text-button"),
    ),
    el(
      "div",
      "modal-actions",
      button(
        "Save",
        "Save settings",
        () => {
          actions.dispatch({
            type: "settings.submit",
            settings: {
              excludedFoldersText: excluded.value,
              autosaveDelayMs: numericValue(autosave),
              undoStackMax: numericValue(undo),
              imageWebpQuality: numericValue(quality),
            },
          });
        },
        "primary-button",
      ),
    ),
  );
}

function numericValue(inputEl: HTMLInputElement): number {
  return inputEl.value.trim() === "" ? Number.NaN : Number(inputEl.value);
}

function renderNoteDialog(state: State, actions: ViewActions): HTMLElement {
  const dialog = state.noteDialog;
  const isDelete = dialog?.kind === "delete";
  const isRename = dialog?.kind === "rename";
  const title =
    dialog?.kind === "create"
      ? "New Note"
      : isRename
        ? "Rename note"
        : dialog?.kind === "tag"
          ? "Add Tag"
          : "Delete Note";
  const inputEl =
    dialog !== null && dialog.kind !== "delete"
      ? input(title, dialog.kind === "tag" ? dialog.value : dialog.title)
      : null;
  const localDraft = dialog?.kind === "create"
    ? state.tabs.find((tab) => tab.kind === "local-draft" && tab.localDraftId === dialog.localDraftId)
    : undefined;
  const promotionPending = localDraft?.kind === "local-draft" && localDraft.session?.state.promotionPending === true;
  if (inputEl !== null && promotionPending) inputEl.disabled = true;
  const panel = el(
    "form",
    `modal-panel note-dialog-panel${isRename ? " is-rename" : ""}`,
    el(
      "div",
      "modal-header",
      span(title),
      ...(isRename ? [] : [button("×", "Close", () => actions.dispatch({ type: "overlay.close" }), "tab-close")]),
    ),
  );
  if (isDelete) {
    const note = state.notes.get(dialog.noteId);
    panel.append(
      el("p", "dialog-copy", `Move ${note?.path ?? "this note"} to trash?`),
      el(
        "div",
        "modal-actions",
        button(
          "Cancel",
          "Cancel",
          () => actions.dispatch({ type: "overlay.close" }),
          "text-button",
        ),
        button(
          "Delete",
          "Delete note",
          () => actions.dispatch({ type: "dialog.submit" }),
          "danger-button",
        ),
      ),
    );
  } else if (inputEl !== null) {
    const label = el("label", `field-label${isRename ? " rename-field-label" : ""}`, span(dialog?.kind === "tag" ? "Tag" : "Title"));
    if (isRename) {
      inputEl.id = "rename-note-title";
      label.htmlFor = inputEl.id;
    } else {
      label.append(inputEl);
    }
    inputEl.addEventListener("input", () => {
      actions.dispatch({ type: "dialog.input", value: inputEl.value });
    });
    const cancel = button(
      "Cancel",
      "Cancel",
      () => actions.dispatch({ type: "overlay.close" }),
      isRename ? "rename-cancel-button" : "text-button",
    );
    cancel.disabled = promotionPending;
    const submit = button(
      dialog?.kind === "create" ? (promotionPending ? "Retry create" : "Create") : dialog?.kind === "rename" ? "Rename" : "Add",
      title,
      () => actions.dispatch({ type: "dialog.submit", value: inputEl.value }),
      isRename ? "primary-button rename-submit-button" : "primary-button",
    );
    panel.append(label);
    if (isRename) panel.append(inputEl);
    panel.append(el("div", `modal-actions${isRename ? " rename-actions" : ""}`, cancel, submit));
    panel.addEventListener("submit", (event) => {
      event.preventDefault();
      actions.dispatch({ type: "dialog.submit", value: inputEl.value });
    });
    queueMicrotask(() => {
      inputEl.focus();
      if (isRename) inputEl.select();
    });
  }
  return panel;
}

function renderContextMenu(state: State, actions: ViewActions): HTMLElement {
  const menu = el("div", "context-menu");
  const context = state.contextMenu;
  if (context === null) {
    return menu;
  }
  menu.style.left = `${context.x}px`;
  menu.style.top = `${context.y}px`;
  const pinned = state.pinned.has(context.noteId);
  menu.append(
    button(
      "Rename",
      "Rename note",
      () => {
        actions.dispatch({ type: "note.rename", noteId: toNoteId(context.noteId) });
        actions.dispatch({ type: "context.close" });
      },
      "context-menu-item",
    ),
    button(
      pinned ? "Unpin" : "Pin",
      pinned ? "Unpin note" : "Pin note",
      () => {
        actions.dispatch({ type: "note.pin", noteId: toNoteId(context.noteId) });
        actions.dispatch({ type: "context.close" });
      },
      "context-menu-item",
    ),
    button(
      "Delete",
      "Delete note",
      () => {
        actions.dispatch({ type: "note.delete", noteId: toNoteId(context.noteId) });
        actions.dispatch({ type: "context.close" });
      },
      "context-menu-item danger",
    ),
  );
  return menu;
}

function searchHitRow(hit: V2SearchHit, actions: ViewActions): HTMLElement {
  const identity = hit.identity;
  if (identity.kind === "newLocalDraft") {
    const row = button(
      "",
      hit.path || hit.title,
      () => actions.dispatch({ type: "search.hitOpen", hit }),
      "command-row search-result-row local-search-result",
    );
    row.dataset["key"] = `local-draft:${identity.localId}`;
    row.append(span(hit.title), renderSnippet(hit));
    return row;
  }
  const row = button(
    "",
    hit.path,
    () => actions.dispatch({ type: "search.hitOpen", hit }),
    "note-row command-row search-result-row",
  );
  row.dataset["key"] = `search:${identity.kind}:${identity.noteId}`;
  row.append(span(hit.title, "search-result-title"), span(hit.path, "search-result-path"));
  row.append(renderScore(hit), renderSnippet(hit));
  return row;
}

function draftCoverageMessage(coverage: V2OverlayCoverage | null): HTMLElement | null {
  if (coverage?.status !== "partial") return null;
  const count = coverage.skippedNoteCount;
  return span(`Draft search skipped ${count} ${count === 1 ? "draft" : "drafts"}`, "empty-outline");
}

function quickOpenHitRow(
  hit: V2QuickOpenResponse["hits"][number],
  actions: ViewActions,
  query: string,
  selected: boolean,
): HTMLElement {
  const row = button(
    "",
    hit.title,
    () => actions.dispatch({ type: "quickOpen.hitOpen", hit }),
    "command-row search-result-row",
  );
  row.dataset["key"] = `quick-open:${hit.noteId}`;
  row.dataset["noteId"] = hit.noteId;
  if (selected) row.classList.add("selected");
  row.append(span(hit.title, "recent-note-title"));
  const preview = query.trim() === "" ? actions.recentPreview(hit.noteId) : null;
  const detail = preview === null || preview === "" ? hit.path : preview;
  if (detail !== null && detail !== "") row.append(span(detail, "recent-note-detail"));
  return row;
}

function renderScore(hit: V2SearchHit): HTMLElement {
  return el("span", "search-score", hit.score.toPrecision(3));
}

function renderSnippet(hit: V2SearchHit): HTMLElement {
  const element = el("span", "search-snippet");
  const { text, ranges } = searchSnippetContext(hit);
  let offset = 0;
  for (const range of ranges) {
    if (range.startUtf16 < offset || range.endUtf16 > text.length) {
      continue;
    }
    element.append(document.createTextNode(text.slice(offset, range.startUtf16)));
    element.append(el("mark", "", text.slice(range.startUtf16, range.endUtf16)));
    offset = range.endUtf16;
  }
  element.append(document.createTextNode(text.slice(offset)));
  return element;
}

function searchSnippetContext(hit: V2SearchHit): {
  text: string;
  ranges: V2SearchHit["excerptRanges"];
} {
  const source = hit.excerpt;
  const firstLineBreak = /\r?\n/.exec(source);
  let start = 0;
  if (firstLineBreak !== null) {
    const headingEnd = firstLineBreak.index;
    const heading = source.slice(0, headingEnd).replace(/^…/, "").trim().replace(/^#{1,6}\s+/, "");
    if (heading === hit.title) {
      start = headingEnd + firstLineBreak[0].length;
      while (source[start] === "\n" || source[start] === "\r") start += 1;
    }
  }

  const firstMatch = hit.excerptRanges.find((range) => range.startUtf16 >= start);
  if (firstMatch !== undefined) {
    const paragraphSeparators = [...source.slice(start, firstMatch.startUtf16).matchAll(/\r?\n[ \t]*\r?\n/g)];
    const lastSeparator = paragraphSeparators.at(-1);
    if (lastSeparator !== undefined) {
      start += lastSeparator.index + lastSeparator[0].length;
    }
    const afterMatch = source.slice(firstMatch.endUtf16);
    const separator = /\r?\n[ \t]*\r?\n/.exec(afterMatch);
    if (separator !== null) {
      const end = firstMatch.endUtf16 + separator.index;
      return normalizeSnippet(source, hit.excerptRanges, start, end);
    }
  }
  return normalizeSnippet(source, hit.excerptRanges, start, source.length);
}

function normalizeSnippet(
  source: string,
  ranges: V2SearchHit["excerptRanges"],
  start: number,
  end: number,
): {
  text: string;
  ranges: V2SearchHit["excerptRanges"];
} {
  const original = source.slice(start, end);
  const offsets = Array.from<number | undefined>({ length: original.length + 1 });
  let text = "";
  let index = 0;
  while (index < original.length) {
    if (original[index] === "\n" || original[index] === "\r") {
      const lineBreakStart = index;
      while (original[index] === "\n" || original[index] === "\r") index += 1;
      if (text.length > 0 && !text.endsWith("\n")) text += "\n";
      for (let offset = lineBreakStart; offset <= index; offset += 1) offsets[offset] = text.length;
    } else {
      offsets[index] = text.length;
      text += original[index];
      index += 1;
      offsets[index] = text.length;
    }
  }
  offsets[original.length] = text.length;
  const normalizedRanges = ranges
    .filter((range) => range.startUtf16 >= start && range.endUtf16 <= end)
    .map((range) => ({
      startUtf16: offsets[range.startUtf16 - start] ?? 0,
      endUtf16: offsets[range.endUtf16 - start] ?? text.length,
    }));
  return { text, ranges: normalizedRanges };
}

function input(
  title: string,
  value: string,
  type = "text",
  min?: string,
  max?: string,
  step?: string,
): HTMLInputElement {
  const element = document.createElement("input");
  element.className = "settings-input";
  element.title = title;
  element.type = type;
  element.value = value;
  if (min !== undefined) element.min = min;
  if (max !== undefined) element.max = max;
  if (step !== undefined) element.step = step;
  return element;
}

function diffPreview(current: string, revision: string): string {
  const currentLines = current.split("\n");
  const revisionLines = revision.split("\n");
  const out = ["Revision preview", ""];
  for (let i = 0; i < Math.max(currentLines.length, revisionLines.length); i += 1) {
    if (currentLines[i] === revisionLines[i]) {
      continue;
    }
    if (revisionLines[i] !== undefined) out.push(`+ ${revisionLines[i]}`);
    if (currentLines[i] !== undefined) out.push(`- ${currentLines[i]}`);
    if (out.length > 80) break;
  }
  return out.join("\n");
}

function emptyState(actions: ViewActions): HTMLElement {
  return el(
    "div",
    "empty-state",
    el("div", "empty-title", "No note selected"),
    button(
      "New note",
      "New note",
      () => actions.dispatch({ type: "command.run", id: "create" }),
      "primary-button",
    ),
  );
}

function renderTagRow(tab: Tab, actions: ViewActions, readonly = false): HTMLElement {
  const row = el("div", "tag-row");
  if (tab.kind !== "saved" || tab.doc === null) {
    return row;
  }
  const supported = frontmatterSupportsTags(tab.draft ?? tab.doc.content);
  for (const tag of tab.doc.meta.tags) {
    const tagButton = button(
      `#${tag} x`,
      `Remove ${tag}`,
      () => {
        actions.dispatch({
          type: "tags.update",
          tags: tab.doc?.meta.tags.filter((item) => item !== tag) ?? [],
        });
      },
      "tag",
    );
    tagButton.disabled = readonly || !supported;
    row.append(tagButton);
  }
  const add = button(
    "+ tag",
    "Add tag",
    () => actions.dispatch({ type: "note.addTag" }),
    "tag tag-add",
  );
  add.disabled = readonly || !supported;
  if (!readonly) {
    row.append(add);
  }
  if (!supported) {
    row.append(span("Tags locked", "tag-disabled"));
  }
  return row;
}

function noteList(state: State, ids: string[], actions: ViewActions): HTMLElement {
  const list = el("div", "note-list");
  const seen = new Set<string>();
  for (const noteId of ids) {
    if (seen.has(noteId)) {
      continue;
    }
    seen.add(noteId);
    const note = state.notes.get(noteId);
    if (note === undefined) {
      continue;
    }
    const row = button(
      note.title,
      note.path,
      () => actions.dispatch({ type: "note.open", noteId: toNoteId(note.noteId) }),
      state.activeTab?.kind === "saved" && state.activeTab.noteId === note.noteId
        ? "note-row active"
        : "note-row",
    );
    row.dataset["key"] = `note:${note.noteId}`;
    row.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      actions.dispatch({
        type: "context.open",
        noteId: toNoteId(note.noteId),
        x: event.clientX,
        y: event.clientY,
      });
    });
    list.append(row);
  }
  return list;
}

function recentNoteIds(state: State): string[] {
  const ids = new Set(state.recent);
  return [...state.recent, ...[...state.notes.keys()].filter((noteId) => !ids.has(noteId))];
}

function section(title: string, body: HTMLElement): HTMLElement {
  return el("section", "sidebar-section", el("h2", "section-title", title), body);
}

function closeButton(tab: TabIdentity, actions: ViewActions, beforeClose?: () => void): HTMLElement {
  return button(
    "×",
    "Close",
    (event) => {
      event.stopPropagation();
      beforeClose?.();
      actions.dispatch({ type: "tab.close", tab });
    },
    "tab-close",
  );
}

function bindTabCloseHint(
  tabEl: HTMLButtonElement,
  closeHint: HTMLElement,
  tab: TabIdentity,
  actions: ViewActions,
): () => void {
  let observer: MutationObserver | null = null;
  function positionHint(event: MouseEvent) {
    closeHint.style.left = `${event.clientX}px`;
    closeHint.style.top = `${event.clientY}px`;
  }
  function stopCloseShortcut() {
    window.removeEventListener("keydown", closeOnX, { capture: true });
  }
  function hideCloseHint() {
    closeHint.classList.remove("visible");
    closeHint.remove();
    stopCloseShortcut();
    observer?.disconnect();
    observer = null;
  }
  function closeOnX(event: KeyboardEvent) {
    if (
      event.key.toLowerCase() !== "x" ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey ||
      event.isComposing
    ) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    hideCloseHint();
    actions.dispatch({ type: "tab.close", tab });
  }
  tabEl.addEventListener("mouseenter", (event) => {
    document.body.append(closeHint);
    positionHint(event);
    closeHint.classList.add("visible");
    window.addEventListener("keydown", closeOnX, { capture: true });
    observer?.disconnect();
    observer = new MutationObserver(() => {
      if (!tabEl.isConnected) {
        hideCloseHint();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });
  tabEl.addEventListener("mousemove", positionHint);
  tabEl.addEventListener("mouseleave", hideCloseHint);
  return hideCloseHint;
}

type ToolIcon =
  | "bold"
  | "italic"
  | "strikethrough"
  | "highlight"
  | "heading"
  | "undo"
  | "redo"
  | "code"
  | "save"
  | "eye"
  | "eyeOff";

function toolButton(iconName: ToolIcon, title: string, onClick: (event: MouseEvent) => void) {
  const element = button("", title, onClick, "tool-button");
  element.ariaLabel = title;
  element.append(toolIcon(iconName));
  return element;
}

function toolIcon(iconName: ToolIcon): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  for (const child of iconPaths(iconName)) {
    svg.append(child);
  }
  return svg;
}

function iconPaths(iconName: ToolIcon): SVGElement[] {
  switch (iconName) {
    case "bold": {
      return [iconPath("M8 5h5a3 3 0 0 1 0 6H8zM8 11h6a4 4 0 0 1 0 8H8zM8 5v14")];
    }
    case "italic": {
      return [iconPath("M10 5h7M7 19h7M14 5l-4 14")];
    }
    case "strikethrough": {
      return [
        iconPath("M7 7.5A4 4 0 0 1 11 5h5M8 17a5 5 0 0 0 4 2h1.5a3.5 3.5 0 0 0 0-7H6M5 12h14"),
      ];
    }
    case "highlight": {
      return [
        iconShape("path", {
          d: "M7 18.5h4.5L20 10l-2.8-2.8-11.7 9.3z",
          fill: "#ffe16a",
          stroke: "none",
        }),
        iconPath("M14 4l6 6-8.5 8.5H7.5l-2-2z", "#d88b18"),
        iconPath("M5 20h11", "#d88b18"),
      ];
    }
    case "heading": {
      return [iconPath("M6 5v14M18 5v14M6 12h12M14 19h7")];
    }
    case "undo": {
      return [iconPath("M9 7l-5 5 5 5M4 12h10a5 5 0 1 1-3.5 8.5")];
    }
    case "redo": {
      return [iconPath("M15 7l5 5-5 5M20 12H10a5 5 0 1 0 3.5 8.5")];
    }
    case "code": {
      return [iconPath("M9 7l-5 5 5 5M15 7l5 5-5 5")];
    }
    case "save": {
      return [
        iconShape("rect", { x: "9", y: "15", width: "6", height: "5", fill: "#dfe7f2" }),
        iconPath("M5 4h12l2 2v14H5zM8 4v6h8V4M8 20v-6h8v6"),
      ];
    }
    case "eye": {
      return [
        iconPath("M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6z"),
        iconPath("M12 9.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5z"),
      ];
    }
    case "eyeOff": {
      return [
        iconPath("M3 3l18 18"),
        iconPath("M10.7 5.2A10.7 10.7 0 0 1 12 5c6 0 9.5 7 9.5 7a17.8 17.8 0 0 1-3.2 4.1"),
        iconPath("M6.5 6.9A17.6 17.6 0 0 0 2.5 12s3.5 7 9.5 7c1.7 0 3.2-.4 4.5-1"),
      ];
    }
  }
}

function iconPath(d: string, stroke = "currentColor"): SVGPathElement {
  return iconShape("path", {
    d,
    fill: "none",
    stroke,
    "stroke-width": "1.8",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
  }) as SVGPathElement;
}

function iconShape<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attributes: Record<string, string>,
): SVGElementTagNameMap[K] {
  const element = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [key, value] of Object.entries(attributes)) {
    element.setAttribute(key, value);
  }
  return element;
}
