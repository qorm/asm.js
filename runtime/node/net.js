// asm.js Runtime - Node.js net (nonblocking IPv4 TCP + Unix sockets)
//
// A single poll/ppoll pump drives nonblocking connect, accept, read and write.
// The pump schedules refed or unref timeout tasks according to its watchers, so
// socket.unref()/server.unref() do not keep the process alive. IPv6 text
// classification and IPv4-mapped IPv6 endpoints are supported; wire TCP remains
// IPv4. Unix domain sockets use AF_UNIX. Hostname resolution reads /etc/hosts
// (no dns import: that would cycle net -> dns -> dgram -> net).

import { EventEmitter } from "./events.js";
import { getSyscall } from "./constants.js";
import { Buffer as _Buf } from "./buffer.js";
import { readFileSync, unlinkSync } from "./fs.js";

const AF_INET = 2;
const AF_UNIX = 1;
const SOCK_STREAM = 1;
const IPPROTO_TCP = 6;

const POLLIN = 0x0001;
const POLLOUT = 0x0004;
const POLLERR = 0x0008;
const POLLHUP = 0x0010;
const POLLNVAL = 0x0020;

const F_GETFL = 3;
const F_SETFL = 4;
const WRITE_HIGH_WATER_MARK = 65536;
const UNIX_SOCKADDR_LEN = 110;

const _watchers = [];
const _timeoutSockets = [];
let _pumpArmed = false;
let _pumpHandle = null;
let _pumpIdle = 0;
let _hostsCache = null;
let _autoSelectFamily = false;
let _autoSelectFamilyAttemptTimeout = 250;

function _platform() {
    const p = __get_process();
    return (p && p.platform) || "macos";
}

function _arch() {
    const p = __get_process();
    return (p && p.arch) || "arm64";
}

function _pollUsesPpoll() {
    return _platform() === "linux" && _arch() === "arm64";
}

function _isWouldBlock(rc) {
    return rc === -11 || rc === -35;
}

function _isInProgress(rc) {
    return rc === -115 || rc === -36 || rc === -114 || rc === -37;
}

function _isInterrupted(rc) {
    return rc === -4;
}

function _errnoName(rc) {
    const n = rc < 0 ? -rc : rc;
    const mac = _platform() === "macos";
    if (n === 9) return "EBADF";
    if (n === 13) return "EACCES";
    if (n === 22) return "EINVAL";
    if (n === 32) return "EPIPE";
    if (n === (mac ? 35 : 11)) return "EAGAIN";
    if (n === (mac ? 36 : 115)) return "EINPROGRESS";
    if (n === (mac ? 37 : 114)) return "EALREADY";
    if (n === (mac ? 48 : 98)) return "EADDRINUSE";
    if (n === (mac ? 51 : 101)) return "ENETUNREACH";
    if (n === (mac ? 54 : 104)) return "ECONNRESET";
    if (n === (mac ? 57 : 107)) return "ENOTCONN";
    if (n === (mac ? 60 : 110)) return "ETIMEDOUT";
    if (n === (mac ? 61 : 111)) return "ECONNREFUSED";
    if (n === (mac ? 65 : 113)) return "EHOSTUNREACH";
    return "EUNKNOWN";
}

function _sockErr(op, rc, socket) {
    const e = new Error("net " + op + " failed (rc=" + rc + ")");
    e.code = _errnoName(rc);
    e.errno = rc;
    e.syscall = op;
    if (socket) {
        if (socket._remoteAddress) e.address = socket._remoteAddress;
        if (socket._remotePort) e.port = socket._remotePort;
    }
    return e;
}

function _writeU32(ptr, value) {
    __setChar(ptr + 0, value & 0xff);
    __setChar(ptr + 1, (value >> 8) & 0xff);
    __setChar(ptr + 2, (value >> 16) & 0xff);
    __setChar(ptr + 3, (value >> 24) & 0xff);
}

function _readU32(ptr) {
    return (__getChar(ptr + 0) |
        (__getChar(ptr + 1) << 8) |
        (__getChar(ptr + 2) << 16) |
        (__getChar(ptr + 3) << 24)) >>> 0;
}

function _watchHasRefed() {
    for (let i = 0; i < _watchers.length; i++) {
        if (_watchers[i].refed) return true;
    }
    return false;
}

function _armPump() {
    if (_pumpArmed || _watchers.length === 0) return;
    _pumpArmed = true;
    _pumpHandle = setImmediate(_pumpTick);
}

function _restartPump() {
    if (_pumpArmed && _pumpHandle) clearImmediate(_pumpHandle);
    _pumpArmed = false;
    _pumpHandle = null;
    _armPump();
}

function _watchAdd(fd, events, onReady, refed) {
    const isRefed = refed === undefined ? true : !!refed;
    for (let i = 0; i < _watchers.length; i++) {
        if (_watchers[i].fd === fd) {
            const changedRef = _watchers[i].refed !== isRefed;
            _watchers[i].events = events;
            _watchers[i].onReady = onReady;
            _watchers[i].refed = isRefed;
            if (changedRef) _restartPump();
            else _armPump();
            return;
        }
    }
    _watchers.push({ fd: fd, events: events, onReady: onReady, refed: isRefed });
    _restartPump();
}

function _watchRemove(fd) {
    let removed = false;
    for (let i = _watchers.length - 1; i >= 0; i--) {
        if (_watchers[i].fd === fd) {
            _watchers.splice(i, 1);
            removed = true;
        }
    }
    if (removed) _restartPump();
}

function _nextPollTimeout() {
    let timeout = 1000;
    const now = Date.now();
    for (let i = 0; i < _timeoutSockets.length; i++) {
        const s = _timeoutSockets[i];
        if (!s || s.destroyed || s.fd < 0 || s._timeoutAt <= 0) continue;
        const left = s._timeoutAt - now;
        if (left <= 0) return 0;
        if (left < timeout) timeout = left;
    }
    if (timeout < 1) return 1;
    return timeout | 0;
}

function _checkSocketTimeouts() {
    const now = Date.now();
    for (let i = _timeoutSockets.length - 1; i >= 0; i--) {
        const s = _timeoutSockets[i];
        if (!s || s.destroyed || s.fd < 0) {
            _timeoutSockets.splice(i, 1);
            continue;
        }
        if (s._timeoutAt > 0 && now >= s._timeoutAt) {
            s._timeoutAt = 0;
            s.emit("timeout");
        }
    }
}

function _buildPollfds(n) {
    const fds = __alloc(n * 8);
    for (let i = 0; i < n; i++) {
        const w = _watchers[i];
        const base = fds + i * 8;
        _writeU32(base, w.fd);
        __setChar(base + 4, w.events & 0xff);
        __setChar(base + 5, (w.events >> 8) & 0xff);
        __setChar(base + 6, 0);
        __setChar(base + 7, 0);
    }
    return fds;
}

function _pollWait(fds, n, timeout) {
    const sc = getSyscall("poll");
    if (sc < 0) return -1;
    if (_pollUsesPpoll()) {
        const ts = __alloc(16);
        for (let i = 0; i < 16; i++) __setChar(ts + i, 0);
        if (timeout >= 1000) {
            _writeU32(ts, 1);
        } else {
            _writeU32(ts + 8, timeout * 1000000);
        }
        return __syscall(sc, fds, n, ts, 0, 0);
    }
    return __syscall(sc, fds, n, timeout);
}

