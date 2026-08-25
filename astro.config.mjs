import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://haily.yevklnekqt.blog",
  markdown: {},
  server: {
    host: true,
    port: 4321,
  },
  vite: {
    server: {
      allowedHosts: [
        "haily.yevklnekqt.blog",
        "yevklnekqt.blog",
        "hailyngx.github.io",
        "localhost",
        "127.0.0.1",
      ],
    },
  },
});
