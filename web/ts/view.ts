import type { CommandItem, ViewEvent } from "./app/events.ts";
import { button, el, span } from "./dom.ts";
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
import { excludedFoldersProblem, normalizeSettings, SETTINGS_LIMITS } from "./app/settings-policy.ts";
import { sameTabIdentity, type TabIdentity } from "./app/tab-identity.ts";
import type { V2OverlayCoverage, V2SearchHit } from "./types.generated.ts";
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
  const main = renderMain(state, actions);
  const overlays = renderOverlays(state, actions);
  main.dataset["viewRegion"] = "main";
  overlays.dataset["viewRegion"] = "overlays";
  return [main, overlays];
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
  const preserveInputValue = current instanceof HTMLInputElement &&
    current.dataset["preserveValue"] !== undefined && current.value !== current.defaultValue;
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
    if (!preserveInputValue && current.value !== next.value) current.value = next.value;
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

function renderVaultPicker(state: State, actions: ViewActions): HTMLElement {
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
  const vaultControl = el("div", "vault-control floating-vault-control", vaultLabel, vaultSelect, vaultOptions);
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
  return vaultControl;
}

function renderFloatingControls(state: State, actions: ViewActions): HTMLElement {
  const readingButton = button(
    "",
    state.readingMode ? "Switch to edit mode" : "Switch to reading mode",
    (event) => {
      event.stopPropagation();
      actions.dispatch({ type: "reading.toggle" });
    },
    "floating-control-button reading-mode-toggle",
  );
  readingButton.setAttribute("aria-label", readingButton.title);
  readingButton.setAttribute("aria-pressed", String(state.readingMode));
  readingButton.append(controlIcon([
    "M12 7v14",
    "M3 5.5A2.5 2.5 0 0 1 5.5 3H12v18H5.5A2.5 2.5 0 0 1 3 18.5z",
    "M21 5.5A2.5 2.5 0 0 0 18.5 3H12v18h6.5a2.5 2.5 0 0 0 2.5-2.5z",
  ]));

  const themeIsDark = state.theme === "dark";
  const themeButton = button(
    "",
    themeIsDark ? "Switch to light mode" : "Switch to dark mode",
    (event) => {
      event.stopPropagation();
      actions.dispatch({ type: "theme.toggle" });
    },
    "floating-control-button theme-toggle",
  );
  themeButton.setAttribute("aria-label", themeButton.title);
  themeButton.setAttribute("aria-pressed", String(themeIsDark));
  themeButton.append(controlIcon(themeIsDark
    ? ["M12 3v2", "M12 19v2", "M5.64 5.64l1.42 1.42", "M16.94 16.94l1.42 1.42", "M3 12h2", "M19 12h2", "M5.64 18.36l1.42-1.42", "M16.94 7.06l1.42-1.42", "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z"]
    : ["M20.9 13A9 9 0 1 1 11 3.1 7 7 0 0 0 20.9 13z"]));

  return el("div", "floating-controls", renderVaultPicker(state, actions), readingButton, themeButton);
}

function controlIcon(paths: string[]): SVGSVGElement {
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("aria-hidden", "true");
  icon.setAttribute("focusable", "false");
  for (const pathData of paths) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", pathData);
    icon.append(path);
  }
  return icon;
}

