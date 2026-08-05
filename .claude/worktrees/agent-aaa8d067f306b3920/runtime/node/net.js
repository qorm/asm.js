// asm.js Runtime - Node.js net (real async, event-driven TCP)
//
// ASYNC READINESS MODEL (round 4)
// -------------------------------
// asm.js's native event loop (`_ev_run`) drains the setImmediate queue before
// exit. We ride that queue to get readiness polling WITHOUT touching the loop's
// hand-written assembler: while any socket/server fd is registered we keep
// re-arming a "poll tick" via setImmediate. Each tick issues a real poll(2)
// (ppoll on linux-arm64) that blocks until a watched fd is readable, then fires
// the JS `'data'` / `'connection'` / `'end'` / `'close'` callbacks; it re-arms
// itself while watchers remain, and stops (letting the loop terminate) once the
// last fd is removed. This makes the classic event-driven Node flow
// (`server.on('connection')` / `socket.on('data')` firing on their own) work.
//
//   net.connect(port, host) -> Socket   (real socket()+connect())
//   net.createServer()       -> Server  (real bind()+listen())
//   socket.on('data'|'end'|'close')      async, driven by poll(2) readiness
//   server.on('connection')              async accept() on listen fd readiness
//   socket.write(data)       -> real write()
//   socket.read([size])      -> Buffer|string  (sync blocking read; round-3 API)
//   server.accept()          -> Socket         (sync accept; round-3 API)
//   server.address()         -> { port } via getsockname (ephemeral :0 ok)
//   isIP / isIPv4 / isIPv6
//
// The synchronous round-3 API (socket.read / server.accept) is preserved: a
// socket only starts async reading once a 'data'/'end' listener is attached
// (Node flowing-mode semantics), so code that calls read()/accept() directly
// registers no watcher and behaves exactly as before.

import { EventEmitter } from "./events.js";
import { getSyscall } from "./constants.js";
import { Buffer as _Buf } from "./buffer.js";

const AF_INET = 2;
const SOCK_STREAM = 1;

// poll(2) event bitmask constants (identical on macOS and Linux).
const POLLIN = 0x0001;
const POLLERR = 0x0008;
const POLLHUP = 0x0010;
const POLLNVAL = 0x0020;

// ------------------------------------------------------------------
// Readiness poll pump. Watchers: { fd, events, onReady(revents) }.
// ------------------------------------------------------------------
const _watchers = [];
let _pumpArmed = false;
let _pumpIdle = 0;

function _pollUsesPpoll() {
    const p = __get_process();
    const plat = (p && p.platform) || "macos";
    const arch = (p && p.arch) || "arm64";
    return plat === "linux" && arch === "arm64";
}

function _armPump() {
    if (_pumpArmed || _watchers.length === 0) return;
    _pumpArmed = true;
    setImmediate(_pumpTick);
}

function _watchAdd(fd, events, onReady) {
    for (let i = 0; i < _watchers.length; i++) {
        if (_watchers[i].fd === fd) {
            _watchers[i].events = events;
            _watchers[i].onReady = onReady;
            _armPump();
            return;
        }
    }
    _watchers.push({ fd: fd, events: events, onReady: onReady });
    _armPump();
}

function _watchRemove(fd) {
    for (let i = _watchers.length - 1; i >= 0; i--) {
        if (_watchers[i].fd === fd) _watchers.splice(i, 1);
    }
}

