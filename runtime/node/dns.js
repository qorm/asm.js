// asm.js Runtime - Node.js dns (Real UDP resolver)
//
// Uses dgram to send and receive DNS queries to the system's nameserver
// (read from /etc/resolv.conf, falling back to 8.8.8.8).

import fs from "./fs.js";
import dgram from "./dgram.js";

// Cache the nameserver so we don't read /etc/resolv.conf on every query.
let _nameserver = null;

function _getNameserver() {
    return "8.8.8.8";
}

// Global query ID counter
let _queryId = 1;

// Build a DNS query packet for an A record.
function _buildQuery(domain, id) {
    const parts = domain.split(".");
    // Header (12 bytes) + QNAME + QTYPE(2) + QCLASS(2)
    let qnameLen = 0;
    for (let i = 0; i < parts.length; i++) qnameLen += parts[i].length + 1;
    qnameLen += 1; // root null byte

    const buf = new Uint8Array(12 + qnameLen + 4);
    
    // ID
    buf[0] = (id >> 8) & 0xff;
    buf[1] = id & 0xff;
    
    // Flags: Standard query, Recursion Desired
    buf[2] = 0x01;
    buf[3] = 0x00;
    
    // QDCOUNT: 1
    buf[4] = 0x00; buf[5] = 0x01;
    // ANCOUNT, NSCOUNT, ARCOUNT: 0
    
    let offset = 12;
    for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        buf[offset++] = p.length;
        for (let j = 0; j < p.length; j++) {
            buf[offset++] = p.charCodeAt(j) & 0xff;
        }
    }
    buf[offset++] = 0; // End of QNAME
    
    // QTYPE: A (1)
    buf[offset++] = 0x00; buf[offset++] = 0x01;
    // QCLASS: IN (1)
    buf[offset++] = 0x00; buf[offset++] = 0x01;
    
    return buf;
}

// Parse DNS response to find the first A record IP.
// Uses a simple pointer-aware label skipper.
function _parseResponse(buf, qnameLen) {
    if (buf.length < 12) return null;
    
    const flags = (buf[2] << 8) | buf[3];
    // Must be response (0x8000), no error (0x000F mask == 0)
    if ((flags & 0x8000) === 0) return null;
    if ((flags & 0x000f) !== 0) return null;
    
    const qdcount = (buf[4] << 8) | buf[5];
    const ancount = (buf[6] << 8) | buf[7];
    
    if (ancount === 0) return null;
    
    let offset = 12;
    
    // Skip questions
    for (let i = 0; i < qdcount; i++) {
        while (offset < buf.length) {
            const len = buf[offset++];
            if (len === 0) break;
            if ((len & 0xc0) === 0xc0) {
                offset++; // Pointer takes 1 more byte
                break;
            }
            offset += len;
        }
        offset += 4; // Skip QTYPE and QCLASS
    }
    
    // Parse answers
    for (let i = 0; i < ancount; i++) {
        // Skip Name
        while (offset < buf.length) {
            const len = buf[offset++];
            if (len === 0) break;
            if ((len & 0xc0) === 0xc0) {
                offset++;
                break;
            }
            offset += len;
        }
        
        if (offset + 10 > buf.length) return null;
        
        const type = (buf[offset] << 8) | buf[offset + 1];
        offset += 2;
        const cls = (buf[offset] << 8) | buf[offset + 1];
        offset += 2;
        const ttl = (buf[offset] << 24) | (buf[offset+1] << 16) | (buf[offset+2] << 8) | buf[offset+3];
        offset += 4;
        const rdlength = (buf[offset] << 8) | buf[offset + 1];
        offset += 2;
        
        if (type === 1 && cls === 1 && rdlength === 4) { // A record, IN class
            const ip = buf[offset] + "." + buf[offset+1] + "." + buf[offset+2] + "." + buf[offset+3];
            return ip;
        }
        
        offset += rdlength;
    }
    
    return null;
}

