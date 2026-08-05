// asm.js Runtime - Node.js dgram (minimal but real UDP/IPv4 over sendto/recvfrom)
//
// Rides net.js's single poll(2) readiness pump and IPv4 sockaddr helpers, so a
// bound UDP socket fires 'message' events on its own inside the same event loop
// that drives TCP. Scope: udp4 createSocket/bind/send/'message'/address/close.
//
//   const s = dgram.createSocket("udp4");
//   s.on("message", (msg, rinfo) => ...);   // msg: Buffer, rinfo: {address,family,port,size}
//   s.bind(port[, address][, cb]);          // port 0 => ephemeral (see address())
//   s.send(msg[, offset, length], port[, address][, cb]);
//   s.address();                            // { address, family:"IPv4", port }
//   s.close([cb]);
//
// Not covered (documented): udp6/IPv6, multicast (addMembership/setMulticastTTL),
// setBroadcast wire effect, connected UDP (connect/remoteAddress).

import { EventEmitter } from "./events.js";
import { Buffer as _Buf } from "./buffer.js";
import { getSyscall } from "./constants.js";
import { _netWatchAdd, _netWatchRemove, _netMakeSockaddr, _netBoundPort, _netSetReuseAddr, _NET_POLLIN, _NET_AF_INET } from "./net.js";

const SOCK_DGRAM = 2;

// Build a `struct msghdr` (+ one `iovec`) in native memory pointing at the
// sockaddr `saPtr` and payload buffer `iovBase`/`iovLen`, for sendmsg/recvmsg.
// recvmsg/sendmsg take 3 args (fd, &msghdr, flags), which fits asm.js's __syscall
// 5-arg cap — unlike sendto/recvfrom (6 args). The zeroed 56-byte layout with
// name@0, namelen@8, iov@16, iovlen@24, control@32, controllen@40, flags@48 is
// shared by macOS (BSD, verified) and Linux LP64 (namelen/iovlen widths differ
// but the low bytes we write plus zeroing cover both). __setPtr writes the raw
// 8-byte pointer values (addresses are not float64-splittable in JS).
function _buildMsghdr(saPtr, iovBase, iovLen) {
    const iov = __alloc(16);
    __setPtr(iov + 0, iovBase);
    for (let k = 0; k < 8; k++) __setChar(iov + 8 + k, 0);
    __setChar(iov + 8, iovLen & 0xff);
    __setChar(iov + 9, (iovLen >> 8) & 0xff);
    __setChar(iov + 10, (iovLen >> 16) & 0xff);
    const mh = __alloc(56);
    for (let k = 0; k < 56; k++) __setChar(mh + k, 0);
    __setPtr(mh + 0, saPtr);   // msg_name
    __setChar(mh + 8, 16);     // msg_namelen = sizeof(sockaddr_in)
    __setPtr(mh + 16, iov);    // msg_iov
    __setChar(mh + 24, 1);     // msg_iovlen = 1
    return mh;
}

// Normalize a message payload (string | Buffer | byte-array) into a byte array.
function _bytesOf(msg) {
    const b = [];
    if (typeof msg === "string") {
        for (let i = 0; i < msg.length; i++) b.push(msg.charCodeAt(i) & 0xff);
        return b;
    }
    if (msg instanceof _Buf) {
        for (let i = 0; i < msg.length; i++) b.push(msg.data[i] & 0xff);
        return b;
    }
    if (msg && msg.data && typeof msg.length === "number") {
        for (let i = 0; i < msg.length; i++) b.push(msg.data[i] & 0xff);
        return b;
    }
    if (msg && typeof msg.length === "number") {
        for (let i = 0; i < msg.length; i++) b.push(msg[i] & 0xff);
        return b;
    }
    return b;
}

class Socket extends EventEmitter {
    constructor(type) {
        super();
        if (type && typeof type === "object") type = type.type;
        this.type = type || "udp4";
        this.fd = -1;
        this._bound = false;
        this._reading = false;
        this._port = 0;
        this._address = "0.0.0.0";
    }

    _ensureFd() {
        if (this.fd >= 0) return this.fd;
        const fd = __syscall(getSyscall("socket"), _NET_AF_INET, SOCK_DGRAM, 0);
        if (fd < 0) { this.emit("error", new Error("dgram socket() failed (rc=" + fd + ")")); return -1; }
        this.fd = fd;
        return fd;
    }

