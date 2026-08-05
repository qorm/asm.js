// asm.js Runtime - Node.js stream
// Real Readable/Writable/Duplex/Transform/PassThrough with backpressure,
// pipe(), pipeline(), finished(), and object mode.
// (Async iteration `for await (chunk of stream)` is not supported — see the
// Readable note below; consume with 'data'/'end', read(), pipe(), or pipeline().)
//
// Async model: asm.js has no real timers, but the compiled event loop drains
// microtasks (queueMicrotask / process.nextTick) fully, then one setImmediate,
// re-draining microtasks between each, before the process exits (see
// runtime/core/process.js:_ev_run). We schedule stream progress as microtasks
// via queueMicrotask so data flows and 'data'/'end'/'finish' fire in Node-like
// order. Scheduled callbacks are invoked with zero arguments, so every scheduled
// unit is a zero-arg closure that captures its state.

import { EventEmitter } from "./events.js";

// Zero-arg microtask scheduler (bare global intercepted by the compiler).
function _tick(fn) { queueMicrotask(fn); }

function _defaultHwm(objectMode) { return objectMode ? 16 : 16384; }

// ---------------------------------------------------------------------------
// Readable
// ---------------------------------------------------------------------------
class Readable extends EventEmitter {
    constructor(options) {
        super();
        options = options || {};
        this._readableState = {
            objectMode: !!options.objectMode,
            highWaterMark: options.highWaterMark != null ? options.highWaterMark : _defaultHwm(!!options.objectMode),
            buffer: [],
            length: 0,
            flowing: null,     // null = not yet, true = flowing, false = paused
            ended: false,      // push(null) seen
            endEmitted: false,
            reading: false,    // a _read call is in flight
            scheduled: false,  // a flow microtask is queued
            errored: null,
            encoding: null,
        };
        this.readable = true;
        this.destroyed = false;
        // Allow `new Readable({ read() {...} })`.
        if (typeof options.read === "function") this._read = options.read;
        if (typeof options.destroy === "function") this._destroy = options.destroy;
    }

    // Attaching a 'data' listener switches to flowing mode; 'readable' arms a
    // pull. once()/addListener() both route through on(), so this covers them.
    on(event, listener) {
        const r = super.on(event, listener);
        if (event === "data") _tick(() => this.resume());
        else if (event === "readable") this._schedule();
        return r;
    }
    addListener(event, listener) { return this.on(event, listener); }

    _read(size) {}
    _destroy(err, cb) { if (cb) cb(err); }

    get readableLength() { return this._readableState.length; }
    get readableHighWaterMark() { return this._readableState.highWaterMark; }
    get readableObjectMode() { return this._readableState.objectMode; }
    get readableFlowing() { return this._readableState.flowing; }
    get readableEnded() { return this._readableState.endEmitted; }

    push(chunk, encoding) {
        return this._addChunk(chunk, false);
    }
    unshift(chunk, encoding) {
        return this._addChunk(chunk, true);
    }

    _addChunk(chunk, front) {
        const st = this._readableState;
        if (chunk === null) {
            st.ended = true;
            st.reading = false;
            this._schedule();
            return false;
        }
        if (st.ended) return false;
        if (front) st.buffer.unshift(chunk);
        else st.buffer.push(chunk);
        st.length += st.objectMode ? 1 : (chunk && chunk.length ? chunk.length : 1);
        st.reading = false;
        // 'readable' consumers and flowing consumers both progress via _schedule.
        this._schedule();
        return st.length < st.highWaterMark;
    }

    read(n) {
        const st = this._readableState;
        if (st.buffer.length === 0) {
            // Ask the producer for more (paused-mode pull).
            if (!st.ended && !st.reading) {
                st.reading = true;
                this._read(st.highWaterMark);
            }
            if (st.buffer.length === 0) {
                if (st.ended) this._schedule();
                return null;
            }
        }
        const chunk = st.buffer.shift();
        st.length -= st.objectMode ? 1 : (chunk && chunk.length ? chunk.length : 1);
        if (st.buffer.length === 0 && st.ended) this._schedule();
        return chunk === undefined ? null : chunk;
    }