function renderNoteOutline(state: State, actions: ViewActions): HTMLElement | null {
  const active = activeTab(state);
  if (active === undefined || loadedDraft(active) === null) return null;
  const outline = actions.outline();
  if (outline.headings.length === 0) return null;
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
  const aside = el("aside", "note-outline", outlineList);
  aside.setAttribute("aria-label", "Note outline");
  return aside;
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
  const create = button(
    "+",
    "New note",
    () => actions.dispatch({ type: "command.run", id: "create" }),
    "icon-button new-note",
  );
  const topbar = el("div", "topbar", el("div", "tab-strip", tabs, create));
  const findBar = state.findOpen ? renderFindBar(state, actions) : null;
  const workspace = el("section", "workspace");
  if (active === undefined) {
    workspace.append(emptyState(), renderEditorMount(true));
  } else if (loadedDraft(active) === null) {
    workspace.append(renderDocumentTitle(active));
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
    workspace.append(renderEditorMount(false));
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
  main.append(topbar);
  main.append(workspace, renderStatusBar(state));
  main.append(renderFloatingControls(state, actions));
  const outline = renderNoteOutline(state, actions);
  if (outline !== null) {
    main.classList.add("has-note-outline");
    main.append(outline);
  }
  if (findBar !== null) main.append(findBar);
  return main;
}

function renderDocumentTitle(tab: Tab): HTMLElement {
  const title = el("h1", "document-title", tab.title);
  title.dataset["key"] = `document-title:${tab.key}`;
  return title;
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
    const panel = el("div", "command-panel command-palette-panel", field, list);
    panel.dataset["key"] = "modal:command";
    host.append(backdrop(actions), panel);
    focusOnOpen(input);
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
    const list = el("div", "command-list search-result-list");
    list.dataset["key"] = "search-results";
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") actions.dispatch({ type: "search.overlaySubmit" });
    });
    const query = state.searchOverlayQuery.trim();
    const recentNotes = recentNoteIds(state).flatMap((noteId) => {
      const note = state.notes.get(noteId);
      return note === undefined ? [] : [note];
    });
    if (query !== "") {
      const hits = state.searchOverlayHits ?? [];
      for (const hit of hits) {
        list.append(searchHitRow(hit, actions, state));
      }
      if (state.searchOverlayHits === null) list.append(span("Searching…", "search-status"));
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
    } else {
      for (const [index, note] of recentNotes.entries()) {
        const row = button(
          "",
          note.path,
          () => actions.dispatch({ type: "search.recentOpen", noteId: toNoteId(note.noteId) }),
          "command-row search-result-row recent-search-result",
        );
        row.dataset["key"] = `search-recent:${note.noteId}`;
        row.dataset["noteId"] = note.noteId;
        if (index === 0) row.classList.add("selected");
        row.addEventListener("contextmenu", (event) => {
          event.preventDefault();
          actions.dispatch({
            type: "context.open",
            noteId: toNoteId(note.noteId),
            x: event.clientX,
            y: event.clientY,
          });
        });
        row.append(searchResultHeading(note.title, note.updatedAtMs));
        row.append(span(actions.recentPreview(note.noteId) ?? note.path, "recent-note-detail"));
        list.append(row);
      }
      if (recentNotes.length === 0) list.append(span("No notes in this vault yet.", "search-status"));
      if (state.searchHistory.length > 0) {
        list.append(el("div", "search-history-heading", "Recent searches"));
        for (const query of state.searchHistory) {
          list.append(button(query, `Search for ${query}`, () => actions.dispatch({ type: "search.historySelect", query }), "search-history-row"));
        }
      }
    }
    const searchField = el("div", "search-field", span("", "search-icon"), input);
    searchField.dataset["key"] = "search-field";
    const panel = el(
      "div",
      "command-panel search-panel",
      searchField,
      list,
    );
    panel.dataset["key"] = "modal:search";
    host.append(backdrop(actions), panel);
    focusOnOpen(input);
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
  element.dataset["key"] = "overlay-backdrop";
  element.addEventListener("click", () => actions.dispatch({ type: "overlay.close" }));
  return element;
}

