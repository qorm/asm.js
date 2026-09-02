// asm.js Runtime - Node.js tls (Powered by node-forge)
//
// Implements a pure JS TLS 1.2 client using node-forge, compiled to native.


import forge from "./_forge.js";
import { Socket, connect as netConnect } from "./net.js";
import { Buffer } from "./buffer.js";
import { EventEmitter } from "./events.js";

export class TLSSocket extends EventEmitter {
    constructor(socket, options) {
        super();
        this.encrypted = true;
        console.log("TLSSocket 1"); this._socket = socket;
        this.authorized = false;
        this.authorizationError = null;
        console.log("TLSSocket 2"); this.destroyed = false;
        
        console.log("TLSSocket 3"); this._tls = forge.tls.createConnection({
            server: false,
            verify: (connection, verified, depth, certs) => {
                // Ignore certificate validation for this basic port
                // A real implementation would verify the CA chain here.
                return true;
            },
            connected: (connection) => {
                this.authorized = true;
                this.emit('secureConnect');
            },
            tlsDataReady: (connection) => {
                // Encrypted data to send to server over TCP
                const data = connection.tlsData.getBytes();
                const buf = new Buffer(data.length);
                for (let i = 0; i < data.length; i++) {
                    buf.data[i] = data.charCodeAt(i);
                }
                this._socket.write(buf);
            },
            dataReady: (connection) => {
                // Decrypted data received from server
                const data = connection.data.getBytes();
                const buf = new Buffer(data.length);
                for (let i = 0; i < data.length; i++) {
                    buf.data[i] = data.charCodeAt(i);
                }
                this.emit('data', buf);
            },
            closed: () => {
                this.emit('end');
                this.destroy();
            },
            error: (connection, error) => {
                this.emit('error', error);
                this.destroy();
            }
        });
        
        console.log("TLSSocket 4"); this._socket.on('data', (data) => {
            let str = '';
            // `data` is a asm.js Buffer (array-backed)
            const u8 = data.data ? data.data : data;
            for (let i = 0; i < data.length; i++) {
                str += String.fromCharCode(u8[i]);
            }
            this._tls.process(str);
        });
        
        console.log("TLSSocket 5"); this._socket.on('close', (hadError) => {
            this.emit('close', hadError);
        });
        
        this._socket.on('error', (err) => {
            this.emit('error', err);
        });
        
        // Start handshake
        console.log("TLSSocket 6 about to handshake"); try { this._tls.handshake(); } catch (e) { console.log("handshake threw:", e.message, e.stack); } console.log("TLSSocket 7 handshake done");
    }
    
    write(data, encoding, cb) {
        if (this.destroyed) {
            if (cb) cb(new Error("Socket is closed"));
            return false;
        }
        let str = '';
        if (typeof data === 'string') {
            const buf = Buffer.from(data, encoding);
            const u8 = buf.data;
            for (let i = 0; i < buf.length; i++) str += String.fromCharCode(u8[i]);
        } else {
            const u8 = data.data ? data.data : data;
            const len = data.length || (data.data ? data.data.length : data.length);
            for (let i = 0; i < len; i++) str += String.fromCharCode(u8[i]);
        }
        this._tls.prepare(str);
        if (cb) setImmediate(cb);
        return true;
    }
    
    end(data, encoding, cb) {
        if (data) this.write(data, encoding);
        this._tls.close();
        if (cb) cb();
        return this;
    }
    
    destroy(err) {
        if (this.destroyed) return;
        this.destroyed = true;
        this._socket.destroy(err);
        this.emit('close', !!err);
    }
    
    setTimeout(msecs, callback) {
        this._socket.setTimeout(msecs, callback);
        return this;
    }
    
    setNoDelay(noDelay) {
        this._socket.setNoDelay(noDelay);
        return this;
    }
    
    setKeepAlive(enable, initialDelay) {
        this._socket.setKeepAlive(enable, initialDelay);
        return this;
    }
    
    get remoteAddress() { return this._socket.remoteAddress; }
    get remotePort() { return this._socket.remotePort; }
    get localAddress() { return this._socket.localAddress; }
    get localPort() { return this._socket.localPort; }
}

export function connect(options, secureConnectListener) {
    if (typeof options === 'string') {
        options = { host: arguments[0], port: arguments[1] };
    }
    const host = options.host || 'localhost';
    const port = options.port || 443;
    
    const tcpSocket = netConnect({ host, port });
    const tlsSocket = new TLSSocket(tcpSocket, options);
    
    console.log("TLSSocket 7"); if (secureConnectListener) {
        tlsSocket.on('secureConnect', secureConnectListener);
    }
    
    console.log("TLSSocket 8 returning"); return tlsSocket;
}

export const tls = {
    TLSSocket,
    connect,
    createServer: () => { throw new Error("ENOTIMP: TLS Server is not implemented"); },
    Server: class extends EventEmitter {
        listen() { throw new Error("ENOTIMP: TLS Server is not implemented"); }
    },
    DEFAULT_MIN_VERSION: 'TLSv1.2'
};

export default tls;