function _pumpTick() {
    _pumpArmed = false;
    const n = _watchers.length;
    if (n === 0) return; // no fds left: the event loop terminates.
    const sc = getSyscall("poll");
    if (sc < 0) return;  // platform without poll support: give up gracefully.

    // Build the pollfd array (8 bytes each: fd@0 int32, events@4 int16, revents@6 int16).
    const fds = __alloc(n * 8);
    for (let i = 0; i < n; i++) {
        const w = _watchers[i];
        const base = fds + i * 8;
        __setChar(base + 0, w.fd & 0xff);
        __setChar(base + 1, (w.fd >> 8) & 0xff);
        __setChar(base + 2, (w.fd >> 16) & 0xff);
        __setChar(base + 3, (w.fd >> 24) & 0xff);
        __setChar(base + 4, w.events & 0xff);
        __setChar(base + 5, (w.events >> 8) & 0xff);
        __setChar(base + 6, 0);
        __setChar(base + 7, 0);
    }

    // Block until a watched fd is ready, or the 1s timeout elapses.
    let rc;
    if (_pollUsesPpoll()) {
        // ppoll(fds, nfds, *timespec{tv_sec,tv_nsec}, sigmask=0, sigsetsize=0)
        const ts = __alloc(16);
        for (let k = 0; k < 16; k++) __setChar(ts + k, 0);
        __setChar(ts + 0, 1); // tv_sec = 1
        rc = __syscall(sc, fds, n, ts, 0, 0);
    } else {
        rc = __syscall(sc, fds, n, 1000); // timeout in ms
    }

    if (rc > 0) {
        _pumpIdle = 0;
        // Snapshot ready watchers first: onReady callbacks may mutate _watchers.
        const ready = [];
        for (let i = 0; i < n; i++) {
            const base = fds + i * 8;
            const rev = __getChar(base + 6) | (__getChar(base + 7) << 8);
            if (rev !== 0) ready.push(_watchers[i]);
        }
        for (let i = 0; i < ready.length; i++) {
            const w = ready[i];
            if (_watchers.indexOf(w) !== -1) w.onReady(w.events);
        }
    } else {
        // Timeout (0) or error (<0). Bail out after a long idle stretch so a
        // wedged fd can never hang the process forever (safety net; loopback
        // never trips it).
        _pumpIdle++;
        if (_pumpIdle > 30) { _watchers.length = 0; return; }
    }
    _armPump();
}

function _platform() {
    const p = __get_process();
    return (p && p.platform) || "macos";
}

// Parse a dotted-quad IPv4 host into [b0,b1,b2,b3]; null if not a plain IPv4.
function _parseIPv4(host) {
    if (host === undefined || host === null || host === "" || host === "localhost") return [127, 0, 0, 1];
    if (host === "0.0.0.0") return [0, 0, 0, 0];
    const parts = host.split(".");
    if (parts.length !== 4) return null;
    const out = [];
    for (let i = 0; i < 4; i++) {
        const seg = parts[i];
        if (seg.length === 0 || seg.length > 3) return null;
        let n = 0;
        for (let k = 0; k < seg.length; k++) {
            const c = seg.charCodeAt(k);
            if (c < 48 || c > 57) return null;
            n = n * 10 + (c - 48);
        }
        if (n > 255) return null;
        out.push(n);
    }
    return out;
}

// Build a 16-byte sockaddr_in in native memory. Returns the pointer.
function _makeSockaddr(port, host) {
    let ip = _parseIPv4(host);
    if (ip === null) ip = [127, 0, 0, 1];
    const sa = __alloc(16);
    if (_platform() === "macos") {
        __setChar(sa + 0, 16);        // sin_len (BSD)
        __setChar(sa + 1, AF_INET);   // sin_family
    } else {
        __setChar(sa + 0, AF_INET);   // Linux: sin_family is 2 LE bytes
        __setChar(sa + 1, 0);
    }
    __setChar(sa + 2, (port >> 8) & 0xff); // sin_port big-endian hi
    __setChar(sa + 3, port & 0xff);        // sin_port big-endian lo
    __setChar(sa + 4, ip[0]);
    __setChar(sa + 5, ip[1]);
    __setChar(sa + 6, ip[2]);
    __setChar(sa + 7, ip[3]);
    for (let i = 8; i < 16; i++) __setChar(sa + i, 0);
    return sa;
}

function _setReuseAddr(fd) {
    const sc = getSyscall("setsockopt");
    if (sc < 0) return;
    const mac = _platform() === "macos";
    const SOL_SOCKET = mac ? 65535 : 1;   // macOS 0xffff, Linux 1
    const SO_REUSEADDR = mac ? 4 : 2;      // macOS 0x0004, Linux 2
    const val = __alloc(4);
    __setChar(val + 0, 1);
    __setChar(val + 1, 0);
    __setChar(val + 2, 0);
    __setChar(val + 3, 0);
    __syscall(sc, fd, SOL_SOCKET, SO_REUSEADDR, val, 4);
}

// Read the locally bound port via getsockname (supports ephemeral port 0).
function _boundPort(fd) {
    const sc = getSyscall("getsockname");
    if (sc < 0) return 0;
    const sa = __alloc(16);
    const lenp = __alloc(4);
    __setChar(lenp + 0, 16);
    __setChar(lenp + 1, 0);
    __setChar(lenp + 2, 0);
    __setChar(lenp + 3, 0);
    const r = __syscall(sc, fd, sa, lenp);
    if (r < 0) return 0;
    return ((__getChar(sa + 2) << 8) | __getChar(sa + 3)) & 0xffff;
}