    // Queue a single flow-progress microtask (coalesced).
    _schedule() {
        const st = this._readableState;
        if (st.scheduled || this.destroyed) return;
        st.scheduled = true;
        _tick(() => { st.scheduled = false; this._flow(); });
    }

    _flow() {
        const st = this._readableState;
        if (this.destroyed) return;
        // Paused 'readable'-mode consumer: pull data so 'readable' can fire.
        if (st.flowing !== true && this.listenerCount("readable") > 0 &&
            st.buffer.length === 0 && !st.ended && !st.reading) {
            st.reading = true;
            this._read(st.highWaterMark);
            if (st.buffer.length > 0 || st.ended) this._schedule();
        }
        // 'readable' event: notify when data is available or stream ended.
        if (this.listenerCount("readable") > 0 && (st.buffer.length > 0 || (st.ended && !st.endEmitted))) {
            this.emit("readable");
        }
        if (st.flowing === true) {
            while (st.flowing === true && st.buffer.length > 0) {
                const chunk = st.buffer.shift();
                st.length -= st.objectMode ? 1 : (chunk && chunk.length ? chunk.length : 1);
                this.emit("data", chunk);
            }
            // Pull more if drained and not ended.
            if (st.flowing === true && st.buffer.length === 0 && !st.ended && !st.reading) {
                st.reading = true;
                this._read(st.highWaterMark);
                if (st.buffer.length > 0) this._schedule();
            }
        }
        // End-of-stream.
        if (st.ended && !st.endEmitted && st.buffer.length === 0) {
            st.endEmitted = true;
            this.readable = false;
            this.emit("end");
        }
    }

    isPaused() { return this._readableState.flowing === false; }

    pause() {
        if (this._readableState.flowing !== false) {
            this._readableState.flowing = false;
            this.emit("pause");
        }
        return this;
    }

    resume() {
        const st = this._readableState;
        if (st.flowing !== true) {
            st.flowing = true;
            this.emit("resume");
        }
        this._schedule();
        return this;
    }

    pipe(dest, options) {
        options = options || {};
        const src = this;
        const onData = (chunk) => {
            const ok = dest.write(chunk);
            if (ok === false) {
                src.pause();
                dest.once("drain", () => src.resume());
            }
        };
        src.on("data", onData);
        if (options.end !== false) {
            src.on("end", () => { dest.end(); });
        }
        src.on("error", (err) => {
            if (dest.listenerCount("error") > 0) dest.emit("error", err);
        });
        dest.emit("pipe", src);
        return dest;
    }

    setEncoding(enc) { this._readableState.encoding = enc; return this; }

    destroy(err, cb) {
        if (this.destroyed) return this;
        this.destroyed = true;
        this.readable = false;
        this._destroy(err || null, (e) => {
            if (e) this.emit("error", e);
            else if (err) this.emit("error", err);
            _tick(() => this.emit("close"));
        });
        return this;
    }

    // NOTE: async iteration (`for await (const chunk of readable)`) is NOT
    // supported. A class-body computed [Symbol.asyncIterator] is not dispatched
    // by `for await` in this engine, and attaching one via prototype assignment
    // pushes this (already large) module past a layout-sensitive codegen
    // threshold that crashes module init. Consume streams with 'data'/'end'
    // events, read(), pipe(), or pipeline() instead. See
    // docs/NODEJS_SUPPORT_ANALYSIS.md.

