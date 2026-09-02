// asm.js Runtime - Node.js https
//
// Wraps http interfaces using the pure JS tls implementation.


import { EventEmitter } from "./events.js";
import { Server as HttpServer, IncomingMessage, ServerResponse, ClientRequest as HttpClientRequest, Agent as HttpAgent } from "./http.js";
import tls from "./tls.js";

class HttpsServer extends HttpServer {
    constructor(options, requestListener) {
        if (typeof options === "function") {
            requestListener = options;
            options = {};
        }
        super(options, requestListener);
    }
    
    listen() {
        setImmediate(() => {
            this.emit('error', new Error("ENOTIMP: HTTPS Server is not implemented"));
        });
        return this;
    }
}

class Agent extends HttpAgent {
    constructor(options) {
        super(options);
        this.defaultPort = 443;
        this.protocol = 'https:';
    }
    
    createConnection(options, cb) {
        const s = tls.connect(options);
        if (cb) {
            s.once('secureConnect', () => cb(null, s));
            s.once('error', cb);
        }
        return s;
    }
}

const globalAgent = new Agent();

class ClientRequest extends HttpClientRequest {
    constructor(options, cb) {
        // Force the agent to use our HTTPS agent if not specified
        if (!options.agent && options.agent !== false) {
            options.agent = globalAgent;
        }
        super(options, cb);
    }
}

function createServer(options, requestListener) {
    return new HttpsServer(options, requestListener);
}

function request(options, cb) { if (typeof options === 'string') {
        options = { url: options };
    }
    return new ClientRequest(options, cb);
}

function get(options, cb) {
    const req = request(options, cb);
    req.end();
    return req;
}

export const https = {
    Server: HttpsServer,
    Agent,
    globalAgent,
    createServer,
    request,
    get
};

export default https;

