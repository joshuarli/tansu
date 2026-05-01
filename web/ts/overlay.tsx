import type { JSX } from "solid-js";

type OverlayFrameProps = {
  id: string;
  isOpen: boolean;
  onClose: () => void;
  children: JSX.Element;
};

export function OverlayFrame(props: Readonly<OverlayFrameProps>) {
  return (
    <div
      id={props.id}
      class={props.isOpen ? "" : "hidden"}
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          props.onClose();
        }
      }}
    >
      {props.children}
    </div>
  );
}
