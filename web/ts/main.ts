import { startApp } from "./app.ts";
import { installClientLogCapture } from "./dev-log.ts";

const root = document.querySelector<HTMLElement>("#app");
if (root === null) {
  throw new Error("missing app root");
}

installClientLogCapture();
const skin = process.env["TANSU_SKIN"] ?? "default";
if (skin !== "default") {
  document.documentElement.dataset["skin"] = skin;
}
startApp(root);
