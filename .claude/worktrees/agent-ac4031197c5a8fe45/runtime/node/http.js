// asm.js Runtime - Node.js http (minimal but real HTTP/1.1 over async net sockets)
//
// Built entirely on top of the round-4 event-driven net layer: the readiness
// poll pump in net.js fires 'connection'/'data'/'end' on the underlying TCP
// sockets, and this module parses HTTP/1.1 request/response framing on those
// events. No new event-loop plumbing is needed here.
//
// Server:  http.createServer((req, res) => { ... }); server.listen(port[, cb])
//          req is an IncomingMessage (method/url/headers, 'data'/'end');
//          res is a ServerResponse (writeHead/setHeader/write/end).
// Client:  http.request(opts[, cb]) / http.get(opts[, cb])
//          returns a ClientRequest; 'response' yields an IncomingMessage.
//
// Framing: request line + headers terminated by CRLFCRLF; body length taken
// from Content-Length (chunked transfer-encoding is not implemented). Responses
// use Connection: close, so end-of-body is signalled by socket EOF — enough to
// serve and fetch a real request/response with headers and a body.

import { EventEmitter } from "./events.js";
// Named-alias imports (not `import * as`): namespace-member access on a module
// that shares export names with this one (createServer/Server) can bind to the
// wrong global in the current compiler, so pull net's factories under private
// aliases instead.
import { createServer as _netCreateServer, connect as _netConnect } from "./net.js";

const _STATUS = {
    200: "OK", 201: "Created", 204: "No Content",
    301: "Moved Permanently", 302: "Found", 304: "Not Modified",
    400: "Bad Request", 401: "Unauthorized", 403: "Forbidden",
    404: "Not Found", 405: "Method Not Allowed", 500: "Internal Server Error",
    501: "Not Implemented", 503: "Service Unavailable",
};
function _statusText(code) { return _STATUS[code] || "OK"; }

// Coerce a write payload (string | Buffer) into a byte-preserving string.
function _chunkToStr(chunk) {
    if (chunk === undefined || chunk === null) return "";
    if (typeof chunk === "string") return chunk;
    if (typeof chunk.toString === "function") return chunk.toString();
    return "" + chunk;
}

// Byte length of an ASCII/latin1 payload (Content-Length).
function _byteLen(s) { return typeof s === "string" ? s.length : (s && s.length) || 0; }

// Trim leading/trailing ASCII whitespace (avoids relying on String.trim quirks).
function _trim(s) {
    let a = 0, b = s.length;
    while (a < b && (s.charCodeAt(a) === 32 || s.charCodeAt(a) === 9)) a++;
    while (b > a && (s.charCodeAt(b - 1) === 32 || s.charCodeAt(b - 1) === 9)) b--;
    return s.substring(a, b);
}

// Split an HTTP header block into lines. NOTE: the compiler's String.split only
// honours the first character of a multi-character separator, so `split("\r\n")`
// wrongly splits on "\r" and leaves a leading "\n" on every line. Split on "\n"
// and strip a trailing "\r" instead.
function _splitLines(head) {
    const raw = head.split("\n");
    const out = [];
    for (let i = 0; i < raw.length; i++) {
        let ln = raw[i];
        if (ln.length > 0 && ln.charCodeAt(ln.length - 1) === 13) ln = ln.substring(0, ln.length - 1);
        out.push(ln);
    }
    return out;
}

// Decode an HTTP/1.1 chunked body from an accumulated raw buffer. Returns
// { out, done }: `out` is the decoded payload for the complete chunks present,
// `done` is true once the terminating zero-length chunk (`0\r\n\r\n`) is seen.
// Called on the full accumulated buffer each time (idempotent re-decode), so the
// caller emits the decoded body once at completion rather than per-chunk — enough
// for request/response round-trips and keep-alive end-detection without EOF.
function _decodeChunked(buf) {
    let out = "";
    let i = 0;
    const n = buf.length;
    while (i < n) {
        const nl = buf.indexOf("\r\n", i);
        if (nl === -1) break;                     // size line incomplete
        let sizeLine = buf.substring(i, nl);
        const semi = sizeLine.indexOf(";");        // strip chunk extensions
        if (semi !== -1) sizeLine = sizeLine.substring(0, semi);
        const size = parseInt(sizeLine, 16);
        if (isNaN(size)) break;                   // malformed; wait for more
        if (size === 0) return { out: out, done: true };
        const dataStart = nl + 2;
        if (n < dataStart + size + 2) break;      // data + trailing CRLF incomplete
        out += buf.substring(dataStart, dataStart + size);
        i = dataStart + size + 2;                 // skip data + CRLF
    }
    return { out: out, done: false };
}