function _dispatchReady(timeout) {
    const n = _watchers.length;
    if (n === 0) return 0;
    const fds = _buildPollfds(n);
    const rc = _pollWait(fds, n, timeout);
    if (rc <= 0) return rc;
    const ready = [];
    for (let i = 0; i < n; i++) {
        const base = fds + i * 8;
        const revents = __getChar(base + 6) | (__getChar(base + 7) << 8);
        if (revents !== 0 && _watchers[i]) ready.push({ watcher: _watchers[i], revents: revents });
    }
    for (let i = 0; i < ready.length; i++) {
        const item = ready[i];
        if (_watchers.indexOf(item.watcher) !== -1) item.watcher.onReady(item.revents);
    }
    return rc;
}

function _pumpTick() {
    _pumpArmed = false;
    _pumpHandle = null;
    const n = _watchers.length;
    if (n === 0) return;

    const rc = _dispatchReady(_nextPollTimeout());
    if (rc > 0) {
        _pumpIdle = 0;
    } else if (rc < 0 && !_isInterrupted(rc)) {
        _pumpIdle++;
    } else {
        _pumpIdle = 0;
    }

    _checkSocketTimeouts();
    if (_pumpIdle > 30 || !_watchHasRefed()) {
        _watchers.length = 0;
        return;
    }
    _armPump();
}

function _pollOne(fd, events) {
    const fds = __alloc(8);
    _writeU32(fds, fd);
    __setChar(fds + 4, events & 0xff);
    __setChar(fds + 5, (events >> 8) & 0xff);
    while (true) {
        __setChar(fds + 6, 0);
        __setChar(fds + 7, 0);
        const rc = _pollWait(fds, 1, 1000);
        if (rc > 0) return __getChar(fds + 6) | (__getChar(fds + 7) << 8);
        if (rc < 0 && !_isInterrupted(rc)) return 0;
    }
}

function _parseIPv4(host) {
    if (host === undefined || host === null || host === "" || host === "localhost") return [127, 0, 0, 1];
    if (host === "0.0.0.0") return [0, 0, 0, 0];
    if (typeof host !== "string") return null;
    const parts = host.split(".");
    if (parts.length !== 4) return null;
    const out = [];
    for (let i = 0; i < 4; i++) {
        const seg = parts[i];
        if (seg.length === 0 || seg.length > 3) return null;
        let value = 0;
        for (let k = 0; k < seg.length; k++) {
            const c = seg.charCodeAt(k);
            if (c < 48 || c > 57) return null;
            value = value * 10 + c - 48;
        }
        if (value > 255) return null;
        out.push(value);
    }
    return out;
}

function _parseHexGroup(part) {
    if (part.length < 1 || part.length > 4) return -1;
    let value = 0;
    for (let i = 0; i < part.length; i++) {
        const c = part.charCodeAt(i);
        let digit = -1;
        if (c >= 48 && c <= 57) digit = c - 48;
        else if (c >= 65 && c <= 70) digit = c - 55;
        else if (c >= 97 && c <= 102) digit = c - 87;
        if (digit < 0) return -1;
        value = value * 16 + digit;
    }
    return value;
}

function _parseIPv6(input) {
    if (typeof input !== "string" || input.length < 2) return null;
    if (input.indexOf("%") !== -1) return null;
    const doubleAt = input.indexOf("::");
    if (doubleAt !== -1 && input.indexOf("::", doubleAt + 2) !== -1) return null;
    if (doubleAt === -1 && (input.charAt(0) === ":" || input.charAt(input.length - 1) === ":")) return null;

    const leftText = doubleAt === -1 ? input : input.substring(0, doubleAt);
    const rightText = doubleAt === -1 ? "" : input.substring(doubleAt + 2);
    const leftParts = leftText === "" ? [] : leftText.split(":");
    const rightParts = rightText === "" ? [] : rightText.split(":");

    function parsePart(part, allowIPv4) {
        if (part.indexOf(".") !== -1) {
            if (!allowIPv4) return null;
            const ip = _parseIPv4(part);
            if (ip === null) return null;
            return [(ip[0] << 8) | ip[1], (ip[2] << 8) | ip[3]];
        }
        const value = _parseHexGroup(part);
        if (value < 0) return null;
        return [value];
    }

    const left = [];
    for (let i = 0; i < leftParts.length; i++) {
        const allowIPv4 = i === leftParts.length - 1 && rightParts.length === 0;
        const vals = parsePart(leftParts[i], allowIPv4);
        if (!vals) return null;
        for (let k = 0; k < vals.length; k++) left.push(vals[k]);
    }
    const right = [];
    for (let i = 0; i < rightParts.length; i++) {
        const vals = parsePart(rightParts[i], i === rightParts.length - 1);
        if (!vals) return null;
        for (let k = 0; k < vals.length; k++) right.push(vals[k]);
    }

    const total = left.length + right.length;
    if (doubleAt === -1) {
        if (total !== 8) return null;
        for (let i = 0; i < right.length; i++) left.push(right[i]);
        return left;
    }
    if (total >= 8) return null;
    const groups = [];
    for (let i = 0; i < left.length; i++) groups.push(left[i]);
    while (groups.length < 8 - right.length) groups.push(0);
    for (let i = 0; i < right.length; i++) groups.push(right[i]);
    return groups.length === 8 ? groups : null;
}

function _ipv4FromMapped(groups) {
    if (!groups || groups.length !== 8) return null;
    for (let i = 0; i < 5; i++) {
        if (groups[i] !== 0) return null;
    }
    if (groups[5] !== 0xffff) return null;
    return [
        (groups[6] >> 8) & 0xff,
        groups[6] & 0xff,
        (groups[7] >> 8) & 0xff,
        groups[7] & 0xff
    ];
}

function _ipv4Text(ip) {
    return ip[0] + "." + ip[1] + "." + ip[2] + "." + ip[3];
}

function _ipv4ToInt(ip) {
    return ((ip[0] << 24) | (ip[1] << 16) | (ip[2] << 8) | ip[3]) >>> 0;
}

function _isWs(c) {
    return c === 32 || c === 9 || c === 10 || c === 13;
}

function _splitWs(line) {
    const out = [];
    let i = 0;
    while (i < line.length) {
        while (i < line.length && _isWs(line.charCodeAt(i))) i++;
        if (i >= line.length) break;
        const start = i;
        while (i < line.length && !_isWs(line.charCodeAt(i))) i++;
        out.push(line.substring(start, i));
    }
    return out;
}

function _loadHosts() {
    if (_hostsCache) return _hostsCache;
    const map = {};
    let text = "";
    try { text = readFileSync("/etc/hosts", "utf8") || ""; } catch (e) { text = ""; }
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
        let line = lines[i];
        const hash = line.indexOf("#");
        if (hash !== -1) line = line.substring(0, hash);
        const parts = _splitWs(line);
        if (parts.length < 2) continue;
        if (_parseIPv4(parts[0]) === null) continue;
        for (let k = 1; k < parts.length; k++) {
            if (!map[parts[k]]) map[parts[k]] = parts[0];
        }
    }
    if (!map.localhost) map.localhost = "127.0.0.1";
    _hostsCache = map;
    return map;
}

