const net = require("net");
const { EventEmitter } = require("events");

class MpvIpcClient extends EventEmitter {
  constructor(pipePath, options = {}) {
    super();
    this.pipePath = pipePath;
    this.commandTimeoutMs = options.commandTimeoutMs ?? 2500;

    this.connected = false;
    this.connecting = false;
    this.lastError = null;

    this.state = {};

    this._socket = null;
    this._buffer = "";
    this._nextRequestId = 1;
    this._pending = new Map();
    this._nextObserveId = 1;
  }

  async connect({ timeoutMs = 10_000, retryIntervalMs = 200 } = {}) {
    if (this.connected) return;
    if (this.connecting) return;

    this.connecting = true;
    this.lastError = null;

    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await this._connectOnce();
        this.connected = true;
        this.connecting = false;
        this.emit("connected");
        return;
      } catch (err) {
        this.lastError = err;
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, retryIntervalMs));
      }
    }

    this.connecting = false;
    const message = this.lastError?.message || "Timed out connecting to mpv IPC";
    throw new Error(message);
  }

  close() {
    this._rejectAllPending(new Error("mpv IPC closed"));
    if (this._socket) {
      this._socket.destroy();
      this._socket = null;
    }
    this._buffer = "";
    this.connected = false;
    this.connecting = false;
  }

  async send(command) {
    if (!this.connected || !this._socket) {
      throw new Error("Not connected to mpv");
    }

    const requestId = this._nextRequestId++;
    const payload = { command, request_id: requestId };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this._pending.delete(requestId);
        reject(new Error(`mpv command timeout: ${command?.[0] || "unknown"}`));
      }, this.commandTimeoutMs);

      this._pending.set(requestId, { resolve, reject, timeout });
      try {
        this._socket.write(`${JSON.stringify(payload)}\n`);
      } catch (err) {
        clearTimeout(timeout);
        this._pending.delete(requestId);
        reject(err);
      }
    });
  }

  async setProperty(name, value) {
    return this.send(["set_property", name, value]);
  }

  async getProperty(name) {
    const res = await this.send(["get_property", name]);
    return res?.data;
  }

  async observeProperty(name) {
    const id = this._nextObserveId++;
    await this.send(["observe_property", id, name]);
    return id;
  }

  async cycleProperty(name) {
    return this.send(["cycle", name]);
  }

  async seekRelative(seconds) {
    return this.send(["seek", seconds, "relative"]);
  }

  async seekAbsolute(seconds) {
    return this.send(["seek", seconds, "absolute", "exact"]);
  }

  async loadFile(filePath) {
    return this.send(["loadfile", filePath, "replace"]);
  }

  async quit() {
    return this.send(["quit"]);
  }

  _connectOnce() {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.pipePath);
      socket.setNoDelay(true);

      const cleanup = () => {
        socket.off("connect", onConnect);
        socket.off("error", onError);
      };

      const onConnect = () => {
        cleanup();
        this._attachSocket(socket);
        resolve();
      };

      const onError = (err) => {
        cleanup();
        try {
          socket.destroy();
        } catch {
          // ignore
        }
        reject(err);
      };

      socket.once("connect", onConnect);
      socket.once("error", onError);
    });
  }

  _attachSocket(socket) {
    this._socket = socket;
    this._buffer = "";

    socket.on("data", (chunk) => {
      this._buffer += chunk.toString("utf8");
      while (true) {
        const newlineIdx = this._buffer.indexOf("\n");
        if (newlineIdx === -1) break;

        const line = this._buffer.slice(0, newlineIdx).trim();
        this._buffer = this._buffer.slice(newlineIdx + 1);
        if (!line) continue;

        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }

        this._handleMessage(message);
      }
    });

    socket.on("error", (err) => {
      this.lastError = err;
      this.emit("error", err);
    });

    socket.on("close", () => {
      this.connected = false;
      this._socket = null;
      this._rejectAllPending(new Error("mpv IPC disconnected"));
      this.emit("disconnected");
    });
  }

  _handleMessage(message) {
    if (typeof message?.request_id === "number") {
      const pending = this._pending.get(message.request_id);
      if (!pending) return;

      clearTimeout(pending.timeout);
      this._pending.delete(message.request_id);

      if (message.error && message.error !== "success") {
        const err = new Error(message.error);
        err.mpv = message;
        pending.reject(err);
        return;
      }

      pending.resolve(message);
      return;
    }

    if (message?.event === "property-change" && message?.name) {
      this.state[message.name] = message.data;
      this.emit("property-change", {
        name: message.name,
        data: message.data,
        id: message.id,
      });
      return;
    }

    if (message?.event) {
      this.emit("event", message);
    }
  }

  _rejectAllPending(err) {
    for (const pending of this._pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(err);
    }
    this._pending.clear();
  }
}

module.exports = { MpvIpcClient };