// Encode one chunk frame: "<hexlen>\r\n<data>\r\n". Zero-length data yields the
// terminator "0\r\n\r\n".
function _encodeChunk(s) {
    const len = _byteLen(s);
    if (len === 0) return "0\r\n\r\n";
    return len.toString(16) + "\r\n" + s + "\r\n";
}

// A header value may list several tokens ("gzip, chunked"); test membership.
function _headerHas(value, token) {
    if (typeof value !== "string") return false;
    return value.toLowerCase().indexOf(token) !== -1;
}

// Parse "Name: value" header lines into a lowercased-key object.
function _parseHeaderLines(lines, start, headers) {
    for (let i = start; i < lines.length; i++) {
        const line = lines[i];
        if (line.length === 0) continue;
        const c = line.indexOf(":");
        if (c === -1) continue;
        const name = _trim(line.substring(0, c)).toLowerCase();
        const value = _trim(line.substring(c + 1));
        headers[name] = value;
    }
}

class IncomingMessage extends EventEmitter {
    constructor(socket) {
        super();
        this.socket = socket;
        this.connection = socket;
        this.headers = {};
        this.rawHeaders = [];
        this.method = null;
        this.url = null;
        this.httpVersion = "1.1";
        this.statusCode = null;
        this.statusMessage = null;
        this.complete = false;
    }
    setEncoding(enc) { this._encoding = enc; return this; }
    setTimeout(ms, cb) { return this; }
    destroy(err) { if (this.socket) this.socket.destroy(err); return this; }
}

class ServerResponse extends EventEmitter {
    constructor(socket) {
        super();
        this.socket = socket;
        this.connection = socket;
        this.statusCode = 200;
        this.statusMessage = null;
        this.headersSent = false;
        this.finished = false;
        this._headers = {};
        this._chunked = false;
        // 'close' unless the request asked to keep the connection alive; set by
        // the server's request dispatch from the request's Connection header.
        this._keepAlive = false;
    }
    setHeader(name, value) { this._headers[name.toLowerCase()] = { name: name, value: value }; return this; }
    getHeader(name) { const h = this._headers[name.toLowerCase()]; return h ? h.value : undefined; }
    hasHeader(name) { return this._headers[name.toLowerCase()] !== undefined; }
    removeHeader(name) { delete this._headers[name.toLowerCase()]; }
    getHeaderNames() {
        const keys = Object.keys(this._headers), out = [];
        for (let i = 0; i < keys.length; i++) out.push(keys[i]);
        return out;
    }
    writeHead(statusCode, statusMessage, headers) {
        this.statusCode = statusCode;
        if (typeof statusMessage === "string") this.statusMessage = statusMessage;
        else headers = statusMessage;
        if (headers) {
            const keys = Object.keys(headers);
            for (let i = 0; i < keys.length; i++) this.setHeader(keys[i], headers[keys[i]]);
        }
        return this;
    }
    _sendHeaders() {
        if (this.headersSent) return;
        this.headersSent = true;
        const msg = this.statusMessage || _statusText(this.statusCode);
        let head = "HTTP/1.1 " + this.statusCode + " " + msg + "\r\n";
        const keys = Object.keys(this._headers);
        let hasConn = false, hasLen = false, hasTE = false;
        for (let i = 0; i < keys.length; i++) {
            const h = this._headers[keys[i]];
            head += h.name + ": " + h.value + "\r\n";
            if (keys[i] === "connection") hasConn = true;
            if (keys[i] === "content-length") hasLen = true;
            if (keys[i] === "transfer-encoding") hasTE = true;
        }
        // Streaming write() without a declared length -> chunked framing.
        if (this._chunked && !hasLen && !hasTE) head += "Transfer-Encoding: chunked\r\n";
        if (!hasConn) head += (this._keepAlive ? "Connection: keep-alive\r\n" : "Connection: close\r\n");
        head += "\r\n";
        this.socket.write(head);
    }
    write(chunk, encoding, cb) {
        // First streaming write with no Content-Length: commit to chunked so the
        // body is self-framed (peer needs no EOF / can keep the socket alive).
        if (!this.headersSent && !this.hasHeader("content-length")) this._chunked = true;
        this._sendHeaders();
        const s = _chunkToStr(chunk);
        if (s.length > 0) this.socket.write(this._chunked ? _encodeChunk(s) : s);
        if (typeof encoding === "function") encoding();
        else if (typeof cb === "function") cb();
        return true;
    }
    end(chunk, encoding, cb) {
        if (typeof chunk === "function") { cb = chunk; chunk = undefined; }
        else if (typeof encoding === "function") { cb = encoding; encoding = undefined; }
        const body = _chunkToStr(chunk);
        if (!this.headersSent && !this._chunked && !this.hasHeader("content-length")) {
            // Whole body known at end() -> Content-Length (keeps keep-alive viable).
            this.setHeader("Content-Length", _byteLen(body));
        }
        this._sendHeaders();
        if (this._chunked) {
            if (body.length > 0) this.socket.write(_encodeChunk(body));
            this.socket.write("0\r\n\r\n");           // terminating chunk
        } else if (body.length > 0) {
            this.socket.write(body);
        }
        this.finished = true;
        this.emit("finish");
        // With keep-alive the response is self-delimited (Content-Length or the
        // chunked terminator), so leave the socket open for reuse. Otherwise end
        // the TCP connection so the client sees EOF = response complete.
        if (!this._keepAlive) this.socket.end();
        this.emit("close");
        if (typeof cb === "function") cb();
        return this;
    }
}