    // Readable.from(iterable | asyncIterable | iterator) -> Readable
    static from(iterable, options) {
        const r = new Readable(Object.assign({ objectMode: true }, options || {}));
        // Arrays: asm.js does not expose Array.prototype[Symbol.iterator] as a
        // callable, so iterate by index.
        if (Array.isArray(iterable)) {
            let i = 0;
            r._read = function () {
                if (i < iterable.length) r.push(iterable[i++]);
                else r.push(null);
            };
            return r;
        }
        // Async iterable.
        if (iterable && typeof iterable[Symbol.asyncIterator] === "function") {
            const asyncIt = iterable[Symbol.asyncIterator]();
            r._read = function () {
                asyncIt.next().then((res) => {
                    if (res.done) r.push(null);
                    else r.push(res.value);
                }, (err) => r.destroy(err));
            };
            return r;
        }
        // Sync iterable (has [Symbol.iterator]) or a raw iterator/generator
        // (has .next directly).
        let it = null;
        if (iterable && typeof iterable[Symbol.iterator] === "function") it = iterable[Symbol.iterator]();
        else if (iterable && typeof iterable.next === "function") it = iterable;
        if (it) {
            r._read = function () {
                const res = it.next();
                if (res && res.done) r.push(null);
                else r.push(res.value);
            };
            return r;
        }
        r.push(null);
        return r;
    }
}

// ---------------------------------------------------------------------------
// Writable
// ---------------------------------------------------------------------------
class Writable extends EventEmitter {
    constructor(options) {
        super();
        options = options || {};
        this._writableState = {
            objectMode: !!options.objectMode,
            highWaterMark: options.highWaterMark != null ? options.highWaterMark : _defaultHwm(!!options.objectMode),
            length: 0,
            writing: false,
            corked: 0,
            buffered: [],      // { chunk, cb }
            ending: false,
            ended: false,
            finished: false,
            needDrain: false,
            destroyed: false,
            defaultEncoding: "utf8",
        };
        this.writable = true;
        this.destroyed = false;
        if (typeof options.write === "function") this._write = options.write;
        if (typeof options.writev === "function") this._writev = options.writev;
        if (typeof options.final === "function") this._final = options.final;
        if (typeof options.destroy === "function") this._destroy = options.destroy;
    }

    _write(chunk, encoding, callback) { callback(); }
    _final(callback) { callback(); }
    _destroy(err, cb) { if (cb) cb(err); }

    get writableLength() { return this._writableState.length; }
    get writableHighWaterMark() { return this._writableState.highWaterMark; }
    get writableObjectMode() { return this._writableState.objectMode; }
    get writableEnded() { return this._writableState.ending; }
    get writableFinished() { return this._writableState.finished; }

    write(chunk, encoding, callback) {
        if (typeof encoding === "function") { callback = encoding; encoding = null; }
        const st = this._writableState;
        if (st.ending || st.ended) {
            const err = new Error("write after end");
            if (callback) _tick(() => callback(err));
            this.emit("error", err);
            return false;
        }
        st.length += st.objectMode ? 1 : (chunk && chunk.length ? chunk.length : 1);
        st.buffered.push({ chunk, cb: callback, encoding });
        if (st.corked === 0) this._scheduleWrite();
        const ret = st.length < st.highWaterMark;
        if (!ret) st.needDrain = true;
        return ret;
    }

    _scheduleWrite() {
        const st = this._writableState;
        if (st.writing || st.destroyed) return;
        if (st.buffered.length === 0) { this._maybeFinish(); return; }
        st.writing = true;
        const item = st.buffered.shift();
        const self = this;
        const done = (err) => {
            st.writing = false;
            const consumed = st.objectMode ? 1 : (item.chunk && item.chunk.length ? item.chunk.length : 1);
            st.length -= consumed;
            if (item.cb) item.cb(err || null);
            if (err) { self.emit("error", err); return; }
            // Emit 'drain' once buffer is below the watermark again.
            if (st.needDrain && st.length < st.highWaterMark) {
                st.needDrain = false;
                self.emit("drain");
            }
            if (st.buffered.length > 0) self._scheduleWrite();
            else self._maybeFinish();
        };
        _tick(() => self._write(item.chunk, item.encoding || st.defaultEncoding, done));
    }

    _maybeFinish() {
        const st = this._writableState;
        if (st.ending && !st.finished && !st.writing && st.buffered.length === 0) {
            st.finished = true;
            st.ended = true;
            this.writable = false;
            const self = this;
            this._final((err) => {
                if (err) { self.emit("error", err); return; }
                self.emit("finish");
            });
        }
    }