    bind(port, address, cb) {
        if (typeof port === "function") { cb = port; port = 0; address = undefined; }
        else if (port !== null && typeof port === "object") {
            const o = port; cb = address; address = o.address; port = o.port;
        }
        if (typeof address === "function") { cb = address; address = undefined; }
        const fd = this._ensureFd();
        if (fd < 0) return this;
        _netSetReuseAddr(fd);
        const sa = _netMakeSockaddr(port || 0, address || "0.0.0.0");
        const r = __syscall(getSyscall("bind"), fd, sa, 16);
        if (r < 0) { this.emit("error", new Error("dgram bind() failed (rc=" + r + ")")); return this; }
        this._bound = true;
        this._port = _netBoundPort(fd) || (port || 0);
        this._address = address || "0.0.0.0";
        this._startRead();
        if (typeof cb === "function") this.once("listening", cb);
        this.emit("listening");
        return this;
    }

    _startRead() {
        if (this.fd < 0 || this._reading) return;
        this._reading = true;
        const self = this;
        _netWatchAdd(this.fd, _NET_POLLIN, function () { self._onReadable(); });
    }

    // Poll pump says the fd is readable: recvfrom one datagram, emit 'message'
    // with the payload Buffer and the sender's { address, family, port, size }.
    _onReadable() {
        if (this.fd < 0) return;
        const cap = 65536;
        const buf = __alloc(cap + 1);
        const sa = __alloc(16);
        for (let k = 0; k < 16; k++) __setChar(sa + k, 0);
        const mh = _buildMsghdr(sa, buf, cap);
        const rn = __syscall(getSyscall("recvmsg"), this.fd, mh, 0);
        if (rn <= 0) return;
        const out = new _Buf(0);
        for (let i = 0; i < rn; i++) out.data.push(__getChar(buf + i));
        out.length = out.data.length;
        const port = ((__getChar(sa + 2) << 8) | __getChar(sa + 3)) & 0xffff;
        const address = __getChar(sa + 4) + "." + __getChar(sa + 5) + "." +
                        __getChar(sa + 6) + "." + __getChar(sa + 7);
        this.emit("message", out, { address: address, family: "IPv4", port: port, size: rn });
    }

    // send(msg[, offset, length], port[, address][, cb]). The full 6-arg form is
    // detected by a numeric `length`; otherwise it is the short
    // (msg, port, address, cb) form.
    send(msg, arg2, arg3, arg4, arg5, arg6) {
        let offset = 0, length = -1, port, address, cb;
        if (typeof arg3 === "number") {
            offset = arg2; length = arg3; port = arg4; address = arg5; cb = arg6;
        } else {
            port = arg2; address = arg3; cb = arg4;
        }
        if (typeof address === "function") { cb = address; address = undefined; }
        const bytes = _bytesOf(msg);
        const start = offset > 0 ? offset : 0;
        const len = (length < 0) ? (bytes.length - start) : length;
        const fd = this._ensureFd();
        if (fd < 0) { if (typeof cb === "function") cb(new Error("dgram send: no socket")); return this; }
        const buf = __alloc(len + 1);
        for (let i = 0; i < len; i++) __setChar(buf + i, bytes[start + i] & 0xff);
        const sa = _netMakeSockaddr(port, address || "127.0.0.1");
        const mh = _buildMsghdr(sa, buf, len);
        const r = __syscall(getSyscall("sendmsg"), fd, mh, 0);
        if (typeof cb === "function") cb(r < 0 ? new Error("dgram send() failed (rc=" + r + ")") : null, r < 0 ? 0 : r);
        return this;
    }

    address() { return { address: this._address, family: "IPv4", port: this._port }; }

    close(cb) {
        if (this._reading && this.fd >= 0) { _netWatchRemove(this.fd); this._reading = false; }
        if (this.fd >= 0) { __syscall(getSyscall("close"), this.fd); this.fd = -1; }
        this._bound = false;
        this.emit("close");
        if (typeof cb === "function") cb();
        return this;
    }

    // Accepted-but-inert options (documented as not wired to the wire).
    setBroadcast(_on) { return this; }
    setMulticastTTL(_ttl) { return this; }
    setTTL(_ttl) { return this; }
    ref() { return this; }
    unref() { return this; }
}

function createSocket(type, cb) {
    if (type && typeof type === "object") { cb = cb || type.callback; }
    const s = new Socket(type);
    if (typeof cb === "function") s.on("message", cb);
    return s;
}

export { Socket, createSocket };
export default { Socket, createSocket };