// NOTE: named HttpServer (not Server) — the compiler shares one global label per
// top-level definition name across all compiled modules, so a `Server` here would
// collide with net.js's `Server` (net.connect/createServer would build the wrong
// class). Same reason createServer is `httpCreateServer` internally. Public names
// are restored in the export clause.
class HttpServer extends EventEmitter {
    constructor(options, requestListener) {
        super();
        if (typeof options === "function") { requestListener = options; options = undefined; }
        if (typeof requestListener === "function") this.on("request", requestListener);
        this._net = _netCreateServer();
        const self = this;
        this._net.on("connection", function (socket) { self._onConnection(socket); });
        this._net.on("error", function (err) { self.emit("error", err); });
    }

    _onConnection(socket) {
        const self = this;
        this.emit("connection", socket);
        // Shared parse state on a captured object (see ClientRequest._send for
        // why not `let` scalars). mode: "none" | "length" | "chunked".
        const st = { buf: "", req: null, res: null, parsed: false, mode: "none",
                     needBody: 0, gotBody: 0, rawBody: "", ka: false };
        const resetForNext = function () {
            st.req = null; st.res = null; st.parsed = false; st.mode = "none";
            st.needBody = 0; st.gotBody = 0; st.rawBody = "";
        };
        const finishReq = function () {
            if (st.mode === "chunked") {
                const dec = _decodeChunked(st.rawBody);
                if (dec.out.length > 0) st.req.emit("data", dec.out);
            }
            if (!st.req.complete) { st.req.complete = true; st.req.emit("end"); }
            // Opt-in keep-alive: reuse the connection for a pipelined request.
            if (st.ka && !socket.destroyed) {
                const leftover = st.buf;
                resetForNext();
                st.buf = leftover;
                if (leftover.length > 0) pump();
            }
        };
        const pump = function () {
            if (!st.parsed) {
                const idx = st.buf.indexOf("\r\n\r\n");
                if (idx === -1) return;
                const head = st.buf.substring(0, idx);
                st.buf = st.buf.substring(idx + 4);
                const lines = _splitLines(head);
                const req = new IncomingMessage(socket);
                const rl = lines[0].split(" ");
                req.method = rl[0] || "GET";
                req.url = rl[1] || "/";
                if (rl[2] && rl[2].indexOf("/") !== -1) req.httpVersion = rl[2].substring(rl[2].indexOf("/") + 1);
                _parseHeaderLines(lines, 1, req.headers);
                const res = new ServerResponse(socket);
                // Keep-alive is opt-in via an explicit Connection: keep-alive on the
                // request (deviation from HTTP/1.1's keep-alive-by-default): our
                // runtime keeps polling any open fd, so defaulting to persistent
                // connections would keep the event loop alive and stall process
                // exit. Explicit opt-in lets a client manage the socket lifetime.
                st.ka = _headerHas(req.headers["connection"], "keep-alive");
                res._keepAlive = st.ka;
                const te = req.headers["transfer-encoding"];
                if (_headerHas(te, "chunked")) {
                    st.mode = "chunked";
                } else {
                    const cl = req.headers["content-length"];
                    st.needBody = cl ? parseInt(cl, 10) : 0;
                    st.mode = st.needBody > 0 ? "length" : "none";
                }
                st.req = req; st.res = res; st.parsed = true;
                self.emit("request", req, res);
            }
            if (st.mode === "length") {
                if (st.buf.length > 0 && st.gotBody < st.needBody) {
                    const remaining = st.needBody - st.gotBody;
                    const chunk = st.buf.length <= remaining ? st.buf : st.buf.substring(0, remaining);
                    st.buf = st.buf.length <= remaining ? "" : st.buf.substring(remaining);
                    st.req.emit("data", chunk);
                    st.gotBody += chunk.length;
                }
                if (st.gotBody >= st.needBody) finishReq();
            } else if (st.mode === "chunked") {
                st.rawBody += st.buf; st.buf = "";
                if (_decodeChunked(st.rawBody).done) finishReq();
            } else {
                finishReq();
            }
        };
        socket.on("data", function (chunk) { st.buf += _chunkToStr(chunk); pump(); });
        socket.on("end", function () {
            if (st.req && !st.req.complete) {
                if (st.mode === "chunked") {
                    const dec = _decodeChunked(st.rawBody);
                    if (dec.out.length > 0) st.req.emit("data", dec.out);
                }
                st.req.complete = true;
                st.req.emit("end");
            }
        });
    }

