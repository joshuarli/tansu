import { computeDiff, type DiffHunk } from "@joshuarli98/md-wysiwyg";
import { For, Match, Show, Switch, createSignal } from "solid-js";
import { render } from "solid-js/web";

import { getRevision, listRevisions, restoreRevision } from "./api.ts";
import { DiffView } from "./diff-view.tsx";
import { relativeTime } from "./util.ts";

import styles from "./editor-adjacent.module.css";

let hostEl: HTMLElement | null = null;
let currentPath: string | null = null;
let getContent: (() => string) | null = null;
let onHide: (() => void) | null = null;
let disposeRoot: (() => void) | null = null;

export type RevisionsOpts = {
  path: string;
  host: HTMLElement;
  getCurrentContent: () => string;
  onRestoreRevision: (content: string, mtime: number) => void;
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
              <div
                class={styles["revisionItem"]}
                data-ui="revision-item"
                onClick={() => void props.onPreview(ts)}
              >
                <span>{relativeTime(ts)}</span>
                <span
                  class={styles["restoreButton"]}
                  data-ui="restore-button"
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
          <Show when={props.state().previewHunks}>{(hunks) => <DiffView hunks={hunks()} />}</Show>
        </>
      </Match>
    </Switch>
  );
}

function RevisionsPanel(props: Readonly<RevisionsPanelProps>) {
  return (
    <>
      <div class={styles["revisionsHeader"]} data-ui="revisions-header">
        <span>Revisions</span>
        <span class={styles["revisionsClose"]} onClick={props.onClose}>
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
  void showRevisions(opts);
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

async function showRevisions(opts: RevisionsOpts) {
  const { path, host, onRestoreRevision } = opts;
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
    onRestoreRevision(content, result.mtime);
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