    // NOTE: `end` is intentionally defined via prototype assignment below, not
    // as a class-body method. A class-body method literally named `end`
    // currently miscompiles (control-flow corruption: the program's main body
    // re-runs infinitely). This is a compiler/codegen bug outside this shim's
    // lane; assigning to the prototype gives the function a distinct label and
    // sidesteps it. See docs/NODEJS_SUPPORT_ANALYSIS.md.

    cork() { this._writableState.corked++; }
    uncork() {
        const st = this._writableState;
        if (st.corked > 0) st.corked--;
        if (st.corked === 0) this._scheduleWrite();
    }
    setDefaultEncoding(enc) { this._writableState.defaultEncoding = enc; return this; }

    destroy(err, cb) {
        if (this.destroyed) return this;
        this.destroyed = true;
        this._writableState.destroyed = true;
        this.writable = false;
        this._destroy(err || null, (e) => {
            if (e) this.emit("error", e);
            else if (err) this.emit("error", err);
            _tick(() => this.emit("close"));
        });
        return this;
    }
}

// See the note in the Writable class: a class-body `end()` miscompiles, so it
// is attached to the prototype here instead.
Writable.prototype.end = function (chunk, encoding, callback) {
    if (typeof chunk === "function") { callback = chunk; chunk = null; encoding = null; }
    else if (typeof encoding === "function") { callback = encoding; encoding = null; }
    const st = this._writableState;
    if (chunk !== null && chunk !== undefined) this.write(chunk, encoding);
    st.ending = true;
    if (callback) this.once("finish", callback);
    if (st.corked === 0) this._scheduleWrite();
    return this;
};

// ---------------------------------------------------------------------------
// Duplex / Transform / PassThrough
//
// IMPORTANT DESIGN CONSTRAINT: in this (large) module, a class that `extends
// Readable` miscompiles — the program segfaults at module-init time. The bug is
// a layout-sensitive codegen defect outside this shim's lane (`extends
// EventEmitter` and `extends Writable` are both fine; only `extends Readable`
// trips it). So Duplex/Transform are built by COMPOSITION: each `extends
// EventEmitter`, owns an internal Readable for its readable side, and carries an
// inline writable side. Readable-facing calls delegate to the internal
// Readable. See docs/NODEJS_SUPPORT_ANALYSIS.md.
// ---------------------------------------------------------------------------

// Shared writable-side state + engine, as free functions over `self._ws` so the
// logic is written once and both Duplex and Transform stay small.
function _wInit(self, options) {
    self._ws = {
        objectMode: !!options.objectMode,
        highWaterMark: options.highWaterMark != null ? options.highWaterMark : _defaultHwm(!!options.objectMode),
        length: 0,
        writing: false,
        corked: 0,
        buffered: [],
        ending: false,
        ended: false,
        finished: false,
        needDrain: false,
        defaultEncoding: "utf8",
    };
    self.writable = true;
    if (typeof options.write === "function") self._write = options.write;
    if (typeof options.final === "function") self._final = options.final;
}

function _wWrite(self, chunk, encoding, callback) {
    if (typeof encoding === "function") { callback = encoding; encoding = null; }
    const st = self._ws;
    if (st.ending || st.ended) {
        const err = new Error("write after end");
        if (callback) _tick(() => callback(err));
        self.emit("error", err);
        return false;
    }
    st.length += st.objectMode ? 1 : (chunk && chunk.length ? chunk.length : 1);
    st.buffered.push({ chunk, cb: callback, encoding });
    if (st.corked === 0) _wDrain(self);
    const ret = st.length < st.highWaterMark;
    if (!ret) st.needDrain = true;
    return ret;
}

