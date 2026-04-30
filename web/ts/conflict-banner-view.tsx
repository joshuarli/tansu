import { forceSaveNote } from "./api.ts";
import { markClean } from "./tab-state.ts";

type ConflictBannerProps = {
  currentPath: string;
  diskContent: string;
  diskMtime: number;
  loadContent: (md: string) => void;
  getCurrentContent: () => string;
  onClose: () => void;
};

export function ConflictBanner(props: Readonly<ConflictBannerProps>) {
  return (
    <div class="conflict-banner">
      <span>File changed externally - conflicts detected.</span>
      <button
        onClick={() => {
          props.onClose();
          const content = props.getCurrentContent();
          void forceSaveNote(props.currentPath, content)
            .then((r) => markClean(props.currentPath, content, r.mtime))
            .catch(() => void 0);
        }}
      >
        Keep mine
      </button>
      <button
        onClick={() => {
          props.onClose();
          props.loadContent(props.diskContent);
          markClean(props.currentPath, props.diskContent, props.diskMtime);
        }}
      >
        Take theirs
      </button>
    </div>
  );
}