    listen(port, host, backlog, cb) {
        this._net.listen(port, host, backlog, cb);
        const self = this;
        this._net.once("listening", function () { self.emit("listening"); });
        return this;
    }
    address() { return this._net.address(); }
    close(cb) { this._net.close(cb); this.emit("close"); return this; }
    setTimeout(ms, cb) { return this; }
    ref() { return this; }
    unref() { return this; }
}

class ClientRequest extends EventEmitter {
    constructor(options, cb) {
        super();
        if (typeof options === "string") options = _parseUrl(options);
        this.method = (options.method || "GET").toUpperCase();
        this.path = options.path || "/";
        this.host = options.hostname || options.host || "127.0.0.1";
        this.port = options.port || 80;
        this._headers = {};
        if (options.headers) {
            const keys = Object.keys(options.headers);
            for (let i = 0; i < keys.length; i++) this.setHeader(keys[i], options.headers[keys[i]]);
        }
        this._body = "";        // buffered Content-Length body
        this._framed = "";      // pre-framed chunked body
        this.finished = false;
        // Resolve the connection Agent: `agent: false` opts out of pooling
        // entirely; otherwise use the caller's Agent or the shared globalAgent
        // (whose keepAlive defaults to false => Connection: close, clean exit).
        this._agent = (options && options.agent === false) ? null
            : ((options && options.agent) || globalAgent);
        // Keep-alive is on when the request header asks for it OR the Agent is a
        // keep-alive Agent. globalAgent (default) is not keep-alive, so plain
        // requests stay Connection: close and never stall process exit.
        this._keepAlive = _headerHas(this.getHeader("connection"), "keep-alive")
            || (this._agent ? !!this._agent.keepAlive : false);
        // Optional pre-connected socket (explicit reuse). When set, _send writes
        // onto it instead of dialing or pulling from the Agent pool.
        this._reuseSocket = (options && options._reuseSocket) || null;
        if (typeof cb === "function") this.once("response", cb);
    }
    setHeader(name, value) { this._headers[name.toLowerCase()] = { name: name, value: value }; return this; }
    getHeader(name) { const h = this._headers[name.toLowerCase()]; return h ? h.value : undefined; }
    removeHeader(name) { delete this._headers[name.toLowerCase()]; }
    _isChunkedReq() { return _headerHas(this.getHeader("transfer-encoding"), "chunked"); }
    write(chunk, encoding, cb) {
        const s = _chunkToStr(chunk);
        if (this._isChunkedReq()) this._framed += _encodeChunk(s);
        else this._body += s;
        if (typeof cb === "function") cb();
        return true;
    }
    end(chunk, encoding, cb) {
        if (typeof chunk === "function") { cb = chunk; chunk = undefined; }
        const s = _chunkToStr(chunk);
        if (this._isChunkedReq()) this._framed += _encodeChunk(s);
        else this._body += s;
        this._send();
        this.finished = true;
        if (typeof cb === "function") cb();
        return this;
    }
    abort() { if (this.socket) this.socket.destroy(); return this; }
    destroy(err) { if (this.socket) this.socket.destroy(err); return this; }
    setTimeout(ms, cb) { return this; }

