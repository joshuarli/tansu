import { ErrorBoundary } from "solid-js";

import { TabBarShell } from "./tabs.tsx";

export function App() {
  return (
    <ErrorBoundary
      fallback={
        <div style={{ "font-family": "sans-serif", padding: "2rem" }}>
          Something went wrong. Please reload the page.
        </div>
      }
    >
      <div id="sidebar">
        <div id="sidebar-header">
          <input
            id="sidebar-search"
            type="text"
            placeholder="Filter files..."
            aria-label="Filter files"
            autocomplete="off"
            spellcheck={false}
          />
          <button id="sidebar-collapse" title="Collapse sidebar" aria-label="Collapse sidebar">
            &#x2039;
          </button>
        </div>
        <div id="vault-switcher"></div>
        <div id="sidebar-tree"></div>
      </div>
      <div id="app-main">
        <div
          id="notification"
          class="notification hidden"
          aria-live="assertive"
          aria-atomic="true"
        ></div>
        <div id="tab-bar">
          <TabBarShell />
        </div>
        <div id="server-status" class="server-status hidden" aria-live="polite"></div>
        <div id="editor-area">
          <div id="empty-state">
            Press <kbd>Cmd+K</kbd> to search &middot; <kbd>Cmd+P</kbd> for commands
          </div>
        </div>
      </div>
      <div id="search-overlay" class="hidden">
        <div id="search-modal">
          <input
            id="search-input"
            type="text"
            placeholder="Search notes..."
            autocomplete="off"
            spellcheck={false}
          />
          <div id="search-results"></div>
        </div>
      </div>
      <div id="settings-overlay" class="hidden">
        <div id="settings-panel" role="dialog" aria-modal="true" aria-label="Settings"></div>
      </div>
      <div id="input-dialog-overlay" class="hidden"></div>
      <div id="palette-overlay" class="hidden">
        <div id="palette-modal">
          <input
            id="palette-input"
            type="text"
            placeholder="Type a command..."
            autocomplete="off"
            spellcheck={false}
          />
          <div id="palette-list"></div>
        </div>
      </div>
    </ErrorBoundary>
  );
}
