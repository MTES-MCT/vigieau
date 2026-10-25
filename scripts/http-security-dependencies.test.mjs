import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { request } from "node:http";
import { createRequire } from "node:module";
import { createConnection } from "node:net";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { deflateSync, gzipSync } from "node:zlib";

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
  return post(port, "/upload", body, {
    "Content-Type": `multipart/form-data; boundary=${boundary}`,
  });
}

function post(port, path, body, headers = {}, send = (req) => req.end(body)) {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "POST",
        agent: false,
        headers: {
          "Content-Length": body.length,
          ...headers,
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
    req.setTimeout(2_000, () => req.destroy(new Error("HTTP probe timed out")));
    send(req);
  });
}

function dependencies(application) {
  const appRequire = createRequire(
    new URL(`../apps/${application}/package.json`, import.meta.url),
  );
  const platformRequire = createRequire(
    appRequire.resolve("@nestjs/platform-express/package.json"),
  );
  return { appRequire, platformRequire };
}

async function probe(application) {
  const { platformRequire } = dependencies(application);
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

async function probeAsyncFilter(application) {
  const { platformRequire } = dependencies(application);
  const express = platformRequire("express");
  const multer = platformRequire("multer");
  const finished = Promise.withResolvers();
  const filterError = Object.assign(new Error("File rejected"), {
    code: "FILTER_REJECTED",
  });
  let pendingFilter;
  let parser;
  let nextCalls = 0;
  const middleware = multer({
    storage: multer.memoryStorage(),
    fileHwm: 1,
    streamHandler(req, stream) {
      parser = stream;
      req.pipe(stream);
    },
    fileFilter(req, file, callback) {
      if (file.fieldname === "first") pendingFilter = callback;
      else req.once("end", () => setImmediate(() => callback(filterError)));
    },
  }).any();
  const app = express();
  app.post("/deferred-filter", (req, res) => {
    middleware(req, res, (error) => {
      nextCalls++;
      assert.equal(error, filterError);
      assert.equal(typeof pendingFilter, "function");
      // Resume only after Multer's queued teardown removed the parser listeners.
      setImmediate(() => {
        parser.once("close", () => finished.resolve(req.files));
        pendingFilter(null, true);
      });
      res.status(400).json({ code: error.code });
    });
  });
  app.post("/healthy", (_req, res) => res.json({ ok: true }));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const body = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="first"; filename="first.txt"\r\n` +
        `Content-Type: text/plain\r\n\r\na\r\n--${boundary}\r\n` +
        'Content-Disposition: form-data; name="second"; filename="second.txt"\r\n' +
        "Content-Type: text/plain\r\n\r\nb",
    );
    const { port } = server.address();
    assert.deepEqual(
      await post(port, "/deferred-filter", body, {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
      }),
      { status: 400, body: { code: "FILTER_REJECTED" } },
    );
    assert.deepEqual(await finished.promise, []);
    assert.equal(nextCalls, 1);
    assert.deepEqual(await post(port, "/healthy", Buffer.alloc(0)), {
      status: 200,
      body: { ok: true },
    });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function probeBodyParser(application, source) {
  const requires = dependencies(application);
  const express =
    requires[source === "application" ? "appRequire" : "platformRequire"](
      "express",
    );
  const app = express();
  let trailingClient;
  const trailing = Buffer.alloc(1024);
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.post("/body", (req, res) => res.json(req.body));
  app.post("/trailing", (req, res) => {
    // The parser finished the compressed frame before the HTTP request ended.
    req.once("end", () => res.json(req.body));
    trailingClient.end(trailing);
  });
  app.use((error, _req, res, _next) => {
    res.status(error.status || 500).json({ type: error.type });
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const { port } = server.address();
    const json = Buffer.from('{"department":"47"}');
    const expected = { status: 200, body: { department: "47" } };
    assert.deepEqual(
      await post(port, "/body", json, { "Content-Type": "application/json" }),
      expected,
    );
    assert.deepEqual(
      await post(port, "/body", Buffer.from("department=47"), {
        "Content-Type": "application/x-www-form-urlencoded",
      }),
      expected,
    );
    assert.deepEqual(
      await post(port, "/body", gzipSync(json), {
        "Content-Type": "application/json",
        "Content-Encoding": "gzip",
      }),
      expected,
    );

    // GHSA-27r3-jxmh-p828: extra bytes arrive after zlib has finished decoding.
    const first = Buffer.concat([deflateSync(json), Buffer.from([0])]);
    assert.deepEqual(
      await post(
        port,
        "/trailing",
        first,
        {
          "Content-Type": "application/json",
          "Content-Encoding": "deflate",
          "Content-Length": first.length + trailing.length,
        },
        (req) => {
          trailingClient = req;
          req.write(first);
        },
      ),
      expected,
    );

    const malformed = Buffer.concat([
      gzipSync(json),
      Buffer.from([0]),
      Buffer.alloc(100 * 1024, 0x58),
    ]);
    assert.deepEqual(
      await post(port, "/body", malformed, {
        "Content-Type": "application/json",
        "Content-Encoding": "gzip",
      }),
      expected,
    );
    await delay(200);
    assert.deepEqual(
      await post(port, "/body", json, { "Content-Type": "application/json" }),
      expected,
    );
  } finally {
    trailingClient?.destroy();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

if (process.argv[2] === "--probe") {
  await probe(process.argv[3]);
} else if (process.argv[2] === "--probe-async-filter") {
  await probeAsyncFilter(process.argv[3]);
} else if (process.argv[2] === "--probe-body-parser") {
  await probeBodyParser(process.argv[3], process.argv[4]);
} else {
  for (const application of ["backend", "backend-admin"]) {
    test(`${application}: real multipart parsing survives limits and interrupted uploads`, () => {
      execFileSync(process.execPath, [filename, "--probe", application], {
        timeout: 10_000,
        stdio: "pipe",
      });
    });
    test(`${application}: an asynchronous file filter cannot crash after parser teardown`, () => {
      execFileSync(
        process.execPath,
        [filename, "--probe-async-filter", application],
        {
          timeout: 10_000,
          stdio: "pipe",
        },
      );
    });
    for (const source of ["application", "nest"]) {
      test(`${application}/${source}: JSON and form parsing survive late compressed bytes`, () => {
        execFileSync(
          process.execPath,
          [filename, "--probe-body-parser", application, source],
          {
            timeout: 10_000,
            stdio: "pipe",
          },
        );
      });
    }
  }
}