function _wDrain(self) {
    const st = self._ws;
    if (st.writing) return;
    if (st.buffered.length === 0) { _wFinish(self); return; }
    st.writing = true;
    const item = st.buffered.shift();
    const done = (err) => {
        st.writing = false;
        const consumed = st.objectMode ? 1 : (item.chunk && item.chunk.length ? item.chunk.length : 1);
        st.length -= consumed;
        if (item.cb) item.cb(err || null);
        if (err) { self.emit("error", err); return; }
        if (st.needDrain && st.length < st.highWaterMark) { st.needDrain = false; self.emit("drain"); }
        if (st.buffered.length > 0) _wDrain(self);
        else _wFinish(self);
    };
    _tick(() => self._write(item.chunk, item.encoding || st.defaultEncoding, done));
}

function _wFinish(self) {
    const st = self._ws;
    if (st.ending && !st.finished && !st.writing && st.buffered.length === 0) {
        st.finished = true;
        st.ended = true;
        self.writable = false;
        self._final((err) => {
            if (err) { self.emit("error", err); return; }
            self.emit("finish");
        });
    }
}

function _wEnd(self, chunk, encoding, callback) {
    if (typeof chunk === "function") { callback = chunk; chunk = null; encoding = null; }
    else if (typeof encoding === "function") { callback = encoding; encoding = null; }
    const st = self._ws;
    if (chunk !== null && chunk !== undefined) _wWrite(self, chunk, encoding);
    st.ending = true;
    if (callback) self.once("finish", callback);
    if (st.corked === 0) _wDrain(self);
    return self;
}

class Duplex extends EventEmitter {
    constructor(options) {
        super();
        options = options || {};
        const self = this;
        // Readable side: an internal Readable whose _read defers to self._read.
        this._readable = new Readable({
            objectMode: !!options.objectMode,
            highWaterMark: options.highWaterMark,
            read() { self._read(self._readable._readableState.highWaterMark); },
        });
        this.readable = true;
        // Surface readable-side 'error'/'close' through the Duplex emitter.
        this._readable.on("error", (e) => self.emit("error", e));
        this._readable.on("close", () => self.emit("close"));
        // Writable side (inline).
        _wInit(this, options);
        if (typeof options.read === "function") this._read = options.read;
    }

    _read(size) {}
    _write(chunk, encoding, callback) { callback(); }
    _final(callback) { callback(); }

    // Route readable-facing listeners to the internal Readable; everything else
    // (drain/finish/error/close/custom) stays on this emitter.
    on(event, listener) {
        if (event === "data" || event === "end" || event === "readable" ||
            event === "pause" || event === "resume") {
            this._readable.on(event, listener);
        } else {
            super.on(event, listener);
        }
        return this;
    }
    addListener(event, listener) { return this.on(event, listener); }
    once(event, listener) {
        if (event === "data" || event === "end" || event === "readable" ||
            event === "pause" || event === "resume") {
            this._readable.once(event, listener);
            return this;
        }
        return super.once(event, listener);
    }

    // Readable-side delegation.
    push(chunk, encoding) { return this._readable.push(chunk, encoding); }
    unshift(chunk, encoding) { return this._readable.unshift(chunk, encoding); }
    read(n) { return this._readable.read(n); }
    pause() { this._readable.pause(); return this; }
    resume() { this._readable.resume(); return this; }
    isPaused() { return this._readable.isPaused(); }
    setEncoding(enc) { this._readable.setEncoding(enc); return this; }
    pipe(dest, options) { return this._readable.pipe(dest, options); }
    // Async iteration is unsupported (see Readable note).

    get readableLength() { return this._readable._readableState.length; }
    get readableHighWaterMark() { return this._readable._readableState.highWaterMark; }
    get readableObjectMode() { return this._readable._readableState.objectMode; }
    get readableFlowing() { return this._readable._readableState.flowing; }
    get readableEnded() { return this._readable._readableState.endEmitted; }
    get writableLength() { return this._ws.length; }
    get writableHighWaterMark() { return this._ws.highWaterMark; }
    get writableObjectMode() { return this._ws.objectMode; }
    get writableFinished() { return this._ws.finished; }
    get writableEnded() { return this._ws.ending; }

