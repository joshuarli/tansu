import { render } from "solid-js/web";

import { App } from "./app.tsx";

const root = document.querySelector("#app");
if (!(root instanceof HTMLElement)) {
  throw new Error("missing #app root");
}

render(App, root);
