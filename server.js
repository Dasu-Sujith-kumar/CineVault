const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const { MpvIpcClient } = require("./mpv-ipc");

function parseArgs(argv) {
  const out = { _: [] };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      out._.push(arg);
      continue;
    }

    const eqIdx = arg.indexOf("=");
    if (eqIdx !== -1) {
      const key = arg.slice(2, eqIdx);
      const value = arg.slice(eqIdx + 1);
      out[key] = value;
      continue;
    }

    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      out[key] = next;
      i += 1;
      continue;
    }
    out[key] = true;
  }

  return out;
}

function printHelp() {
  // eslint-disable-next-line no-console
  console.log(`
Custom MPV-backed player (IPC controlled)

Usage:
  node server.js [--file <path>] [--mpv <path>] [--pipe <name>] [--port <port>] [--no-spawn]

Examples:
  node server.js --file "D:\\Videos\\movie.mp4"
  node server.js --mpv "C:\\\\tools\\\\mpv\\\\mpv.exe" --file "D:\\\\Videos\\\\movie.mp4"
  node server.js --no-spawn --pipe movie-player-mpv

Notes:
  - By default, the server tries to spawn mpv and enable IPC.
  - If mpv is already running with IPC, use --no-spawn to only connect.
`);
}

function toPipePath(pipeNameOrPath) {
  if (pipeNameOrPath.startsWith("\\\\.\\pipe\\")) return pipeNameOrPath;
  return `\\\\.\\pipe\\${pipeNameOrPath}`;
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function sendText(res, status, text) {
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
  });
  res.end(text);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) {
        req.destroy();
        reject(new Error("Body too large"));
      }
    });
    req.on("end", () => {
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function guessContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "application/javascript; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".json":
      return "application/json; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    printHelp();
    process.exit(0);
  }

  const port = Number(args.port || process.env.PORT || 5174);
  const pipeName = String(args.pipe || process.env.MPV_PIPE || "movie-player-mpv");
  const pipePath = toPipePath(pipeName);

  const explicitMpvPath = args.mpv || args["mpv-path"] || process.env.MPV_PATH;
  let mpvPath = String(explicitMpvPath || "mpv");
  if (!explicitMpvPath) {
    const bundledMpv = path.resolve(__dirname, "mpv", "mpv.exe");
    if (fs.existsSync(bundledMpv)) {
      mpvPath = bundledMpv;
    }
  }
  const initialFile = String(args.file || args._[0] || "");
  const spawnEnabled = !args["no-spawn"];

  let mpvProcess = null;
  let mpvLaunchError = null;

  if (spawnEnabled) {
    const mpvArgs = [
      `--input-ipc-server=${pipePath}`,
      "--idle=yes",
      "--force-window=no",
      "--no-terminal",
    ];
    if (initialFile) mpvArgs.push(initialFile);

    try {
      mpvProcess = spawn(mpvPath, mpvArgs, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: false,
      });
      mpvProcess.on("error", (err) => {
        mpvLaunchError = err.message;
      });
      mpvProcess.on("exit", (code, signal) => {
        // eslint-disable-next-line no-console
        console.log(`mpv exited (code=${code}, signal=${signal || "none"})`);
      });
    } catch (err) {
      mpvLaunchError = err?.message || String(err);
    }
  }

  const mpv = new MpvIpcClient(pipePath);
  const observedProps = ["pause", "time-pos", "duration", "volume", "speed", "filename", "path"];

  async function ensureConnected() {
    if (mpv.connected || mpv.connecting) return;

    try {
      await mpv.connect({ timeoutMs: 12_000 });
      for (const prop of observedProps) {
        // eslint-disable-next-line no-await-in-loop
        await mpv.observeProperty(prop);
      }
      for (const prop of observedProps) {
        // eslint-disable-next-line no-await-in-loop
        const value = await mpv.getProperty(prop).catch(() => undefined);
        if (value !== undefined) mpv.state[prop] = value;
      }
    } catch (err) {
      mpv.lastError = err;
    }
  }

  // Best-effort connect early (server still works even if mpv is missing).
  ensureConnected().catch(() => {});

  const staticFiles = new Map([
    ["/", "index.html"],
    ["/index.html", "index.html"],
    ["/styles.css", "styles.css"],
    ["/app.js", "app.js"],
    ["/temp", "temp.html"],
    ["/temp.html", "temp.html"],
    ["/temp.js", "temp.js"],
  ]);

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);

      if (url.pathname.startsWith("/api/")) {
        if (url.pathname === "/api/state" && req.method === "GET") {
          await ensureConnected();
          return sendJson(res, 200, {
            connected: mpv.connected,
            connecting: mpv.connecting,
            pipePath,
            spawnEnabled,
            mpvPath: spawnEnabled ? mpvPath : null,
            mpvPid: mpvProcess?.pid || null,
            mpvLaunchError,
            lastError: mpv.lastError ? String(mpv.lastError?.message || mpv.lastError) : null,
            state: mpv.state,
          });
        }

        if (url.pathname === "/api/connect" && req.method === "POST") {
          await ensureConnected();
          return sendJson(res, mpv.connected ? 200 : 503, {
            connected: mpv.connected,
            pipePath,
            lastError: mpv.lastError ? String(mpv.lastError?.message || mpv.lastError) : null,
          });
        }

        if (req.method !== "POST") {
          return sendText(res, 405, "Method Not Allowed");
        }

        const body = await readJsonBody(req).catch(() => ({}));
        const delta = Number(body.delta ?? url.searchParams.get("delta"));
        const time = Number(body.time ?? url.searchParams.get("time"));
        const value = Number(body.value ?? url.searchParams.get("value"));
        const filePath = String(body.path ?? url.searchParams.get("path") ?? "");
        const command = body.command;

        await ensureConnected();
        if (!mpv.connected) {
          return sendJson(res, 503, {
            error: "mpv_not_connected",
            pipePath,
            mpvLaunchError,
            lastError: mpv.lastError ? String(mpv.lastError?.message || mpv.lastError) : null,
          });
        }

        if (url.pathname === "/api/play") {
          await mpv.setProperty("pause", false);
          return sendJson(res, 200, { ok: true });
        }

        if (url.pathname === "/api/pause") {
          await mpv.setProperty("pause", true);
          return sendJson(res, 200, { ok: true });
        }

        if (url.pathname === "/api/toggle") {
          await mpv.cycleProperty("pause");
          return sendJson(res, 200, { ok: true });
        }

        if (url.pathname === "/api/seek") {
          if (!Number.isFinite(delta)) return sendJson(res, 400, { error: "invalid_delta" });
          await mpv.seekRelative(delta);
          return sendJson(res, 200, { ok: true });
        }

        if (url.pathname === "/api/seekTo") {
          if (!Number.isFinite(time)) return sendJson(res, 400, { error: "invalid_time" });
          await mpv.seekAbsolute(time);
          return sendJson(res, 200, { ok: true });
        }

        if (url.pathname === "/api/volume") {
          if (!Number.isFinite(value)) return sendJson(res, 400, { error: "invalid_value" });
          await mpv.setProperty("volume", Math.max(0, Math.min(100, value)));
          return sendJson(res, 200, { ok: true });
        }

        if (url.pathname === "/api/speed") {
          if (!Number.isFinite(value)) return sendJson(res, 400, { error: "invalid_value" });
          await mpv.setProperty("speed", Math.max(0.1, Math.min(4, value)));
          return sendJson(res, 200, { ok: true });
        }

        if (url.pathname === "/api/open") {
          if (!filePath) return sendJson(res, 400, { error: "missing_path" });
          await mpv.loadFile(filePath);
          await mpv.setProperty("pause", false).catch(() => {});
          return sendJson(res, 200, { ok: true });
        }

        if (url.pathname === "/api/cmd") {
          if (!Array.isArray(command)) return sendJson(res, 400, { error: "invalid_command" });
          const result = await mpv.send(command);
          return sendJson(res, 200, { ok: true, result });
        }

        if (url.pathname === "/api/quit") {
          await mpv.quit().catch(() => {});
          if (mpvProcess) {
            try {
              mpvProcess.kill();
            } catch {
              // ignore
            }
          }
          return sendJson(res, 200, { ok: true });
        }

        return sendText(res, 404, "Not Found");
      }

      // Static content (whitelist only)
      const rel = staticFiles.get(url.pathname);
      if (!rel) return sendText(res, 404, "Not Found");
      const resolved = path.resolve(__dirname, rel);

      fs.readFile(resolved, (err, data) => {
        if (err) {
          if (err.code === "ENOENT") return sendText(res, 404, "Not Found");
          return sendText(res, 500, "Internal Server Error");
        }

        res.writeHead(200, {
          "Content-Type": guessContentType(resolved),
          "Content-Length": data.length,
          "Cache-Control": "no-store",
        });
        res.end(data);
      });
    } catch (err) {
      return sendText(res, 500, String(err?.message || err));
    }
  });

  server.listen(port, "127.0.0.1", () => {
    // eslint-disable-next-line no-console
    console.log(`UI: http://127.0.0.1:${port}`);
    // eslint-disable-next-line no-console
    console.log(`MPV pipe: ${pipePath}`);
    if (!spawnEnabled) {
      // eslint-disable-next-line no-console
      console.log("mpv spawning disabled (--no-spawn)");
    }
    if (mpvLaunchError) {
      // eslint-disable-next-line no-console
      console.log(`mpv launch error: ${mpvLaunchError}`);
    }
  });

  const shutdown = () => {
    try {
      server.close();
    } catch {
      // ignore
    }
    try {
      mpv.close();
    } catch {
      // ignore
    }
    if (mpvProcess) {
      try {
        mpvProcess.kill();
      } catch {
        // ignore
      }
    }
  };

  process.on("SIGINT", () => {
    shutdown();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    shutdown();
    process.exit(0);
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
