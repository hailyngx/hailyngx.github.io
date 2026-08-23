import { defineConfig } from "astro/config";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";

export default defineConfig({
  site: "https://haily.yevklnekqt.blog",
  markdown: {
    remarkPlugins: [remarkMath],
    rehypePlugins: [rehypeKatex],
  },
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