function focusOnOpen(input: HTMLInputElement, select = false): void {
  queueMicrotask(() => {
    if (!input.isConnected || document.activeElement === input) return;
    input.focus();
    if (select) input.select();
  });
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
  const panel = el(
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
  panel.dataset["key"] = "modal:revisions";
  return panel;
}

function renderConflictPanel(state: State, actions: ViewActions): HTMLElement {
  const draft = state.conflictDraft;
  const panel = el(
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
  panel.dataset["key"] = "modal:conflict";
  return panel;
}

function renderSettingsPanel(state: State, actions: ViewActions): HTMLElement {
  const settings = normalizeSettings(state.boot!.settings);
  const excluded = input("Excluded folders", settings.excludedFolders.join(", "));
  const { autosaveDelayMs, undoStackMax, imageWebpQuality } = SETTINGS_LIMITS;
  const autosave = input("Autosave delay", String(settings.autosaveDelayMs), "number", String(autosaveDelayMs.min), String(autosaveDelayMs.max));
  const undo = input("Undo stack", String(settings.undoStackMax), "number", String(undoStackMax.min), String(undoStackMax.max));
  const quality = input(
    "Image quality",
    String(settings.imageWebpQuality),
    "number",
    String(imageWebpQuality.min),
    String(imageWebpQuality.max),
    String(imageWebpQuality.step),
  );
  for (const field of [excluded, autosave, undo, quality]) {
    field.dataset["preserveValue"] = "";
  }
  const formError = el("p", "settings-error", "");
  formError.setAttribute("role", "alert");
  const appSettings = el("a", "text-button", span("Manage vaults and authentication"));
  appSettings.setAttribute("href", "/setup");
  const panel = el(
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
    formError,
    appSettings,
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
          const problem = excludedFoldersProblem(excluded.value);
          formError.textContent = problem ?? "";
          if (problem !== null) return;
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
  panel.dataset["key"] = "modal:settings";
  return panel;
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
  if (inputEl !== null) inputEl.dataset["key"] = `note-dialog-input:${dialog?.kind ?? "delete"}`;
  const isCreate = dialog?.kind === "create";
  const isTag = dialog?.kind === "tag";
  const isCompact = isCreate || isTag;
  const fieldLabel = isTag ? "Tag" : "Note title";
  if (inputEl !== null && isCompact) inputEl.placeholder = isTag ? "Add tag" : "Note title";
  const close = () => actions.dispatch({ type: "overlay.close" });
  const panel = el(
    "form",
    `modal-panel note-dialog-panel${isCompact ? " is-create" : ""}${isTag ? " is-tag" : ""}${isRename ? " is-rename" : ""}`,
    ...(isCompact
      ? []
      : [el(
        "div",
        "modal-header",
        span(title),
        ...(isRename ? [] : [button("×", "Close", close, "tab-close")]),
      )]),
  );
  const dialogKey = dialog === null
    ? "delete"
    : dialog.kind === "rename" || dialog.kind === "delete"
    ? `${dialog.kind}:${dialog.noteId}`
    : dialog.kind === "create"
    ? `create:${dialog.localDraftId}`
    : "tag";
  panel.dataset["key"] = `modal:note:${dialogKey}`;
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
  } else if (inputEl !== null && isCompact) {
    inputEl.setAttribute("aria-label", fieldLabel);
    inputEl.addEventListener("input", () => {
      actions.dispatch({ type: "dialog.input", value: inputEl.value });
    });
    panel.append(el("div", "note-dialog-field", inputEl, button("×", "Close", close, "tab-close")));
    panel.addEventListener("submit", (event) => {
      event.preventDefault();
      actions.dispatch({ type: "dialog.submit", value: inputEl.value });
    });
    focusOnOpen(inputEl);
  } else if (inputEl !== null) {
    const label = el("label", "field-label rename-field-label", span("Title"));
    inputEl.id = "rename-note-title";
    label.htmlFor = inputEl.id;
    inputEl.addEventListener("input", () => {
      actions.dispatch({ type: "dialog.input", value: inputEl.value });
    });
    const cancel = button(
      "Cancel",
      "Cancel",
      () => actions.dispatch({ type: "overlay.close" }),
      "rename-cancel-button",
    );
    const submit = button(
      "Rename",
      title,
      () => actions.dispatch({ type: "dialog.submit", value: inputEl.value }),
      "primary-button rename-submit-button",
    );
    panel.append(label, inputEl, el("div", "modal-actions rename-actions", cancel, submit));
    panel.addEventListener("submit", (event) => {
      event.preventDefault();
      actions.dispatch({ type: "dialog.submit", value: inputEl.value });
    });
    focusOnOpen(inputEl, true);
  }
  return panel;
}

function renderContextMenu(state: State, actions: ViewActions): HTMLElement {
  const menu = el("div", "context-menu");
  menu.dataset["key"] = "context-menu";
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

function searchHitRow(hit: V2SearchHit, actions: ViewActions, state: State): HTMLElement {
  const identity = hit.identity;
  const updatedAtMs = searchHitUpdatedAtMs(identity, state);
  if (identity.kind === "newLocalDraft") {
    const row = button(
      "",
      hit.path || hit.title,
      () => actions.dispatch({ type: "search.hitOpen", hit }),
      "command-row search-result-row local-search-result",
    );
    row.dataset["key"] = `local-draft:${identity.localId}`;
    row.append(searchResultHeading(hit.title, updatedAtMs), renderSnippet(hit));
    return row;
  }
  const row = button(
    "",
    hit.path,
    () => actions.dispatch({ type: "search.hitOpen", hit }),
    "command-row search-result-row",
  );
  row.dataset["key"] = `search:${identity.kind}:${identity.noteId}`;
  row.append(searchResultHeading(hit.title, updatedAtMs), span(hit.path, "search-result-path"));
  row.append(renderScore(hit), renderSnippet(hit));
  return row;
}

function searchHitUpdatedAtMs(identity: V2SearchHit["identity"], state: State): number {
  if (identity.kind === "newLocalDraft") {
    const tab = state.tabs.find((candidate) =>
      candidate.kind === "local-draft" && candidate.localDraftId === identity.localId
    );
    return tab?.kind === "local-draft" ? tab.session?.state.updatedAtMs ?? Date.now() : Date.now();
  }
  const tab = state.tabs.find((candidate) => candidate.kind === "saved" && candidate.noteId === identity.noteId);
  return state.notes.get(identity.noteId)?.updatedAtMs ?? tab?.doc?.meta.updatedAtMs ?? Date.now();
}

function searchResultHeading(title: string, updatedAtMs: number): HTMLElement {
  return el("div", "search-result-heading", span(title, "search-result-title"), renderNoteAge(updatedAtMs));
}

function renderNoteAge(updatedAtMs: number): HTMLElement {
  const elapsed = Math.max(1000, Date.now() - updatedAtMs);
  const units = [
    { label: "y", name: "year", milliseconds: 365 * 24 * 60 * 60 * 1000 },
    { label: "mo", name: "month", milliseconds: 30 * 24 * 60 * 60 * 1000 },
    { label: "w", name: "week", milliseconds: 7 * 24 * 60 * 60 * 1000 },
    { label: "d", name: "day", milliseconds: 24 * 60 * 60 * 1000 },
    { label: "h", name: "hour", milliseconds: 60 * 60 * 1000 },
    { label: "m", name: "minute", milliseconds: 60 * 1000 },
    { label: "s", name: "second", milliseconds: 1000 },
  ];
  let unitIndex = units.findIndex((unit) => elapsed >= unit.milliseconds);
  if (unitIndex === -1) unitIndex = units.length - 1;
  let unit = units[unitIndex]!;
  let amount = Math.max(1, Math.round(elapsed / unit.milliseconds));
  while (unitIndex > 0) {
    const nextUnit = units[unitIndex - 1]!;
    if (amount < Math.round(nextUnit.milliseconds / unit.milliseconds)) break;
    unit = nextUnit;
    unitIndex -= 1;
    amount = Math.max(1, Math.round(elapsed / unit.milliseconds));
  }
  const age = el("time", `note-age note-age-${unit.label}`, `${amount}${unit.label}`);
  const date = new Date(updatedAtMs);
  if (!Number.isNaN(date.valueOf())) age.dateTime = date.toISOString();
  age.setAttribute("aria-label", `${amount} ${unit.name}${amount === 1 ? "" : "s"} ago`);
  return age;
}

function draftCoverageMessage(coverage: V2OverlayCoverage | null): HTMLElement | null {
  if (coverage?.status !== "partial") return null;
  const count = coverage.skippedNoteCount;
  return span(`Draft search skipped ${count} ${count === 1 ? "draft" : "drafts"}`, "empty-outline");
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
  element.dataset["key"] = `field:${title}`;
  element.title = title;
  element.type = type;
  element.defaultValue = value;
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

function emptyState(): HTMLElement {
  return el("div", "empty-state", el("div", "empty-title", "No note selected"));
}

function recentNoteIds(state: State): string[] {
  const ids = new Set(state.recent);
  return [...state.recent, ...[...state.notes.keys()].filter((noteId) => !ids.has(noteId))];
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