function _hostToIPv4(host) {
    if (host === undefined || host === null || host === "") return [127, 0, 0, 1];
    if (typeof host !== "string") return null;
    let ip = _parseIPv4(host);
    if (ip) return ip;
    const v6 = _parseIPv6(host);
    if (v6) return _ipv4FromMapped(v6);
    const mapped = _loadHosts()[host];
    if (mapped) return _parseIPv4(mapped);
    return null;
}

function _listenHostOk(host) {
    if (host === undefined || host === null || host === "") return true;
    if (_parseIPv4(host)) return true;
    const v6 = _parseIPv6(host);
    return !!(v6 && _ipv4FromMapped(v6));
}

function _makeSockaddr(port, host) {
    let ip = _parseIPv4(host);
    if (ip === null) {
        const v6 = _parseIPv6(host);
        ip = v6 ? _ipv4FromMapped(v6) : null;
    }
    if (ip === null) ip = [127, 0, 0, 1];
    const sa = __alloc(16);
    if (_platform() === "macos") {
        __setChar(sa + 0, 16);
        __setChar(sa + 1, AF_INET);
    } else {
        __setChar(sa + 0, AF_INET);
        __setChar(sa + 1, 0);
    }
    __setChar(sa + 2, (port >> 8) & 0xff);
    __setChar(sa + 3, port & 0xff);
    __setChar(sa + 4, ip[0]);
    __setChar(sa + 5, ip[1]);
    __setChar(sa + 6, ip[2]);
    __setChar(sa + 7, ip[3]);
    for (let i = 8; i < 16; i++) __setChar(sa + i, 0);
    return sa;
}

function _makeUnixSockaddr(path) {
    const n = path.length;
    const sa = __alloc(UNIX_SOCKADDR_LEN);
    for (let i = 0; i < UNIX_SOCKADDR_LEN; i++) __setChar(sa + i, 0);
    if (_platform() === "macos") {
        __setChar(sa + 0, 2 + n + 1);
        __setChar(sa + 1, AF_UNIX);
    } else {
        __setChar(sa + 0, AF_UNIX);
        __setChar(sa + 1, 0);
    }
    const max = UNIX_SOCKADDR_LEN - 3;
    const copy = n < max ? n : max;
    for (let i = 0; i < copy; i++) __setChar(sa + 2 + i, path.charCodeAt(i) & 0xff);
    return { sa: sa, len: 2 + copy + 1 };
}

function _saFamily(sa) {
    return _platform() === "macos" ? __getChar(sa + 1) : __getChar(sa + 0);
}

function _decodeSockaddr(sa) {
    const family = _saFamily(sa);
    if (family === AF_UNIX) {
        let path = "";
        for (let i = 2; i < UNIX_SOCKADDR_LEN; i++) {
            const c = __getChar(sa + i);
            if (c === 0) break;
            path += String.fromCharCode(c);
        }
        return { port: 0, family: "unix", address: path };
    }
    const port = ((__getChar(sa + 2) << 8) | __getChar(sa + 3)) & 0xffff;
    const address = __getChar(sa + 4) + "." + __getChar(sa + 5) + "." +
        __getChar(sa + 6) + "." + __getChar(sa + 7);
    return { port: port, family: "IPv4", address: address };
}

function _socketName(fd, op) {
    const sc = getSyscall(op);
    if (sc < 0 || fd < 0) return null;
    const sa = __alloc(UNIX_SOCKADDR_LEN);
    for (let i = 0; i < UNIX_SOCKADDR_LEN; i++) __setChar(sa + i, 0);
    const lenp = __alloc(4);
    _writeU32(lenp, UNIX_SOCKADDR_LEN);
    const rc = __syscall(sc, fd, sa, lenp);
    if (rc < 0) return null;
    return _decodeSockaddr(sa);
}

function _boundPort(fd) {
    const address = _socketName(fd, "getsockname");
    return address ? address.port : 0;
}

function _socketOptionConstants() {
    const mac = _platform() === "macos";
    return {
        SOL_SOCKET: mac ? 65535 : 1,
        SO_REUSEADDR: mac ? 4 : 2,
        SO_KEEPALIVE: mac ? 8 : 9,
        SO_ERROR: mac ? 4103 : 4,
        SO_LINGER: mac ? 128 : 13,
        TCP_KEEPIDLE: mac ? 16 : 4,
    };
}

function _setSocketOption(fd, level, option, value) {
    const sc = getSyscall("setsockopt");
    if (sc < 0 || fd < 0) return -1;
    const ptr = __alloc(4);
    _writeU32(ptr, value | 0);
    return __syscall(sc, fd, level, option, ptr, 4);
}

function _setLinger(fd, onoff, lingerSec) {
    const sc = getSyscall("setsockopt");
    if (sc < 0 || fd < 0) return -1;
    const c = _socketOptionConstants();
    const ptr = __alloc(8);
    _writeU32(ptr, onoff | 0);
    _writeU32(ptr + 4, lingerSec | 0);
    return __syscall(sc, fd, c.SOL_SOCKET, c.SO_LINGER, ptr, 8);
}

function _setReuseAddr(fd) {
    const c = _socketOptionConstants();
    _setSocketOption(fd, c.SOL_SOCKET, c.SO_REUSEADDR, 1);
}

function _getSocketError(fd) {
    const sc = getSyscall("getsockopt");
    if (sc < 0) return -1;
    const c = _socketOptionConstants();
    const value = __alloc(4);
    const lenp = __alloc(4);
    _writeU32(value, 0);
    _writeU32(lenp, 4);
    const rc = __syscall(sc, fd, c.SOL_SOCKET, c.SO_ERROR, value, lenp);
    if (rc < 0) return rc;
    const err = _readU32(value);
    return err === 0 ? 0 : -err;
}

function _setNonBlocking(fd) {
    const sc = getSyscall("fcntl");
    if (sc < 0) return false;
    const flags = __syscall(sc, fd, F_GETFL, 0);
    if (flags < 0) return false;
    const O_NONBLOCK = _platform() === "macos" ? 4 : 2048;
    return __syscall(sc, fd, F_SETFL, flags | O_NONBLOCK) >= 0;
}

function _dataBytes(data, encoding) {
    const b = [];
    if (typeof data === "string") {
        const enc = encoding ? ("" + encoding).toLowerCase() : "utf8";
        if (enc === "hex" || enc === "base64" || enc === "base64url") {
            const buf = new _Buf(data, enc);
            for (let i = 0; i < buf.length; i++) b.push(buf.data[i] & 0xff);
            return b;
        }
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
    }
    return b;
}

function _registerTimeoutSocket(socket) {
    if (_timeoutSockets.indexOf(socket) === -1) _timeoutSockets.push(socket);
}

function _removeTimeoutSocket(socket) {
    const index = _timeoutSockets.indexOf(socket);
    if (index !== -1) _timeoutSockets.splice(index, 1);
}

function _isUnixPath(value) {
    return typeof value === "string" && value.length > 0 &&
        (value.charAt(0) === "/" || value.charAt(0) === "\0" || value.indexOf("/") !== -1);
}

function _familyName(family) {
    if (family === 6 || family === "ipv6" || family === "IPv6") return "ipv6";
    return "ipv4";
}