    _send() {
        const chunkedReq = this._isChunkedReq();
        let msg = this.method + " " + this.path + " HTTP/1.1\r\n";
        const keys = Object.keys(this._headers);
        let hasHost = false, hasLen = false, hasConn = false;
        for (let i = 0; i < keys.length; i++) {
            const h = this._headers[keys[i]];
            msg += h.name + ": " + h.value + "\r\n";
            if (keys[i] === "host") hasHost = true;
            if (keys[i] === "content-length") hasLen = true;
            if (keys[i] === "connection") hasConn = true;
        }
        if (!hasHost) msg += "Host: " + this.host + ":" + this.port + "\r\n";
        let body;
        if (chunkedReq) {
            body = this._framed + "0\r\n\r\n";   // TE: chunked header supplied by caller
        } else {
            body = this._body;
            if (!hasLen && body.length > 0) msg += "Content-Length: " + _byteLen(body) + "\r\n";
        }
        if (!hasConn) msg += (this._keepAlive ? "Connection: keep-alive\r\n" : "Connection: close\r\n");
        msg += "\r\n" + body;

        const self = this;
        // Socket selection: explicit reuse hook > Agent free-socket pool > fresh
        // dial (tracked in the Agent as in-use). The pool name keys host:port.
        const agent = this._agent;
        const name = agent ? agent.getName({ host: this.host, port: this.port }) : "";
        let socket = this._reuseSocket;
        if (!socket && agent) socket = agent._acquire(name);   // reused: listeners already reset, tracked
        if (!socket) {
            socket = _netConnect(this.port, this.host);
            if (agent) { agent._track(name, socket); agent.created++; }
        }
        this.socket = socket;
        socket.on("error", function (err) { self.emit("error", err); });

        // Shared parse state lives on a captured object, not on `let` scalars:
        // the compiler does not reliably share writes to a captured scalar across
        // sibling closures when `this`/`self` is also captured in a class method.
        // mode: "eof" (close-delimited) | "length" | "chunked". `name`/`agent`
        // ride on st too (same capture-safety reason).
        const st = { rbuf: "", res: null, parsed: false, mode: "eof",
                     needBody: 0, gotBody: 0, rawBody: "", done: false,
                     name: name, agent: agent };
        const complete = function () {
            if (st.done) return;
            st.done = true;
            if (st.mode === "chunked") {
                const dec = _decodeChunked(st.rawBody);
                if (dec.out.length > 0) st.res.emit("data", dec.out);
            }
            // Pool/close the socket BEFORE signalling 'end'. The user's 'end'
            // handler routinely fires the *next* request synchronously; releasing
            // first lets that request pull this freed socket back out of the pool
            // (otherwise the pool is still empty and it dials a new connection).
            // On a keep-alive Agent the socket is parked idle (unwatched, so it
            // never stalls process exit); otherwise it is closed so the loop can
            // drain (the server is also closing on its Connection: close).
            if (self._keepAlive && st.agent && socket && !socket.destroyed) {
                st.agent._release(st.name, socket);
            } else if (socket && !socket.destroyed) {
                if (st.agent) st.agent._untrack(st.name, socket);
                socket.destroy();
            }
            if (!st.res.complete) { st.res.complete = true; st.res.emit("end"); }
        };
        socket.on("data", function (chunk) {
            st.rbuf += _chunkToStr(chunk);
            if (!st.parsed) {
                const idx = st.rbuf.indexOf("\r\n\r\n");
                if (idx === -1) return;
                const head = st.rbuf.substring(0, idx);
                st.rbuf = st.rbuf.substring(idx + 4);
                const lines = _splitLines(head);
                const res = new IncomingMessage(socket);
                const sl = lines[0].split(" ");
                if (sl[0] && sl[0].indexOf("/") !== -1) res.httpVersion = sl[0].substring(sl[0].indexOf("/") + 1);
                res.statusCode = parseInt(sl[1], 10) || 0;
                res.statusMessage = lines[0].substring(lines[0].indexOf(sl[1]) + (sl[1] ? sl[1].length : 0) + 1);
                _parseHeaderLines(lines, 1, res.headers);
                st.res = res;
                st.parsed = true;
                if (_headerHas(res.headers["transfer-encoding"], "chunked")) {
                    st.mode = "chunked";
                } else {
                    const cl = res.headers["content-length"];
                    if (cl !== undefined) { st.mode = "length"; st.needBody = parseInt(cl, 10) || 0; }
                    else st.mode = "eof";
                }
                self.emit("response", res);
            }
            if (st.done) return;
            if (st.mode === "chunked") {
                st.rawBody += st.rbuf; st.rbuf = "";
                if (_decodeChunked(st.rawBody).done) complete();
            } else if (st.mode === "length") {
                if (st.rbuf.length > 0 && st.gotBody < st.needBody) {
                    const remaining = st.needBody - st.gotBody;
                    const c = st.rbuf.length <= remaining ? st.rbuf : st.rbuf.substring(0, remaining);
                    st.rbuf = st.rbuf.length <= remaining ? "" : st.rbuf.substring(remaining);
                    st.res.emit("data", c);
                    st.gotBody += c.length;
                }
                if (st.gotBody >= st.needBody) complete();
            } else if (st.rbuf.length > 0) {
                st.res.emit("data", st.rbuf);
                st.rbuf = "";
            }
        });
        socket.on("end", function () {
            if (st.res && !st.done) {
                if (st.mode === "chunked") {
                    const dec = _decodeChunked(st.rawBody);
                    if (dec.out.length > 0) st.res.emit("data", dec.out);
                }
                st.done = true;
                if (!st.res.complete) { st.res.complete = true; st.res.emit("end"); }
            }
            // Peer closed the connection: the socket is dead, so drop it from the
            // Agent's in-use set (it can never be pooled/reused now).
            if (st.agent) st.agent._untrack(st.name, socket);
            self.emit("close");
        });
        socket.write(msg);
    }
}