// Normalize write payload into a byte array.
function _dataBytes(data, encoding) {
    const b = [];
    if (typeof data === "string") {
        for (let i = 0; i < data.length; i++) b.push(data.charCodeAt(i) & 0xff);
        return b;
    }
    if (data instanceof _Buf) {
        for (let i = 0; i < data.length; i++) b.push(data.data[i] & 0xff);
        return b;
    }
    if (data && data.data && typeof data.length === "number") {
        for (let i = 0; i < data.length; i++) b.push(data.data[i] & 0xff);
        return b;
    }
    if (data && typeof data.length === "number") {
        for (let i = 0; i < data.length; i++) b.push(data[i] & 0xff);
        return b;
    }
    return b;
}

function _sockErr(op, code) {
    const e = new Error("net " + op + " failed (rc=" + code + ")");
    e.code = "E" + op.toUpperCase();
    e.syscall = op;
    return e;
}

class Socket extends EventEmitter {
    constructor(options) {
        super();
        this.fd = -1;
        this.writable = false;
        this.readable = false;
        this.destroyed = false;
        this.connecting = false;
        this.bytesRead = 0;
        this.bytesWritten = 0;
        this._encoding = null;
        this._remotePort = 0;
        this._remoteAddress = "";
        this._reading = false;
        this._endEmitted = false;
        this._closeEmitted = false;
    }

    // Attaching a 'data'/'end' listener switches to flowing mode (Node semantics).
    // once()/addListener() both route through on(), so this covers them too.
    on(event, listener) {
        const r = super.on(event, listener);
        if ((event === "data" || event === "end") && this.fd >= 0 && !this.destroyed) {
            this._startRead();
        }
        return r;
    }
    addListener(event, listener) { return this.on(event, listener); }

    // Register this fd with the poll pump; readable events fire 'data'/'end'.
    _startRead() {
        if (this.fd < 0 || this.destroyed || this._reading) return;
        this._reading = true;
        const self = this;
        _watchAdd(this.fd, POLLIN, function () { self._onReadable(); });
    }
    _stopRead() {
        this._reading = false;
        if (this.fd >= 0) _watchRemove(this.fd);
    }

    // Poll pump says the fd is readable: drain one chunk (poll re-fires if more
    // remains), emit 'data'; on EOF/error emit 'end' + 'close' and close the fd.
    _onReadable() {
        if (this.fd < 0 || this.destroyed) { this._stopRead(); return; }
        const cap = 65536;
        const buf = __alloc(cap + 1);
        const rn = __syscall(getSyscall("read"), this.fd, buf, cap);
        if (rn > 0) {
            this.bytesRead += rn;
            const out = new _Buf(0);
            for (let i = 0; i < rn; i++) out.data.push(__getChar(buf + i));
            out.length = out.data.length;
            this.emit("data", this._encoding ? out.toString(this._encoding) : out);
            return;
        }
        // EOF (0) or error (<0): tear down the readable half.
        this._stopRead();
        this.readable = false;
        if (!this._endEmitted) { this._endEmitted = true; this.emit("end"); }
        if (this.fd >= 0) { __syscall(getSyscall("close"), this.fd); this.fd = -1; }
        this.destroyed = true;
        this.writable = false;
        if (!this._closeEmitted) { this._closeEmitted = true; this.emit("close"); }
    }

    // Bind an already-accepted fd (used by Server.accept and async connection).
    _attach(fd, addr, port) {
        this.fd = fd;
        this.writable = true;
        this.readable = true;
        this.destroyed = false;
        this._remoteAddress = addr || "";
        this._remotePort = port || 0;
        return this;
    }