class SocketAddress {
    constructor(options) {
        options = options || {};
        this.address = options.address || ( _familyName(options.family) === "ipv6" ? "::" : "127.0.0.1");
        this.port = options.port | 0;
        this.family = _familyName(options.family);
        this.flowlabel = options.flowlabel | 0;
    }

}

SocketAddress.isSocketAddress = function (value) {
    return value instanceof SocketAddress;
};

SocketAddress.parse = function (input) {
    if (typeof input !== "string" || input.length === 0) return undefined;
    if (input.charAt(0) === "[") {
        const close = input.indexOf("]");
        if (close < 2) return undefined;
        const addr = input.substring(1, close);
        if (!isIPv6(addr)) return undefined;
        let port = 0;
        if (close + 1 < input.length) {
            if (input.charAt(close + 1) !== ":") return undefined;
            port = Number(input.substring(close + 2));
        }
        if (!(port >= 0 && port <= 65535)) return undefined;
        return new SocketAddress({ address: addr, port: port, family: "ipv6" });
    }
    const colon = input.lastIndexOf(":");
    if (colon <= 0 || colon === input.length - 1) return undefined;
    const addr = input.substring(0, colon);
    const port = Number(input.substring(colon + 1));
    if (!isIPv4(addr) || !(port >= 0 && port <= 65535)) return undefined;
    return new SocketAddress({ address: addr, port: port, family: "ipv4" });
};

class BlockList {
    constructor() {
        this.rules = [];
    }

    addAddress(address, type) {
        if (address instanceof SocketAddress) {
            this.rules.push({ kind: "address", family: address.family, value: address.address });
            return this;
        }
        this.rules.push({ kind: "address", family: _familyName(type), value: "" + address });
        return this;
    }

    addRange(start, end, type) {
        if (start instanceof SocketAddress) {
            this.rules.push({ kind: "range", family: start.family, start: start.address, end: end instanceof SocketAddress ? end.address : ("" + end) });
            return this;
        }
        this.rules.push({ kind: "range", family: _familyName(type), start: "" + start, end: "" + end });
        return this;
    }

    addSubnet(net, prefix, type) {
        if (net instanceof SocketAddress) {
            this.rules.push({ kind: "subnet", family: net.family, net: net.address, prefix: prefix | 0 });
            return this;
        }
        this.rules.push({ kind: "subnet", family: _familyName(type), net: "" + net, prefix: prefix | 0 });
        return this;
    }

    check(address, type) {
        let family = _familyName(type);
        let text = "" + address;
        if (address instanceof SocketAddress) {
            family = address.family;
            text = address.address;
        }
        for (let i = 0; i < this.rules.length; i++) {
            const rule = this.rules[i];
            if (rule.family !== family) continue;
            if (family === "ipv4") {
                const ip = _parseIPv4(text);
                if (!ip) continue;
                const n = _ipv4ToInt(ip);
                if (rule.kind === "address") {
                    const other = _parseIPv4(rule.value);
                    if (other && _ipv4ToInt(other) === n) return true;
                } else if (rule.kind === "range") {
                    const a = _parseIPv4(rule.start);
                    const b = _parseIPv4(rule.end);
                    if (a && b) {
                        const lo = _ipv4ToInt(a);
                        const hi = _ipv4ToInt(b);
                        if (n >= lo && n <= hi) return true;
                    }
                } else if (rule.kind === "subnet") {
                    const netIp = _parseIPv4(rule.net);
                    let prefix = rule.prefix | 0;
                    if (prefix < 0) prefix = 0;
                    if (prefix > 32) prefix = 32;
                    if (netIp) {
                        const mask = prefix === 0 ? 0 : ((0xffffffff << (32 - prefix)) >>> 0);
                        if ((_ipv4ToInt(netIp) & mask) === (n & mask)) return true;
                    }
                }
            } else {
                if (rule.kind === "address" && rule.value === text) return true;
                if (rule.kind === "range" && text >= rule.start && text <= rule.end) return true;
                if (rule.kind === "subnet" && text === rule.net) return true;
            }
        }
        return false;
    }
}

class Socket extends EventEmitter {
    constructor(options) {
        super();
        options = options || {};
        this.fd = -1;
        this.writable = false;
        this.readable = false;
        this.destroyed = false;
        this.connecting = false;
        this.bytesRead = 0;
        this.bytesWritten = 0;
        this.allowHalfOpen = !!options.allowHalfOpen;
        this._encoding = options.encoding || null;
        this._remotePort = 0;
        this._remoteAddress = "";
        this._localPort = 0;
        this._localAddress = "";
        this._reading = false;
        this._paused = false;
        this._refed = true;
        this._endEmitted = false;
        this._closeEmitted = false;
        this._finishEmitted = false;
        this._writeShutdown = false;
        this._ending = false;
        this._destroySoon = false;
        this._endCallback = null;
        this._writeQueue = [];
        this._writableLength = 0;
        this._needDrain = false;
        this._timeoutMs = 0;
        this._timeoutAt = 0;
        this._noDelay = null;
        this._keepAlive = null;
        this._keepAliveDelay = 0;
        this._corked = 0;
        this._highWaterMark = options.highWaterMark > 0 ? options.highWaterMark | 0 : WRITE_HIGH_WATER_MARK;
        this._isUnix = false;
        if (typeof options.fd === "number" && options.fd >= 0) {
            this._attach(options.fd, "", 0);
            if (options.readable === false) this.readable = false;
            if (options.writable === false) this.writable = false;
        }
    }

    on(event, listener) {
        const result = super.on(event, listener);
        if ((event === "data" || event === "end") && this.fd >= 0 && !this.destroyed && !this._paused) {
            this._startRead();
        }
        return result;
    }

    addListener(event, listener) { return this.on(event, listener); }

    _syncWatch() {
        if (this.fd < 0 || this.destroyed) return;
        let events = 0;
        if (this._reading) events |= POLLIN;
        if (this.connecting || (this._writeQueue.length > 0 && this._corked === 0)) events |= POLLOUT;
        if (events === 0 && this._timeoutMs <= 0) {
            _watchRemove(this.fd);
            return;
        }
        const self = this;
        _watchAdd(this.fd, events, function (revents) { self._onReady(revents); }, this._refed);
    }

    _startRead() {
        if (this.fd < 0 || this.destroyed || this._reading) return;
        this._reading = true;
        this._syncWatch();
    }

    _stopRead() {
        this._reading = false;
        if (this.fd >= 0 && !this.destroyed) this._syncWatch();
    }

    _touch() {
        if (this._timeoutMs > 0) {
            this._timeoutAt = Date.now() + this._timeoutMs;
            _registerTimeoutSocket(this);
            this._syncWatch();
        }
    }

    _refreshAddresses() {
        const local = _socketName(this.fd, "getsockname");
        if (local) {
            this._localPort = local.port;
            this._localAddress = local.address;
            if (local.family === "unix") this._isUnix = true;
        }
        const remote = _socketName(this.fd, "getpeername");
        if (remote) {
            this._remotePort = remote.port;
            this._remoteAddress = remote.address;
            if (remote.family === "unix") this._isUnix = true;
        }
    }

    _applySocketOptions() {
        if (this._noDelay !== null) this.setNoDelay(this._noDelay);
        if (this._keepAlive !== null) this.setKeepAlive(this._keepAlive, this._keepAliveDelay);
    }