// Connection Agent with real cross-request socket pooling. A keep-alive Agent
// (`new http.Agent({ keepAlive: true })`) reuses one TCP connection for
// sequential requests to the same host:port: on response completion the socket
// is parked idle in `freeSockets`, and the next request to the same name pulls
// it back out instead of dialing a fresh connection.
//
// Clean process exit: asm.js's event loop (net.js poll pump) runs as long as any
// fd is watched. A parked free socket is therefore _stopRead()'d (its poll
// watcher removed) so it never keeps the loop alive — the open fd is closed by
// the OS on exit, or eagerly by `agent.destroy()`. Per-request listener reset:
// a reused socket has its stale 'data'/'end'/'error'/'close' listeners cleared
// before the next request rewires it, so old response parsers do not double-fire.
class Agent {
    constructor(options) {
        options = options || {};
        this.keepAlive = !!options.keepAlive;
        this.keepAliveMsecs = options.keepAliveMsecs || 1000;
        this.maxSockets = options.maxSockets || Infinity;
        this.maxFreeSockets = options.maxFreeSockets || 256;
        this.sockets = {};       // name -> [in-use sockets]
        this.freeSockets = {};   // name -> [idle keep-alive sockets]
        this.requests = {};
        this.reused = 0;         // diagnostics: # of pooled-socket reuses
        this.created = 0;        // diagnostics: # of fresh dials
    }
    getName(options) {
        options = options || {};
        return (options.host || "localhost") + ":" + (options.port || "") + ":" + (options.localAddress || "");
    }
    // Detach any per-request listeners left over from a previous request so a
    // reused socket does not fire the old parser.
    _resetListeners(s) {
        s.removeAllListeners("data");
        s.removeAllListeners("end");
        s.removeAllListeners("error");
        s.removeAllListeners("close");
    }
    // Pull a live idle socket for `name` (per-request listeners cleared) and mark
    // it in-use; null if none available.
    _acquire(name) {
        const free = this.freeSockets[name];
        while (free && free.length > 0) {
            const s = free.pop();
            if (s && !s.destroyed && s.fd >= 0) {
                this._resetListeners(s);
                this._track(name, s);
                this.reused++;
                return s;
            }
        }
        return null;
    }
    _track(name, s) {
        if (!this.sockets[name]) this.sockets[name] = [];
        this.sockets[name].push(s);
    }
    _untrack(name, s) {
        const arr = this.sockets[name];
        if (!arr) return;
        const i = arr.indexOf(s);
        if (i !== -1) arr.splice(i, 1);
    }
    _busyCount(name) { return this.sockets[name] ? this.sockets[name].length : 0; }
    // Park a keep-alive socket idle after its response completed: stop watching
    // it (so the loop can drain) and hold it for the next same-name request.
    _release(name, s) {
        this._untrack(name, s);
        if (!s || s.destroyed || s.fd < 0) return;
        s._stopRead();
        this._resetListeners(s);
        if (!this.freeSockets[name]) this.freeSockets[name] = [];
        if (this.freeSockets[name].length < this.maxFreeSockets) this.freeSockets[name].push(s);
        else s.destroy();
    }
    _destroyList(map) {
        const names = Object.keys(map);
        for (let i = 0; i < names.length; i++) {
            const arr = map[names[i]];
            for (let j = 0; j < arr.length; j++) {
                const s = arr[j];
                if (s && !s.destroyed) s.destroy();
            }
        }
    }
    destroy() {
        this._destroyList(this.freeSockets);
        this._destroyList(this.sockets);
        this.freeSockets = {};
        this.sockets = {};
    }
}
const globalAgent = new Agent();