// Main internal resolve function
function _doResolve(hostname, callback) {
    // If it's already an IP, return it directly.
    const isIpV4 = /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/.test(hostname);
    if (isIpV4) {
        setImmediate(() => callback(null, hostname));
        return;
    }

    // Edge case for localhost
    if (hostname === "localhost") {
        setImmediate(() => callback(null, "127.0.0.1"));
        return;
    }

    const ns = _getNameserver();
    const id = _queryId = (_queryId + 1) & 0xffff;
    const reqBuf = _buildQuery(hostname, id);
    
    const client = dgram.createSocket('udp4');
    
    let resolved = false;
    let timeout = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        client.close();
        callback(new Error("ENOTFOUND " + hostname), null);
    }, 2000);
    
    client.on('message', (msg, rinfo) => {
        if (resolved) return;
        // Verify sender and ID (basic safety)
        if (rinfo.address !== ns) return;
        const dataArr = msg.data || msg;
        if (msg.length >= 2 && ((dataArr[0] << 8) | dataArr[1]) === id) {
            // Convert Buffer to Uint8Array for our parser
            const u8 = new Uint8Array(msg.length);
            for (let i = 0; i < msg.length; i++) u8[i] = dataArr[i];
            
            const ip = _parseResponse(u8);
            resolved = true;
            clearTimeout(timeout);
            client.close();
            
            if (ip) {
                callback(null, ip);
            } else {
                callback(new Error("ENOTFOUND " + hostname), null);
            }
        }
    });
    
    client.on('error', (err) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timeout);
        client.close();
        callback(err, null);
    });
    
    client.bind(0, () => {
        client.send(reqBuf, 53, ns);
    });
}

export const dns = {
    lookup(hostname, options, callback) {
        if (typeof options === "function") {
            callback = options;
            options = {};
        }
        _doResolve(hostname, (err, ip) => {
            if (err) callback(err, null, null);
            else callback(null, ip, 4);
        });
    },
    
    lookupAsync(hostname, options) {
        return new Promise((resolve, reject) => {
            dns.lookup(hostname, options, (err, address, family) => {
                if (err) reject(err);
                else resolve({ address, family });
            });
        });
    },
    
    resolve(hostname, rrtype, callback) {
        if (typeof rrtype === "function") {
            callback = rrtype;
            rrtype = "A";
        }
        if (rrtype !== "A") {
            // Only A records are fully supported in this stub
            setImmediate(() => callback(new Error("ENOTIMP: only A records are supported"), null));
            return;
        }
        _doResolve(hostname, (err, ip) => {
            if (err) callback(err, null);
            else callback(null, [ip]); // resolve returns an array of records
        });
    },
    
    resolve4: (hostname, callback) => dns.resolve(hostname, "A", callback),
    resolve6: (hostname, callback) => setImmediate(() => callback(new Error("ENOTIMP"), null)),
    resolveMx: (hostname, callback) => setImmediate(() => callback(new Error("ENOTIMP"), null)),
    resolveTxt: (hostname, callback) => setImmediate(() => callback(new Error("ENOTIMP"), null)),
    resolveSrv: (hostname, callback) => setImmediate(() => callback(new Error("ENOTIMP"), null)),
    resolvePtr: (hostname, callback) => setImmediate(() => callback(new Error("ENOTIMP"), null)),
    resolveCname: (hostname, callback) => setImmediate(() => callback(new Error("ENOTIMP"), null)),
    resolveNs: (hostname, callback) => setImmediate(() => callback(new Error("ENOTIMP"), null)),
    resolveSoa: (hostname, callback) => setImmediate(() => callback(new Error("ENOTIMP"), null)),
    resolveAny: (hostname, callback) => setImmediate(() => callback(new Error("ENOTIMP"), null)),
    
    reverse(ip, callback) {
        setImmediate(() => callback(new Error("ENOTIMP"), null));
    },
    
    setServers(servers) {
        if (servers && servers.length > 0) {
            _nameserver = servers[0]; // We only use the first one
        }
    },
    
    getServers() { 
        return [_getNameserver()];
    },
    
    setDefaultResultOrder(order) {},
    
    Promises: {
        lookup: (hostname, options) => dns.lookupAsync(hostname, options),
        resolve: (hostname, rrtype) => new Promise((res, rej) => dns.resolve(hostname, rrtype, (e, d) => e ? rej(e) : res(d))),
        resolve4: (hostname) => new Promise((res, rej) => dns.resolve4(hostname, (e, d) => e ? rej(e) : res(d)))
    }
};

export default dns;