    _attach(fd, addr, port) {
        this.fd = fd;
        _setNonBlocking(fd);
        this.writable = true;
        this.readable = true;
        this.destroyed = false;
        this.connecting = false;
        this._remoteAddress = addr || "";
        this._remotePort = port || 0;
        this._refreshAddresses();
        this._applySocketOptions();
        this._syncWatch();
        this._touch();
        return this;
    }

    connect(port, host, connectListener) {
        let lookup = null;
        let localAddress;
        let localPort;
        let timeoutMs = 0;
        let noDelay;
        let keepAlive;
        let keepAliveInitialDelay;
        let path = null;

        if (port instanceof SocketAddress) {
            const sa = port;
            connectListener = host;
            host = sa.address;
            port = sa.port;
            if (sa.family === "ipv6") {
                const mapped = _ipv4FromMapped(_parseIPv6(sa.address));
                if (!mapped) {
                    const err = new Error("connect ENOTSUP " + sa.address);
                    err.code = "ENOTSUP";
                    queueMicrotask(() => this.destroy(err));
                    return this;
                }
                host = _ipv4Text(mapped);
            }
        } else if (port !== null && typeof port === "object") {
            const opts = port;
            connectListener = host;
            host = opts.host;
            port = opts.port;
            path = opts.path;
            lookup = opts.lookup;
            localAddress = opts.localAddress;
            localPort = opts.localPort;
            if (opts.allowHalfOpen !== undefined) this.allowHalfOpen = !!opts.allowHalfOpen;
            if (opts.timeout > 0) timeoutMs = opts.timeout;
            if (opts.noDelay !== undefined) noDelay = !!opts.noDelay;
            if (opts.keepAlive !== undefined) keepAlive = !!opts.keepAlive;
            if (opts.keepAliveInitialDelay > 0) keepAliveInitialDelay = opts.keepAliveInitialDelay;
            if (opts.highWaterMark > 0) this._highWaterMark = opts.highWaterMark | 0;
        }
        if (typeof host === "function") { connectListener = host; host = undefined; }
        if (typeof connectListener === "function") this.once("connect", connectListener);
        if (timeoutMs > 0) this.setTimeout(timeoutMs);
        if (noDelay !== undefined) this.setNoDelay(noDelay);
        if (keepAlive !== undefined) this.setKeepAlive(keepAlive, keepAliveInitialDelay || 0);

        if (!path && _isUnixPath(port)) path = port;
        if (path) {
            this._startUnixConnect(path);
            return this;
        }

        port = Number(port);
        if (!(port >= 0 && port <= 65535)) {
            queueMicrotask(() => this.destroy(_sockErr("connect", -22, this)));
            return this;
        }

        this.connecting = true;
        const origHost = host === undefined || host === null || host === "" ? "localhost" : host;
        const self = this;

        if (typeof lookup === "function") {
            lookup(origHost, { family: 4 }, function (err, address, family) {
                queueMicrotask(() => {
                    if (self.destroyed) return;
                    self.emit("lookup", err, address, family || 4, origHost);
                    if (err) {
                        self.destroy(err);
                        return;
                    }
                    self._startTcpConnect(port, address, localAddress, localPort);
                });
            });
            return this;
        }

        const ip = _hostToIPv4(origHost);
        if (ip === null) {
            const v6 = _parseIPv6(origHost);
            const err = new Error((v6 ? "connect ENOTSUP " : "getaddrinfo ENOTFOUND ") + origHost);
            err.code = v6 ? "ENOTSUP" : "ENOTFOUND";
            err.errno = -1;
            err.syscall = v6 ? "connect" : "getaddrinfo";
            err.hostname = origHost;
            queueMicrotask(() => {
                self.emit("lookup", err, origHost, v6 ? 6 : 0, origHost);
                self.destroy(err);
            });
            return this;
        }
        const resolved = _ipv4Text(ip);
        queueMicrotask(() => {
            if (!self.destroyed) self.emit("lookup", null, resolved, 4, origHost);
        });
        this._startTcpConnect(port, resolved, localAddress, localPort);
        return this;
    }

    _prepareFd(family) {
        const fd = __syscall(getSyscall("socket"), family, SOCK_STREAM, 0);
        if (fd < 0) {
            queueMicrotask(() => this.destroy(_sockErr("socket", fd, this)));
            return -1;
        }
        this.fd = fd;
        this.connecting = true;
        this.destroyed = false;
        if (!_setNonBlocking(fd)) {
            queueMicrotask(() => this.destroy(_sockErr("fcntl", -22, this)));
            return -1;
        }
        this._applySocketOptions();
        this._syncWatch();
        return fd;
    }

    _startTcpConnect(port, address, localAddress, localPort) {
        if (this.destroyed) return;
        const fd = this._prepareFd(AF_INET);
        if (fd < 0) return;
        this._isUnix = false;
        this._remotePort = port;
        this._remoteAddress = address;
        if (localAddress || (localPort !== undefined && localPort !== null && localPort !== 0)) {
            const lsa = _makeSockaddr(localPort || 0, localAddress || "0.0.0.0");
            const br = __syscall(getSyscall("bind"), fd, lsa, 16);
            if (br < 0) {
                queueMicrotask(() => this.destroy(_sockErr("bind", br, this)));
                return;
            }
        }
        const sa = _makeSockaddr(port, address);
        const rc = __syscall(getSyscall("connect"), fd, sa, 16);
        if (rc === 0) {
            queueMicrotask(() => this._finishConnect());
        } else if (!_isInProgress(rc)) {
            queueMicrotask(() => this.destroy(_sockErr("connect", rc, this)));
        }
    }

    _startUnixConnect(path) {
        if (this.destroyed) return;
        const fd = this._prepareFd(AF_UNIX);
        if (fd < 0) return;
        this._isUnix = true;
        this._remotePort = 0;
        this._remoteAddress = path;
        const packed = _makeUnixSockaddr(path);
        const rc = __syscall(getSyscall("connect"), fd, packed.sa, packed.len);
        if (rc === 0) {
            queueMicrotask(() => this._finishConnect());
        } else if (!_isInProgress(rc)) {
            queueMicrotask(() => this.destroy(_sockErr("connect", rc, this)));
        }
    }

    _completeConnect() {
        if (!this.connecting || this.fd < 0) return;
        const err = _getSocketError(this.fd);
        if (err === 0) this._finishConnect();
        else this.destroy(_sockErr("connect", err, this));
    }

    _finishConnect() {
        if (!this.connecting || this.fd < 0 || this.destroyed) return;
        this.connecting = false;
        this.writable = true;
        this.readable = true;
        this._refreshAddresses();
        this._touch();
        this.emit("connect");
        this.emit("ready");
        this._flushWrites();
        this._syncWatch();
    }

    _onReady(revents) {
        if (this.fd < 0 || this.destroyed) return;
        if ((revents & POLLNVAL) !== 0) {
            this.destroy(_sockErr("poll", -9, this));
            return;
        }
        if (this.connecting && (revents & (POLLOUT | POLLERR | POLLHUP)) !== 0) {
            this._completeConnect();
            if (this.destroyed || this.connecting) return;
        }
        if ((revents & POLLOUT) !== 0 && this._writeQueue.length > 0 && this._corked === 0) this._flushWrites();
        if ((revents & (POLLIN | POLLHUP)) !== 0 && (this._reading || (revents & POLLHUP) !== 0)) {
            this._onReadable();
        }
        if ((revents & POLLERR) !== 0 && !this.destroyed && !this.connecting) {
            const err = _getSocketError(this.fd);
            if (err < 0) this.destroy(_sockErr("read", err, this));
        }
    }

