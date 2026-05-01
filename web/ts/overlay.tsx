import type { JSX } from "solid-js";

type OverlayFrameProps = {
  id: string;
  isOpen: boolean;
  onClose: () => void;
  class?: string | undefined;
  children: JSX.Element;
};

export function OverlayFrame(props: Readonly<OverlayFrameProps>) {
  return (
    <div
      id={props.id}
      class={props.class}
      hidden={!props.isOpen}
      style={props.isOpen ? undefined : { display: "none" }}
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