    connect(port, host, connectListener) {
        // connect(options[, cb]) form
        if (port !== null && typeof port === "object") {
            const opts = port;
            connectListener = host;
            host = opts.host;
            port = opts.port;
        }
        if (typeof host === "function") { connectListener = host; host = undefined; }
        if (typeof connectListener === "function") this.once("connect", connectListener);

        const fd = __syscall(getSyscall("socket"), AF_INET, SOCK_STREAM, 0);
        if (fd < 0) { this.emit("error", _sockErr("socket", fd)); return this; }
        this.fd = fd;
        const sa = _makeSockaddr(port, host);
        const cr = __syscall(getSyscall("connect"), fd, sa, 16);
        if (cr < 0) {
            __syscall(getSyscall("close"), fd);
            this.fd = -1;
            this.emit("error", _sockErr("connect", cr));
            return this;
        }
        this.writable = true;
        this.readable = true;
        this._remotePort = port;
        this._remoteAddress = (host === undefined || host === null || host === "localhost") ? "127.0.0.1" : host;
        this.emit("connect");
        return this;
    }

    write(data, encoding, cb) {
        if (typeof encoding === "function") { cb = encoding; encoding = undefined; }
        if (this.fd < 0) return false;
        const bytes = _dataBytes(data, encoding);
        const buf = __alloc(bytes.length + 1);
        for (let i = 0; i < bytes.length; i++) __setChar(buf + i, bytes[i] & 0xff);
        const wr = __syscall(getSyscall("write"), this.fd, buf, bytes.length);
        if (wr > 0) this.bytesWritten += wr;
        if (typeof cb === "function") cb();
        return true;
    }

    // Synchronous blocking read. Returns a Buffer (or decoded string when an
    // encoding is set); null on EOF / error. Extension over Node's event API.
    read(size) {
        if (this.fd < 0) return null;
        const cap = (size && size > 0) ? size : 65536;
        const buf = __alloc(cap + 1);
        const rn = __syscall(getSyscall("read"), this.fd, buf, cap);
        if (rn <= 0) return null;
        this.bytesRead += rn;
        const out = new _Buf(0);
        for (let i = 0; i < rn; i++) out.data.push(__getChar(buf + i));
        out.length = out.data.length;
        if (this._encoding) return out.toString(this._encoding);
        return out;
    }

    end(data, encoding, cb) {
        if (typeof data === "function") { cb = data; data = undefined; }
        else if (typeof encoding === "function") { cb = encoding; encoding = undefined; }
        if (data !== undefined && data !== null) this.write(data, encoding);
        this.writable = false;
        // Async (flowing) sockets: half-close the write side (FIN) so the peer
        // sees end-of-request but we can still read its reply until it closes
        // (peer EOF then drives 'end'/'close'). Sync sockets keep the round-3
        // behaviour of a full close on end().
        if (this.fd >= 0 && this._reading) {
            const sc = getSyscall("shutdown");
            if (sc >= 0) __syscall(sc, this.fd, 1); // SHUT_WR
            else this.destroy();
        } else {
            this.destroy();
        }
        if (typeof cb === "function") cb();
        return this;
    }

    destroy(err) {
        this._stopRead();
        if (this.fd >= 0) { __syscall(getSyscall("close"), this.fd); this.fd = -1; }
        this.destroyed = true;
        this.writable = false;
        this.readable = false;
        if (err) this.emit("error", err);
        if (!this._closeEmitted) { this._closeEmitted = true; this.emit("close"); }
        return this;
    }

    setEncoding(encoding) { this._encoding = encoding; return this; }
    setNoDelay(noDelay) { return this; }
    setKeepAlive(enable, initialDelay) { return this; }
    setTimeout(timeout, cb) { return this; }
    pause() { this._stopRead(); return this; }
    resume() { if (this.fd >= 0 && !this.destroyed) this._startRead(); return this; }
    ref() { return this; }
    unref() { return this; }
    address() { return { port: this._remotePort, family: "IPv4", address: this._remoteAddress || "127.0.0.1" }; }
    get remoteAddress() { return this._remoteAddress; }
    get remotePort() { return this._remotePort; }
}

class Server extends EventEmitter {
    constructor(options, onConnect) {
        super();
        if (typeof options === "function") { onConnect = options; options = {}; }
        if (typeof onConnect === "function") this.on("connection", onConnect);
        this.fd = -1;
        this.listening = false;
        this._port = 0;
        this._host = "0.0.0.0";
    }

