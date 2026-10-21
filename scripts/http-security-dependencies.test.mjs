import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { request } from "node:http";
import { createRequire } from "node:module";
import { createConnection } from "node:net";
import test from "node:test";
import { fileURLToPath } from "node:url";

const filename = fileURLToPath(import.meta.url);
const boundary = "vigieau-security-upload-boundary";

function multipart(content, complete = true) {
  return Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="department"\r\n\r\n47\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="notice.txt"\r\n` +
        "Content-Type: text/plain\r\n\r\n",
    ),
    content,
    Buffer.from(complete ? `\r\n--${boundary}--\r\n` : ""),
  ]);
}

function upload(port, content) {
  const body = multipart(content);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path: "/upload",
        method: "POST",
        agent: false,
        headers: {
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": body.length,
        },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("error", reject);
        response.on("end", () => {
          try {
            resolve({
              status: response.statusCode,
              body: JSON.parse(Buffer.concat(chunks).toString()),
            });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

async function probe(application) {
  const appRequire = createRequire(
    new URL(`../apps/${application}/package.json`, import.meta.url),
  );
  const platformRequire = createRequire(
    appRequire.resolve("@nestjs/platform-express/package.json"),
  );
  const express = platformRequire("express");
  const multer = platformRequire("multer");
  const abortParsed = Promise.withResolvers();
  const abortSeen = Promise.withResolvers();
  const activeRequests = new Set();
  const sockets = new Set();
  const middleware = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 16, files: 1, fields: 1 },
    fileFilter(req, _file, callback) {
      if (req.headers["x-abort-probe"]) abortParsed.resolve();
      callback(null, true);
    },
  }).single("file");
  const app = express();
  app.post("/upload", (req, res, next) => {
    activeRequests.add(req);
    res.once("close", () => activeRequests.delete(req));
    if (req.headers["x-abort-probe"]) {
      req.once("aborted", () => abortSeen.resolve());
    }
    middleware(req, res, (error) => {
      if (error) return next(error);
      res.json({
        department: req.body.department,
        filename: req.file.originalname,
        mimetype: req.file.mimetype,
        size: req.file.size,
        content: req.file.buffer.toString("base64"),
      });
    });
  });
  app.use((error, _req, res, _next) => {
    if (!res.destroyed) {
      res.status(error.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({
        code: error.code,
      });
    }
  });
  const server = app.listen(0, "127.0.0.1");
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await once(server, "listening");
  try {
    const { port } = server.address();
    const content = Buffer.from("local upload");
    const expected = {
      status: 200,
      body: {
        department: "47",
        filename: "notice.txt",
        mimetype: "text/plain",
        size: content.length,
        content: content.toString("base64"),
      },
    };
    assert.deepEqual(await upload(port, content), expected);
    assert.deepEqual(await upload(port, Buffer.alloc(32, "a")), {
      status: 413,
      body: { code: "LIMIT_FILE_SIZE" },
    });

    // Disconnect only once Multer has parsed the file header.
    const client = createConnection({ host: "127.0.0.1", port });
    await once(client, "connect");
    const partial = multipart(Buffer.from("partial"), false);
    client.write(
      `POST /upload HTTP/1.1\r\nHost: localhost\r\nX-Abort-Probe: 1\r\n` +
        `Content-Type: multipart/form-data; boundary=${boundary}\r\n` +
        `Content-Length: ${partial.length + 100}\r\n\r\n`,
    );
    client.write(partial);
    await abortParsed.promise;
    const closed = once(client, "close");
    client.destroy();
    await Promise.all([closed, abortSeen.promise]);

    assert.deepEqual(await upload(port, content), expected);
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(activeRequests.size, 0, "unfinished upload requests");
    assert.equal(sockets.size, 0, "upload sockets were not released");
  } finally {
    for (const socket of sockets) socket.destroy();
    if (server.listening) {
      await new Promise((resolve) => server.close(resolve));
    }
  }
}

if (process.argv[2] === "--probe") {
  await probe(process.argv[3]);
} else {
  for (const application of ["backend", "backend-admin"]) {
    test(`${application}: real multipart parsing survives limits and interrupted uploads`, () => {
      execFileSync(process.execPath, [filename, "--probe", application], {
        timeout: 10_000,
        stdio: "pipe",
      });
    });
  }
}
