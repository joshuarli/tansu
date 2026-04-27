import { computeDiff, renderDiff } from "@joshuarli98/md-wysiwyg";
import { render } from "solid-js/web";

import { getRevision, listRevisions, restoreRevision } from "./api.ts";
import { emit } from "./events.ts";
import { relativeTime } from "./util.ts";

let hostEl: HTMLElement | null = null;
let currentPath: string | null = null;
let getContent: (() => string) | null = null;
let onHide: (() => void) | null = null;
let disposeRoot: (() => void) | null = null;
const noopAsync = () => Promise.resolve();

export type RevisionsOpts = {
  path: string;
  host: HTMLElement;
  getCurrentContent: () => string;
  onHide: () => void;
};

type RevisionsPanelProps = {
  timestamps?: readonly number[];
  loading?: boolean;
  error?: string;
  previewEl?: HTMLElement | null;
  onClose: () => void;
  onRestore: (ts: number) => Promise<void>;
  onPreview: (ts: number) => Promise<void>;
};

function Preview(props: Readonly<{ element: HTMLElement }>) {
  return (
    <div
      ref={(host) => {
        queueMicrotask(() => {
          if (props.element.parentElement !== host) {
            host.textContent = "";
            host.append(props.element);
          }
        });
      }}
    />
  );
}

function RevisionsBody(props: Readonly<RevisionsPanelProps>) {
  if (props.loading) {
    return <div style={{ "font-size": "13px", color: "#57606a" }}>Loading...</div>;
  }
  if (props.error) {
    return <div style={{ "font-size": "13px", color: "#57606a" }}>{props.error}</div>;
  }
  if (props.timestamps && props.timestamps.length === 0) {
    return <div style={{ "font-size": "13px", color: "#57606a" }}>No revisions yet.</div>;
  }
  return (
    <>
      {props.timestamps?.map((ts) => (
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
      ))}
      {props.previewEl ? <Preview element={props.previewEl} /> : null}
    </>
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

function renderPanel(props: Readonly<RevisionsPanelProps>) {
  if (!hostEl) {
    return;
  }
  disposeRoot?.();
  disposeRoot = render(() => <RevisionsPanel {...props} />, hostEl);
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

  renderPanel({
    loading: true,
    onClose: hideRevisions,
    onRestore: noopAsync,
    onPreview: noopAsync,
  });

  try {
    const timestamps = await listRevisions(path);
    if (hostEl !== host || currentPath !== path) {
      return;
    }

    const renderList = (previewEl: HTMLElement | null = null) => {
      renderPanel({
        timestamps,
        previewEl,
        onClose: hideRevisions,
        onRestore: async (ts) => {
          if (!confirm("Restore this revision? Current content will be saved as a new revision.")) {
            return;
          }
          const result = await restoreRevision(path, ts);
          const content = await getRevision(path, ts);
          emit("revision:restore", { content, mtime: result.mtime });
          hideRevisions();
        },
        onPreview: async (ts) => {
          const revContent = await getRevision(path, ts);
          if (hostEl !== host || currentPath !== path) {
            return;
          }
          const current = getContent ? getContent() : "";
          const hunks = computeDiff(current, revContent);
          const diffEl = renderDiff(hunks);
          diffEl.classList.add("revision-preview");
          renderList(diffEl);
        },
      });
    };

    renderList();
  } catch {
    if (hostEl !== host || currentPath !== path) {
      return;
    }
    renderPanel({
      error: "Failed to load revisions.",
      onClose: hideRevisions,
      onRestore: noopAsync,
      onPreview: noopAsync,
    });
  }
}