    _onReadable() {
        if (this.fd < 0 || this.destroyed) return;
        for (let pass = 0; pass < 16; pass++) {
            const cap = 65536;
            const buf = __alloc(cap + 1);
            const rn = __syscall(getSyscall("read"), this.fd, buf, cap);
            if (rn > 0) {
                this.bytesRead += rn;
                const out = new _Buf(0);
                for (let i = 0; i < rn; i++) out.data.push(__getChar(buf + i));
                out.length = out.data.length;
                this._touch();
                this.emit("data", this._encoding ? out.toString(this._encoding) : out);
                if (this.destroyed || !this._reading) return;
                continue;
            }
            if (rn === 0) {
                this._finishReadable();
                return;
            }
            if (_isInterrupted(rn)) continue;
            if (_isWouldBlock(rn)) return;
            this.destroy(_sockErr("read", rn, this));
            return;
        }
    }

    _finishReadable() {
        if (!this.readable) return;
        this.readable = false;
        this._reading = false;
        if (!this._endEmitted) {
            this._endEmitted = true;
            this.emit("end");
        }
        if (!this.allowHalfOpen && this.writable && !this._ending) this.end();
        if (!this.writable) this.destroy();
        else this._syncWatch();
    }

    _flushWrites() {
        if (this._corked > 0) {
            this._syncWatch();
            return;
        }
        if (this.fd < 0 || this.destroyed || this.connecting) {
            this._syncWatch();
            return;
        }
        while (this._writeQueue.length > 0) {
            const item = this._writeQueue[0];
            const remaining = item.bytes.length - item.offset;
            const buf = __alloc(remaining + 1);
            for (let i = 0; i < remaining; i++) __setChar(buf + i, item.bytes[item.offset + i] & 0xff);
            const wr = __syscall(getSyscall("write"), this.fd, buf, remaining);
            if (wr > 0) {
                item.offset += wr;
                this.bytesWritten += wr;
                this._writableLength -= wr;
                this._touch();
                if (item.offset >= item.bytes.length) {
                    this._writeQueue.shift();
                    if (typeof item.callback === "function") queueMicrotask(item.callback);
                    continue;
                }
                break;
            }
            if (_isInterrupted(wr)) continue;
            if (_isWouldBlock(wr) || wr === 0) break;
            const err = _sockErr("write", wr, this);
            if (typeof item.callback === "function") queueMicrotask(() => item.callback(err));
            this.destroy(err);
            return;
        }
        if (this._writeQueue.length === 0) {
            if (this._needDrain) {
                this._needDrain = false;
                this.emit("drain");
            }
            if (this._ending) this._finishWritable();
        }
        this._syncWatch();
    }

    write(data, encoding, cb) {
        if (typeof encoding === "function") { cb = encoding; encoding = undefined; }
        if (this.destroyed || this._ending || (this.fd < 0 && !this.connecting)) {
            const err = _sockErr("write", -32, this);
            if (typeof cb === "function") queueMicrotask(() => cb(err));
            if (this.listenerCount("error") > 0) queueMicrotask(() => this.emit("error", err));
            return false;
        }
        const bytes = _dataBytes(data, encoding);
        this._writeQueue.push({ bytes: bytes, offset: 0, callback: cb });
        this._writableLength += bytes.length;
        if (this._corked === 0) this._flushWrites();
        else this._syncWatch();
        const below = this._writableLength < this._highWaterMark;
        if (!below) this._needDrain = true;
        return below;
    }

    cork() {
        this._corked++;
        return this;
    }

    uncork() {
        if (this._corked > 0) this._corked--;
        if (this._corked === 0) this._flushWrites();
        return this;
    }

    read(size) {
        if (this.fd < 0 || this.destroyed) return null;
        const cap = size && size > 0 ? size : 65536;
        while (true) {
            const buf = __alloc(cap + 1);
            const rn = __syscall(getSyscall("read"), this.fd, buf, cap);
            if (rn > 0) {
                this.bytesRead += rn;
                const out = new _Buf(0);
                for (let i = 0; i < rn; i++) out.data.push(__getChar(buf + i));
                out.length = out.data.length;
                this._touch();
                return this._encoding ? out.toString(this._encoding) : out;
            }
            if (rn === 0) return null;
            if (_isInterrupted(rn)) continue;
            if (_isWouldBlock(rn)) {
                _pollOne(this.fd, POLLIN);
                continue;
            }
            return null;
        }
    }

    end(data, encoding, cb) {
        if (typeof data === "function") { cb = data; data = undefined; }
        else if (typeof encoding === "function") { cb = encoding; encoding = undefined; }
        if (data !== undefined && data !== null) this.write(data, encoding);
        this._ending = true;
        this._corked = 0;
        if (typeof cb === "function") this._endCallback = cb;
        if (this._writeQueue.length === 0 && !this.connecting) this._finishWritable();
        else this._syncWatch();
        return this;
    }

    destroySoon() {
        this._destroySoon = true;
        if (!this._ending) this.end();
        else if (this._writeQueue.length === 0 && !this.connecting) this.destroy();
        return this;
    }

    resetAndDestroy() {
        if (this.fd >= 0) _setLinger(this.fd, 1, 0);
        return this.destroy();
    }

    _finishWritable() {
        if (this._writeShutdown || this.fd < 0 || this.destroyed) return;
        this._writeShutdown = true;
        this.writable = false;
        const sc = getSyscall("shutdown");
        if (sc >= 0) __syscall(sc, this.fd, 1);
        if (!this._finishEmitted) {
            this._finishEmitted = true;
            this.emit("finish");
        }
        if (typeof this._endCallback === "function") {
            const cb = this._endCallback;
            this._endCallback = null;
            queueMicrotask(cb);
        }
        if (this._destroySoon || !this.readable) this.destroy();
        else this._syncWatch();
    }

    destroy(err) {
        if (this.destroyed && this.fd < 0) return this;
        const oldfd = this.fd;
        if (oldfd >= 0) _watchRemove(oldfd);
        if (oldfd >= 0) __syscall(getSyscall("close"), oldfd);
        this.fd = -1;
        this.destroyed = true;
        this.connecting = false;
        this.writable = false;
        this.readable = false;
        this._reading = false;
        this._timeoutAt = 0;
        _removeTimeoutSocket(this);
        while (this._writeQueue.length > 0) {
            const item = this._writeQueue.shift();
            if (typeof item.callback === "function") queueMicrotask(() => item.callback(err));
        }
        this._writableLength = 0;
        if (err) this.emit("error", err);
        if (!this._closeEmitted) {
            this._closeEmitted = true;
            this.emit("close", !!err);
        }
        return this;
    }

    setEncoding(encoding) { this._encoding = encoding; return this; }

    setNoDelay(noDelay) {
        this._noDelay = noDelay === undefined ? true : !!noDelay;
        if (this.fd >= 0 && !this._isUnix) {
            const rc = _setSocketOption(this.fd, IPPROTO_TCP, 1, this._noDelay ? 1 : 0);
            if (rc < 0) this.emit("error", _sockErr("setsockopt", rc, this));
        }
        return this;
    }

