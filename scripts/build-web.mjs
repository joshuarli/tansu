import esbuild from "esbuild";
import { solidPlugin } from "esbuild-plugin-solid";

const mode = process.argv[2] === "production" ? "production" : "development";

await esbuild.build({
  entryPoints: ["web/ts/main.tsx"],
  bundle: true,
  outfile: "web/static/app.js",
  format: "esm",
  minify: mode === "production",
  define: {
    "process.env.NODE_ENV": JSON.stringify(mode),
  },
  plugins: [solidPlugin()],
});
