// asm.js Runtime - Node.js dns

export const dns = {
    lookup(hostname, options, callback) {
        if (typeof options === "function") callback = options;
        if (callback) callback(null, { address: "0.0.0.0", family: 4 });
        return { address: "0.0.0.0", family: 4 };
    },
    lookupAsync(hostname, options) {
        return Promise.resolve({ address: "0.0.0.0", family: 4 });
    },
    resolve(hostname, rrtype, callback) {
        if (typeof rrtype === "function") callback = rrtype;
        if (callback) callback(null, []);
        return [];
    },
    resolve4: (hostname, callback) => dns.resolve(hostname, "A", callback),
    resolve6: (hostname, callback) => dns.resolve(hostname, "AAAA", callback),
    resolveMx: (hostname, callback) => dns.resolve(hostname, "MX", callback),
    resolveTxt: (hostname, callback) => dns.resolve(hostname, "TXT", callback),
    resolveSrv: (hostname, callback) => dns.resolve(hostname, "SRV", callback),
    resolvePtr: (hostname, callback) => dns.resolve(hostname, "PTR", callback),
    resolveCname: (hostname, callback) => dns.resolve(hostname, "CNAME", callback),
    resolveNs: (hostname, callback) => dns.resolve(hostname, "NS", callback),
    resolveSoa: (hostname, callback) => dns.resolve(hostname, "SOA", callback),
    resolveAny: (hostname, callback) => dns.resolve(hostname, "ANY", callback),
    reverse(ip, callback) {
        if (callback) callback(null, []);
        return [];
    },
    setServers(servers) {},
    getServers() { return []; },
    setDefaultResultOrder(order) {},
    Promises: {
        lookup: dns.lookup, lookupAsync: dns.lookupAsync, resolve: dns.resolve,
        resolve4: dns.resolve4, resolve6: dns.resolve6, resolveMx: dns.resolveMx,
        resolveTxt: dns.resolveTxt, reverse: dns.reverse
    }
};

export default dns;