    setKeepAlive(enable, initialDelay) {
        this._keepAlive = enable === undefined ? false : !!enable;
        this._keepAliveDelay = initialDelay > 0 ? initialDelay : 0;
        if (this.fd >= 0 && !this._isUnix) {
            const c = _socketOptionConstants();
            const rc = _setSocketOption(this.fd, c.SOL_SOCKET, c.SO_KEEPALIVE, this._keepAlive ? 1 : 0);
            if (rc < 0) this.emit("error", _sockErr("setsockopt", rc, this));
            if (this._keepAlive && this._keepAliveDelay > 0) {
                const seconds = Math.max(1, Math.floor(this._keepAliveDelay / 1000));
                _setSocketOption(this.fd, IPPROTO_TCP, c.TCP_KEEPIDLE, seconds);
            }
        }
        return this;
    }

    setTimeout(timeout, cb) {
        const value = Number(timeout);
        this._timeoutMs = value > 0 ? value : 0;
        this._timeoutAt = this._timeoutMs > 0 ? Date.now() + this._timeoutMs : 0;
        if (typeof cb === "function") this.once("timeout", cb);
        if (this._timeoutMs > 0) _registerTimeoutSocket(this);
        else _removeTimeoutSocket(this);
        if (this.fd >= 0 && !this.destroyed) this._syncWatch();
        return this;
    }

    pause() { this._paused = true; this._stopRead(); return this; }
    resume() {
        this._paused = false;
        if (this.fd >= 0 && !this.destroyed) this._startRead();
        return this;
    }

    ref() {
        if (!this._refed) {
            this._refed = true;
            this._syncWatch();
        }
        return this;
    }

    unref() {
        if (this._refed) {
            this._refed = false;
            this._syncWatch();
        }
        return this;
    }

    hasRef() { return this._refed; }

    address() {
        if (this._isUnix) {
            return { port: 0, family: "unix", address: this._localAddress || this._remoteAddress };
        }
        return { port: this._localPort, family: "IPv4", address: this._localAddress || "0.0.0.0" };
    }

    get bufferSize() { return this._writableLength; }
    get writableLength() { return this._writableLength; }
    get writableHighWaterMark() { return this._highWaterMark; }
    get writableNeedDrain() { return this._needDrain; }
    get writableEnded() { return this._ending || this._writeShutdown; }
    get writableFinished() { return this._finishEmitted; }
    get writableCorked() { return this._corked; }
    get readableEnded() { return this._endEmitted; }
    get pending() { return this.connecting; }
    get timeout() { return this._timeoutMs > 0 ? this._timeoutMs : undefined; }
    get readyState() {
        if (this.connecting) return "opening";
        if (this.destroyed || this.fd < 0) return "closed";
        if (this.readable && this.writable) return "open";
        if (this.readable) return "readOnly";
        if (this.writable) return "writeOnly";
        return "closed";
    }
    get localAddress() { return this._localAddress; }
    get localPort() { return this._localPort; }
    get localFamily() { return this._isUnix ? "unix" : "IPv4"; }
    get remoteAddress() { return this._remoteAddress; }
    get remotePort() { return this._remotePort; }
    get remoteFamily() { return this._isUnix ? "unix" : "IPv4"; }
}

class Server extends EventEmitter {
    constructor(options, onConnect) {
        super();
        if (typeof options === "function") { onConnect = options; options = {}; }
        options = options || {};
        if (typeof onConnect === "function") this.on("connection", onConnect);
        this.fd = -1;
        this.listening = false;
        this.maxConnections = 0;
        this.allowHalfOpen = !!options.allowHalfOpen;
        this.pauseOnConnect = !!options.pauseOnConnect;
        this.keepAlive = !!options.keepAlive;
        this.keepAliveInitialDelay = options.keepAliveInitialDelay > 0 ? options.keepAliveInitialDelay : 0;
        this.noDelay = !!options.noDelay;
        this._port = 0;
        this._host = "0.0.0.0";
        this._path = "";
        this._isUnix = false;
        this._accepting = false;
        this._refed = true;
        this._connections = [];
        this._closeEmitted = false;
    }

    listen(port, host, backlog, cb) {
        if (typeof port === "function") {
            cb = port;
            port = 0;
            host = undefined;
            backlog = undefined;
        } else if (port !== null && typeof port === "object") {
            const opts = port;
            cb = host;
            host = opts.host;
            backlog = opts.backlog;
            port = opts.port;
            if (opts.maxConnections !== undefined) this.maxConnections = opts.maxConnections | 0;
            if (opts.path) {
                if (typeof cb === "function") this.once("listening", cb);
                this._listenUnix(opts.path, backlog);
                return this;
            }
        }
        if (typeof host === "function") { cb = host; host = undefined; backlog = undefined; }
        else if (typeof backlog === "function") { cb = backlog; backlog = undefined; }
        if (typeof cb === "function") this.once("listening", cb);

        if (_isUnixPath(port)) {
            this._listenUnix(port, backlog);
            return this;
        }

        port = port === undefined ? 0 : Number(port);
        if (!(port >= 0 && port <= 65535) || !_listenHostOk(host === undefined ? "0.0.0.0" : host)) {
            queueMicrotask(() => this.emit("error", _sockErr("listen", -22)));
            return this;
        }
        this._listenTcp(port, host, backlog);
        return this;
    }

    _listenTcp(port, host, backlog) {
        const fd = __syscall(getSyscall("socket"), AF_INET, SOCK_STREAM, 0);
        if (fd < 0) {
            queueMicrotask(() => this.emit("error", _sockErr("socket", fd)));
            return;
        }
        this.fd = fd;
        this._isUnix = false;
        _setNonBlocking(fd);
        _setReuseAddr(fd);
        const sa = _makeSockaddr(port, host === undefined ? "0.0.0.0" : host);
        const br = __syscall(getSyscall("bind"), fd, sa, 16);
        if (br < 0) {
            __syscall(getSyscall("close"), fd);
            this.fd = -1;
            queueMicrotask(() => this.emit("error", _sockErr("bind", br)));
            return;
        }
        const lr = __syscall(getSyscall("listen"), fd, backlog && backlog > 0 ? backlog : 511);
        if (lr < 0) {
            __syscall(getSyscall("close"), fd);
            this.fd = -1;
            queueMicrotask(() => this.emit("error", _sockErr("listen", lr)));
            return;
        }
        this.listening = true;
        this._closeEmitted = false;
        const local = _socketName(fd, "getsockname");
        this._port = local ? local.port : port;
        this._host = local ? local.address : (host === undefined ? "0.0.0.0" : host);
        this._startAccept();
        this.emit("listening");
    }

