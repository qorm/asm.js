// asm.js Runtime - Node.js Compatibility Layer
// Main entry point that imports and exports all Node.js modules

import constants from "./constants.js";
import _string from "./_string.js";
import process from "./process.js";
import console from "./console.js";
import fs from "./fs.js";
import path from "./path.js";
import * as os from "./os.js";
import buffer from "./buffer.js";
import util from "./util.js";
import events from "./events.js";
import stream from "./stream.js";
import net from "./net.js";
import http from "./http.js";
import dns from "./dns.js";
import timers from "./timers.js";
import crypto from "./crypto.js";
import url from "./url.js";
import zlib from "./zlib.js";
import string_decoder from "./string_decoder.js";
import tty from "./tty.js";
import vm from "./vm.js";
import child_process from "./child_process.js";
import assert from "./assert.js";
import querystring from "./querystring.js";

// Re-export all modules as named exports (for backward compatibility)
export { constants, _string, process, console, fs, path, os, buffer, util, events, stream, net, http, dns, timers, crypto, url, zlib, string_decoder, tty, vm, child_process, assert, querystring };

// Re-export all OS functions directly (for import * as os from "os")
export * from "./os.js";

// Also export under original names
export { default as nodeConstants } from "./constants.js";
export { default as nodeString } from "./_string.js";
export { default as nodeProcess } from "./process.js";
export { default as nodeConsole } from "./console.js";
export { default as nodeFs } from "./fs.js";
export { default as nodePath } from "./path.js";
export { default as nodeOs } from "./os.js";
export { default as nodeBuffer } from "./buffer.js";
export { default as nodeUtil } from "./util.js";
export { default as nodeEvents } from "./events.js";
export { default as nodeStream } from "./stream.js";
export { default as nodeNet } from "./net.js";
export { default as nodeHttp } from "./http.js";
export { default as nodeDns } from "./dns.js";
export { default as nodeTimers } from "./timers.js";
export { default as nodeCrypto } from "./crypto.js";
export { default as nodeUrl } from "./url.js";
export { default as nodeZlib } from "./zlib.js";
export { default as nodeStringDecoder } from "./string_decoder.js";
export { default as nodeTty } from "./tty.js";
export { default as nodeVm } from "./vm.js";
export { default as nodeChildProcess } from "./child_process.js";

// Create comprehensive default export
const nodeJS = {
    process,
    console,
    Buffer: buffer,
    fs,
    path,
    os,
    util,
    events,
    stream,
    net,
    http,
    dns,
    timers,
    crypto,
    url,
    zlib,
    string_decoder,
    tty,
    vm,
    child_process,
    assert,
    querystring,
    versions: {
        node: "20.0.0",
        v8: "11.3.0",
        uv: "1.0.0",
        zlib: "1.2.13",
        ares: "1.19.1",
        modules: "108",
        nghttp2: "1.52.0",
        napi: "8",
        llhttp: "8.1.0",
        openssl: "3.0.8",
        cldr: "42.0",
        icu: "72.1",
        tz: "2022f",
        unicode: "15.0.0",
    },
    _cache: {},
    require(moduleName) {
        if (this._cache[moduleName]) return this._cache[moduleName];
        return {};
    },
};

// Set up global bindings
if (typeof globalThis !== 'undefined') {
    globalThis.process = nodeJS.process;
    globalThis.console = nodeJS.console;
    globalThis.Buffer = nodeJS.Buffer;
}

export default nodeJS;
