import http from "node:http";

const TARGET_PORT = 4321;
const LISTEN_PORT = 80;

const server = http.createServer((req, res) => {
  const proxy = http.request(
    {
      hostname: "127.0.0.1",
      port: TARGET_PORT,
      path: req.url,
      method: req.method,
      headers: {
        ...req.headers,
        host: "blog.haily.yevklnekqt:4321",
      },
    },
    (upstream) => {
      res.writeHead(upstream.statusCode ?? 502, upstream.headers);
      upstream.pipe(res);
    }
  );

  proxy.on("error", () => {
    res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
    res.end("The blog is not running. In the blog folder, run: npm run dev\n");
  });

  req.pipe(proxy);
});

server.on("error", (error) => {
  console.error(error.message);
  process.exit(1);
});

server.listen(LISTEN_PORT, "127.0.0.1", () => {
  console.log("http://blog.haily.yevklnekqt -> 127.0.0.1:" + TARGET_PORT);
});