    _listenUnix(path, backlog) {
        try { unlinkSync(path); } catch (e) {}
        const fd = __syscall(getSyscall("socket"), AF_UNIX, SOCK_STREAM, 0);
        if (fd < 0) {
            queueMicrotask(() => this.emit("error", _sockErr("socket", fd)));
            return;
        }
        this.fd = fd;
        this._isUnix = true;
        this._path = path;
        _setNonBlocking(fd);
        const packed = _makeUnixSockaddr(path);
        const br = __syscall(getSyscall("bind"), fd, packed.sa, packed.len);
        if (br < 0) {
            __syscall(getSyscall("close"), fd);
            this.fd = -1;
            queueMicrotask(() => this.emit("error", _sockErr("bind", br)));
            return;
        }
        const lr = __syscall(getSyscall("listen"), fd, backlog && backlog > 0 ? backlog : 511);
        if (lr < 0) {
            __syscall(getSyscall("close"), fd);
            this.fd = -1;
            queueMicrotask(() => this.emit("error", _sockErr("listen", lr)));
            return;
        }
        this.listening = true;
        this._closeEmitted = false;
        this._port = 0;
        this._host = path;
        this._startAccept();
        this.emit("listening");
    }

    _startAccept() {
        if (this.fd < 0 || !this.listening) return;
        this._accepting = true;
        const self = this;
        _watchAdd(this.fd, POLLIN, function (revents) { self._onAcceptable(revents); }, this._refed);
    }

    _acceptOne() {
        if (this.fd < 0) return { socket: null, rc: -9 };
        const sa = __alloc(UNIX_SOCKADDR_LEN);
        for (let i = 0; i < UNIX_SOCKADDR_LEN; i++) __setChar(sa + i, 0);
        const lenp = __alloc(4);
        _writeU32(lenp, UNIX_SOCKADDR_LEN);
        const cfd = __syscall(getSyscall("accept"), this.fd, sa, lenp);
        if (cfd < 0) return { socket: null, rc: cfd };
        const peer = _decodeSockaddr(sa);
        const socket = new Socket({ allowHalfOpen: this.allowHalfOpen });
        socket._isUnix = this._isUnix || peer.family === "unix";
        socket._attach(cfd, peer.address, peer.port);
        if (this.noDelay) socket.setNoDelay(true);
        if (this.keepAlive) socket.setKeepAlive(true, this.keepAliveInitialDelay);
        if (this.pauseOnConnect) socket.pause();
        return { socket: socket, rc: 0 };
    }

    _trackConnection(socket) {
        this._connections.push(socket);
        const self = this;
        socket.once("close", function () {
            const index = self._connections.indexOf(socket);
            if (index !== -1) self._connections.splice(index, 1);
            self._maybeEmitClose();
        });
    }

    _onAcceptable(revents) {
        if (this.fd < 0 || !this.listening) return;
        if ((revents & (POLLERR | POLLNVAL)) !== 0) {
            this.emit("error", _sockErr("accept", -9));
            return;
        }
        for (let pass = 0; pass < 64; pass++) {
            const accepted = this._acceptOne();
            if (accepted.socket) {
                if (this.maxConnections > 0 && this._connections.length >= this.maxConnections) {
                    this.emit("drop", {
                        localAddress: this._host,
                        localPort: this._port,
                        remoteAddress: accepted.socket.remoteAddress,
                        remotePort: accepted.socket.remotePort,
                        remoteFamily: accepted.socket.remoteFamily
                    });
                    accepted.socket.destroy();
                    continue;
                }
                this._trackConnection(accepted.socket);
                this.emit("connection", accepted.socket);
                continue;
            }
            if (_isInterrupted(accepted.rc)) continue;
            if (_isWouldBlock(accepted.rc)) return;
            this.emit("error", _sockErr("accept", accepted.rc));
            return;
        }
    }

    accept() {
        if (this.fd < 0) return null;
        while (true) {
            const accepted = this._acceptOne();
            if (accepted.socket) {
                this._trackConnection(accepted.socket);
                this.emit("connection", accepted.socket);
                _dispatchReady(0);
                return accepted.socket;
            }
            if (_isInterrupted(accepted.rc)) continue;
            if (_isWouldBlock(accepted.rc)) {
                _pollOne(this.fd, POLLIN);
                continue;
            }
            return null;
        }
    }

    close(cb) {
        if (typeof cb === "function") this.once("close", cb);
        this._accepting = false;
        if (this.fd >= 0) {
            _watchRemove(this.fd);
            __syscall(getSyscall("close"), this.fd);
            this.fd = -1;
        }
        this.listening = false;
        if (this._isUnix && this._path) {
            try { unlinkSync(this._path); } catch (e) {}
        }
        this._maybeEmitClose();
        return this;
    }

    _maybeEmitClose() {
        if (!this.listening && this.fd < 0 && this._connections.length === 0 && !this._closeEmitted) {
            this._closeEmitted = true;
            this.emit("close");
        }
    }

    address() {
        if (!this.listening || this.fd < 0) return null;
        if (this._isUnix) return this._path;
        return { port: this._port, family: "IPv4", address: this._host };
    }

    getConnections(cb) {
        if (typeof cb === "function") {
            const count = this._connections.length;
            queueMicrotask(() => cb(null, count));
        }
        return this;
    }

    ref() {
        if (!this._refed) {
            this._refed = true;
            if (this.listening) this._startAccept();
        }
        return this;
    }

    unref() {
        if (this._refed) {
            this._refed = false;
            if (this.listening) this._startAccept();
        }
        return this;
    }

    hasRef() { return this._refed; }
}

function isIPv4(input) {
    return typeof input === "string" && input.indexOf(".") !== -1 && _parseIPv4(input) !== null;
}

function isIPv6(input) {
    return _parseIPv6(input) !== null;
}

function isIP(input) {
    if (isIPv4(input)) return 4;
    if (isIPv6(input)) return 6;
    return 0;
}

function createServer(options, onConnect) { return new Server(options, onConnect); }
function connect(port, host, connectListener) {
    const options = (port !== null && typeof port === "object") ? port : {};
    const socket = new Socket(options);
    return socket.connect(port, host, connectListener);
}
function createConnection(port, host, connectListener) { return connect(port, host, connectListener); }

function getDefaultAutoSelectFamily() { return _autoSelectFamily; }
function setDefaultAutoSelectFamily(value) {
    _autoSelectFamily = !!value;
    return _autoSelectFamily;
}
function getDefaultAutoSelectFamilyAttemptTimeout() { return _autoSelectFamilyAttemptTimeout; }
function setDefaultAutoSelectFamilyAttemptTimeout(value) {
    const n = Number(value);
    if (n >= 10) _autoSelectFamilyAttemptTimeout = n | 0;
    return _autoSelectFamilyAttemptTimeout;
}

export { _watchAdd as _netWatchAdd, _watchRemove as _netWatchRemove,
         _makeSockaddr as _netMakeSockaddr, _parseIPv4 as _netParseIPv4,
         _boundPort as _netBoundPort, _setReuseAddr as _netSetReuseAddr,
         POLLIN as _NET_POLLIN, POLLOUT as _NET_POLLOUT, AF_INET as _NET_AF_INET };

export { Socket, Server, SocketAddress, BlockList, isIP, isIPv4, isIPv6,
         createServer, connect, createConnection,
         getDefaultAutoSelectFamily, setDefaultAutoSelectFamily,
         getDefaultAutoSelectFamilyAttemptTimeout, setDefaultAutoSelectFamilyAttemptTimeout };
export default { Socket, Server, SocketAddress, BlockList, isIP, isIPv4, isIPv6,
         createServer, connect, createConnection,
         getDefaultAutoSelectFamily, setDefaultAutoSelectFamily,
         getDefaultAutoSelectFamilyAttemptTimeout, setDefaultAutoSelectFamilyAttemptTimeout };
