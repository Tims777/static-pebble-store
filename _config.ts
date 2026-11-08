import lume from "lume/mod.ts";
import { walk } from "lume/deps/fs.ts";
import { toFileUrl } from "lume/deps/path.ts";
import { normalizePath } from "lume/core/utils/path.ts";
import pebbleStore from "./store.ts";

const appHost = Deno.env.get("HOST");
if (!appHost) {
  throw new Error("HOST environment variable must be defined at build time.");
}
const location = new URL(appHost);
if (!location.pathname.endsWith("/")) location.pathname += "/";

const site = lume({
  location,
  src: "./catalog",
  dest: "./_site",
  prettyUrls: false,
  server: {
    port: 3000,
    debugBar: false,
    middlewares: [
      async (request, next) => {
        const { pathname } = new URL(request.url);
        console.log(request.method + " " + pathname);
        const response = await next(request);
        if (!pathname.startsWith("/api/") || response.status === 404) {
          return response;
        }
        const json = new Response(response.body, response);
        json.headers.set("content-type", "application/json; charset=utf-8");
        return json;
      },
    ],
  },
});

site.data("title", "Private Pebble Appstore", "/api");
site.data("host", location.href, "/api");

// Register files individually because copy("static") would skip dotfiles.
for await (
  const { path } of walk(site.root("static"), { includeDirs: false })
) {
  site.copy(toFileUrl(path).href, normalizePath(path, site.root("static")));
}

site.use(pebbleStore("catalog"));

export default site;