// Minimal URL parser for http.get("http://host:port/path") form.
function _parseUrl(u) {
    const out = { protocol: "http:", host: "127.0.0.1", hostname: "127.0.0.1", port: 80, path: "/" };
    let s = u;
    const p = s.indexOf("://");
    if (p !== -1) { out.protocol = s.substring(0, p + 1); s = s.substring(p + 3); }
    let slash = s.indexOf("/");
    let authority = slash === -1 ? s : s.substring(0, slash);
    out.path = slash === -1 ? "/" : s.substring(slash);
    const colon = authority.indexOf(":");
    if (colon !== -1) {
        out.hostname = authority.substring(0, colon);
        out.port = parseInt(authority.substring(colon + 1), 10) || 80;
    } else {
        out.hostname = authority;
    }
    out.host = out.hostname;
    return out;
}

function httpCreateServer(options, requestListener) { return new HttpServer(options, requestListener); }

function httpRequest(options, cb) { return new ClientRequest(options, cb); }

function httpGet(options, cb) {
    const req = httpRequest(options, cb);
    req.end();
    return req;
}

const METHODS = ["GET", "POST", "PUT", "DELETE", "HEAD", "OPTIONS", "PATCH", "TRACE", "CONNECT"];
const STATUS_CODES = _STATUS;

export {
    HttpServer as Server, ServerResponse, IncomingMessage, ClientRequest,
    httpCreateServer as createServer, httpRequest as request, httpGet as get,
    Agent, globalAgent, METHODS, STATUS_CODES
};
export default {
    Server: HttpServer, ServerResponse: ServerResponse, IncomingMessage: IncomingMessage,
    ClientRequest: ClientRequest, createServer: httpCreateServer, request: httpRequest,
    get: httpGet, Agent: Agent, globalAgent: globalAgent,
    METHODS: METHODS, STATUS_CODES: STATUS_CODES,
};
