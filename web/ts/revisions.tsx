import { computeDiff } from "@joshuarli98/md-wysiwyg";
import type { DiffHunk } from "@joshuarli98/md-wysiwyg";
import { For, Match, Show, Switch, createSignal } from "solid-js";
import { render } from "solid-js/web";

import { getRevision, listRevisions, restoreRevision } from "./api.ts";
import { DiffView } from "./DiffView.tsx";
import { restoreRevisionIntoEditor } from "./revision-events.ts";
import { relativeTime } from "./util.ts";

let hostEl: HTMLElement | null = null;
let currentPath: string | null = null;
let getContent: (() => string) | null = null;
let onHide: (() => void) | null = null;
let disposeRoot: (() => void) | null = null;

export type RevisionsOpts = {
  path: string;
  host: HTMLElement;
  getCurrentContent: () => string;
  onHide: () => void;
};

type RevisionState = {
  loading: boolean;
  error?: string;
  timestamps?: readonly number[];
  previewHunks?: DiffHunk[] | null;
};

type RevisionsPanelProps = {
  state: () => RevisionState;
  onClose: () => void;
  onRestore: (ts: number) => Promise<void>;
  onPreview: (ts: number) => Promise<void>;
};

function RevisionsBody(props: Readonly<RevisionsPanelProps>) {
  return (
    <Switch>
      <Match when={props.state().loading}>
        <div style={{ "font-size": "13px", color: "#57606a" }}>Loading...</div>
      </Match>
      <Match when={props.state().error}>
        <div style={{ "font-size": "13px", color: "#57606a" }}>{props.state().error}</div>
      </Match>
      <Match when={props.state().timestamps?.length === 0}>
        <div style={{ "font-size": "13px", color: "#57606a" }}>No revisions yet.</div>
      </Match>
      <Match when={true}>
        <>
          <For each={props.state().timestamps ?? []}>
            {(ts) => (
              <div class="revision-item" onClick={() => void props.onPreview(ts)}>
                <span>{relativeTime(ts)}</span>
                <span
                  class="restore-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    void props.onRestore(ts);
                  }}
                >
                  Restore
                </span>
              </div>
            )}
          </For>
          <Show when={props.state().previewHunks}>
            {(hunks) => <DiffView hunks={hunks()} class="revision-preview" />}
          </Show>
        </>
      </Match>
    </Switch>
  );
}

function RevisionsPanel(props: Readonly<RevisionsPanelProps>) {
  return (
    <>
      <div class="revisions-header">
        <span>Revisions</span>
        <span style={{ cursor: "pointer" }} onClick={props.onClose}>
          ×
        </span>
      </div>
      <RevisionsBody {...props} />
    </>
  );
}

export function toggleRevisions(opts: RevisionsOpts) {
  if (hostEl && currentPath === opts.path) {
    hideRevisions();
    return;
  }
  getContent = opts.getCurrentContent;
  ({ onHide } = opts);
  void showRevisions(opts.path, opts.host);
}

export function hideRevisions() {
  if (hostEl) {
    disposeRoot?.();
    disposeRoot = null;
    hostEl.textContent = "";
    hostEl = null;
    currentPath = null;
    onHide?.();
  }
}

export function isRevisionsOpen(): boolean {
  return hostEl !== null;
}

async function showRevisions(path: string, host: HTMLElement) {
  hideRevisions();
  currentPath = path;
  hostEl = host;

  const [state, setState] = createSignal<RevisionState>({ loading: true });

  const onRestore = async (ts: number) => {
    if (!confirm("Restore this revision? Current content will be saved as a new revision.")) {
      return;
    }
    const result = await restoreRevision(path, ts);
    const content = await getRevision(path, ts);
    restoreRevisionIntoEditor({ content, mtime: result.mtime });
    hideRevisions();
  };

  const onPreview = async (ts: number) => {
    const revContent = await getRevision(path, ts);
    if (hostEl !== host || currentPath !== path) return;
    const current = getContent ? getContent() : "";
    setState((s) => ({ ...s, previewHunks: computeDiff(current, revContent) }));
  };

  disposeRoot = render(
    () => (
      <RevisionsPanel
        state={state}
        onClose={hideRevisions}
        onRestore={onRestore}
        onPreview={onPreview}
      />
    ),
    hostEl,
  );

  try {
    const timestamps = await listRevisions(path);
    if (hostEl !== host || currentPath !== path) return;
    setState({ loading: false, timestamps });
  } catch {
    if (hostEl !== host || currentPath !== path) return;
    setState({ loading: false, error: "Failed to load revisions." });
  }
}