    listen(port, host, backlog, cb) {
        // Argument juggling: listen(port[, host][, backlog][, cb]) / listen(opts[, cb])
        if (port !== null && typeof port === "object") {
            const opts = port;
            cb = host;
            host = opts.host;
            backlog = opts.backlog;
            port = opts.port;
        }
        if (typeof host === "function") { cb = host; host = undefined; backlog = undefined; }
        else if (typeof backlog === "function") { cb = backlog; backlog = undefined; }

        const fd = __syscall(getSyscall("socket"), AF_INET, SOCK_STREAM, 0);
        if (fd < 0) { this.emit("error", _sockErr("socket", fd)); return this; }
        this.fd = fd;
        _setReuseAddr(fd);
        const sa = _makeSockaddr(port || 0, host);
        const br = __syscall(getSyscall("bind"), fd, sa, 16);
        if (br < 0) {
            __syscall(getSyscall("close"), fd);
            this.fd = -1;
            this.emit("error", _sockErr("bind", br));
            return this;
        }
        const lr = __syscall(getSyscall("listen"), fd, (backlog && backlog > 0) ? backlog : 511);
        if (lr < 0) {
            __syscall(getSyscall("close"), fd);
            this.fd = -1;
            this.emit("error", _sockErr("listen", lr));
            return this;
        }
        this.listening = true;
        this._port = _boundPort(fd) || (port || 0);
        this._host = (host === undefined || host === null) ? "0.0.0.0" : host;
        // Arm async accept: the poll pump fires 'connection' when the listen fd
        // becomes readable. This keeps the process alive like a real server;
        // close() removes the watcher so the loop can terminate.
        this._startAccept();
        if (typeof cb === "function") cb();
        this.emit("listening");
        return this;
    }

    _startAccept() {
        if (this.fd < 0 || this._accepting) return;
        this._accepting = true;
        const self = this;
        _watchAdd(this.fd, POLLIN, function () { self._onAcceptable(); });
    }

    // Listen fd readable: accept exactly one pending connection (a blocking
    // accept() would stall if we over-drained; poll re-fires for the rest).
    _onAcceptable() {
        if (this.fd < 0) return;
        const cfd = __syscall(getSyscall("accept"), this.fd, 0, 0);
        if (cfd < 0) return;
        const sock = new Socket();
        sock._attach(cfd, "127.0.0.1", 0);
        this.emit("connection", sock);
    }

    // Synchronous accept: returns a connected Socket (null if none / error).
    // Also fires the 'connection' event so createServer(cb) users work in a
    // synchronous accept loop. Extension over Node's async model.
    accept() {
        if (this.fd < 0) return null;
        const cfd = __syscall(getSyscall("accept"), this.fd, 0, 0);
        if (cfd < 0) return null;
        const sock = new Socket();
        sock._attach(cfd, "127.0.0.1", 0);
        this.emit("connection", sock);
        return sock;
    }

    close(cb) {
        this._accepting = false;
        if (this.fd >= 0) { _watchRemove(this.fd); __syscall(getSyscall("close"), this.fd); this.fd = -1; }
        this.listening = false;
        this.emit("close");
        if (typeof cb === "function") cb();
        return this;
    }

    address() { return { port: this._port, family: "IPv4", address: this._host }; }
    getConnections(cb) { if (typeof cb === "function") cb(null, 0); return this; }
    ref() { return this; }
    unref() { return this; }
}

function isIPv4(input) {
    return _parseIPv4(input) !== null && typeof input === "string" && input.indexOf(".") !== -1;
}
function isIPv6(input) {
    return typeof input === "string" && input.indexOf(":") !== -1;
}
function isIP(input) {
    if (isIPv4(input)) return 4;
    if (isIPv6(input)) return 6;
    return 0;
}

function createServer(options, onConnect) { return new Server(options, onConnect); }
function connect(port, host, connectListener) {
    const s = new Socket();
    return s.connect(port, host, connectListener);
}
function createConnection(port, host, connectListener) { return connect(port, host, connectListener); }

// Shared readiness-pump + sockaddr helpers reused by dgram.js so UDP rides the
// same single poll(2) event loop and IPv4 address encoding as TCP.
export { _watchAdd as _netWatchAdd, _watchRemove as _netWatchRemove,
         _makeSockaddr as _netMakeSockaddr, _parseIPv4 as _netParseIPv4,
         _boundPort as _netBoundPort, _setReuseAddr as _netSetReuseAddr,
         POLLIN as _NET_POLLIN, AF_INET as _NET_AF_INET };

export { Socket, Server, isIP, isIPv4, isIPv6, createServer, connect, createConnection };
export default { Socket, Server, isIP, isIPv4, isIPv6, createServer, connect, createConnection };