    // Writable-side delegation.
    write(chunk, encoding, callback) { return _wWrite(this, chunk, encoding, callback); }
    cork() { this._ws.corked++; }
    uncork() { const st = this._ws; if (st.corked > 0) st.corked--; if (st.corked === 0) _wDrain(this); }
    setDefaultEncoding(enc) { this._ws.defaultEncoding = enc; return this; }

    destroy(err, cb) {
        if (this.destroyed) return this;
        this.destroyed = true;
        this.readable = false;
        this.writable = false;
        this._readable.destroy(err);
        if (cb) cb(err || null);
        return this;
    }
}

// `end` attached via prototype (a class-body method literally named `end`
// miscompiles — see the Writable note).
Duplex.prototype.end = function (chunk, encoding, callback) {
    return _wEnd(this, chunk, encoding, callback);
};

// Transform: writes flow through _transform to the readable side; _flush runs at
// end, then the readable side is terminated with push(null).
class Transform extends Duplex {
    constructor(options) {
        super(options);
        options = options || {};
        if (typeof options.transform === "function") this._transform = options.transform;
        if (typeof options.flush === "function") this._flush = options.flush;
    }
    _transform(chunk, encoding, callback) { callback(null, chunk); }
    _flush(callback) { callback(); }

    _write(chunk, encoding, callback) {
        const self = this;
        this._transform(chunk, encoding, function (err, data) {
            if (err) { callback(err); return; }
            if (data !== null && data !== undefined) self.push(data);
            callback();
        });
    }
    _final(callback) {
        const self = this;
        this._flush(function (err, data) {
            if (err) { callback(err); return; }
            if (data !== null && data !== undefined) self.push(data);
            self.push(null);
            callback();
        });
    }
}

class PassThrough extends Transform {
    _transform(chunk, encoding, callback) { callback(null, chunk); }
}

// ---------------------------------------------------------------------------
// finished(stream, cb) / pipeline(...streams, cb)
// ---------------------------------------------------------------------------
function finished(stream, options, callback) {
    if (typeof options === "function") { callback = options; options = {}; }
    let called = false;
    let resolveP = null, rejectP = null, promise = null;
    const done = (err) => {
        if (called) return;
        called = true;
        if (typeof callback === "function") callback(err || null);
        else if (err && rejectP) rejectP(err);
        else if (resolveP) resolveP();
    };
    stream.on("end", () => done());
    stream.on("finish", () => done());
    stream.on("close", () => done());
    stream.on("error", (err) => done(err));
    // Already-finished streams.
    if (stream._writableState && stream._writableState.finished) _tick(() => done());
    if (stream._readableState && stream._readableState.endEmitted) _tick(() => done());
    if (typeof callback !== "function") {
        promise = new Promise((res, rej) => { resolveP = res; rejectP = rej; });
        return promise;
    }
    return () => { called = true; };
}

function pipeline(...args) {
    let callback = null;
    if (typeof args[args.length - 1] === "function") callback = args.pop();
    const streams = args;
    let promiseResolve = null, promiseReject = null, promise = null;
    if (!callback) {
        promise = new Promise((res, rej) => { promiseResolve = res; promiseReject = rej; });
    }
    let settled = false;
    const finish = (err) => {
        if (settled) return;
        settled = true;
        if (err) {
            for (const s of streams) { if (s && typeof s.destroy === "function") s.destroy(err); }
        }
        if (callback) callback(err || null);
        else if (err && promiseReject) promiseReject(err);
        else if (promiseResolve) promiseResolve();
    };
    // Wire src -> ... -> dest via pipe.
    for (let i = 0; i < streams.length - 1; i++) {
        const src = streams[i];
        const dest = streams[i + 1];
        src.on("error", (e) => finish(e));
        src.pipe(dest);
    }
    const last = streams[streams.length - 1];
    last.on("error", (e) => finish(e));
    last.on("finish", () => finish(null));
    last.on("end", () => finish(null));
    return callback ? last : promise;
}

const streamAPI = { Readable, Writable, Duplex, Transform, PassThrough, finished, pipeline, Stream: Readable };
export { Readable, Writable, Duplex, Transform, PassThrough, finished, pipeline };
export default streamAPI;
