import { startApp } from "./app.ts";
import { installClientLogCapture } from "./dev-log.ts";

const root = document.querySelector<HTMLElement>("#app");
if (root === null) {
  throw new Error("missing app root");
}

installClientLogCapture();
if (process.env["TANSU_SKIN"] === "alembic") {
  document.documentElement.dataset["skin"] = "alembic";
  void import("./skin/alembic.ts").then(({ installAlembicSkin }) => {
    installAlembicSkin(root);
  });
}
startApp(root);
