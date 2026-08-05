// asm.js Runtime - Node.js events
// Provides EventEmitter for asm.js compiled binaries

export class EventEmitter {
    constructor() {
        this._events = {};
        this._eventsCount = 0;
        this._maxListeners = 10;
    }

    on(event, listener) {
        if (!this._events[event]) this._events[event] = [];
        this._events[event].push(listener);
        this._eventsCount++;
        return this;
    }

    once(event, listener) {
        const wrapper = (...args) => {
            this.removeListener(event, wrapper);
            listener(...args);
        };
        wrapper.listener = listener; // 供 removeListener 按原始 listener 匹配
        return this.on(event, wrapper);
    }

    // Node: prependOnceListener 把一次性包装器插到队首
    prependOnceListener(event, listener) {
        const wrapper = (...args) => {
            this.removeListener(event, wrapper);
            listener(...args);
        };
        wrapper.listener = listener;
        return this.prependListener(event, wrapper);
    }

    addListener(event, listener) { return this.on(event, listener); }
    prependListener(event, listener) {
        if (!this._events[event]) this._events[event] = [];
        this._events[event].unshift(listener);
        this._eventsCount++;
        return this;
    }
    // Node 里 off 是 removeListener 的别名
    off(event, listener) { return this.removeListener(event, listener); }

    removeListener(event, listener) {
        const arr = this._events[event];
        if (!arr) return this;
        // Node: 匹配原始 listener 或 once/prependOnce 包装器(wrapper.listener)
        let idx = -1;
        for (let i = arr.length - 1; i >= 0; i--) {
            if (arr[i] === listener || arr[i].listener === listener) { idx = i; break; }
        }
        if (idx >= 0) {
            arr.splice(idx, 1);
            this._eventsCount--;
        }
        return this;
    }

    removeAllListeners(event) {
        if (event) { delete this._events[event]; }
        else { this._events = {}; }
        this._eventsCount = 0;
        return this;
    }

    setMaxListeners(n) { this._maxListeners = n; return this; }
    getMaxListeners() { return this._maxListeners; }
    listeners(event) { return this._events[event] || []; }
    rawListeners(event) { return this.listeners(event); }

    emit(event, ...args) {
        const listeners = this._events[event];
        if (!listeners || !listeners.length) {
            // Node: 无监听器的 'error' 事件会抛出(错误对象或包装的未处理错误)
            if (event === "error") {
                const err = args[0];
                if (err instanceof Error) throw err;
                throw new Error("Unhandled 'error' event");
            }
            return false;
        }
        // 复制快照:once/prependOnce 会在派发期间移除自身,避免遍历时跳过后继监听器
        const copy = listeners.slice();
        for (let i = 0; i < copy.length; i++) copy[i](...args);
        return true;
    }

    eventNames() {
        // 仅返回仍有监听器的事件(removeListener/once 会留下空数组键)
        const names = [];
        const keys = Object.keys(this._events);
        for (let i = 0; i < keys.length; i++) {
            const arr = this._events[keys[i]];
            if (arr && arr.length > 0) names.push(keys[i]);
        }
        return names;
    }
    listenerCount(type) { return (this._events[type] || []).length; }

    static listenerCount(emitter, type) { return emitter.listenerCount(type); }
    static on(emitter, eventName) {
        return { emitter, eventName, next() {} };
    }
}

// node: EventEmitter.defaultMaxListeners === 10
EventEmitter.defaultMaxListeners = 10;
// node: events.EventEmitter.EventEmitter 自引用 + errorMonitor 符号
EventEmitter.EventEmitter = EventEmitter;
EventEmitter.errorMonitor = Symbol("events.errorMonitor");
EventEmitter.captureRejectionSymbol = Symbol("nodejs.rejection");

// node: events.once(emitter, name) → Promise,解析为该事件的参数数组
export function once(emitter, name) {
    return new Promise((resolve, reject) => {
        const onEvent = (...args) => {
            if (name !== "error") emitter.removeListener("error", onError);
            resolve(args);
        };
        const onError = (err) => {
            emitter.removeListener(name, onEvent);
            reject(err);
        };
        emitter.once(name, onEvent);
        if (name !== "error") emitter.once("error", onError);
    });
}
EventEmitter.once = once;

// node: events.getEventListeners(emitter, name)
export function getEventListeners(emitter, name) {
    if (emitter && typeof emitter.listeners === "function") return emitter.listeners(name);
    return [];
}

// node: events.setMaxListeners(n, ...emitters)
export function setMaxListeners(n, ...emitters) {
    for (let i = 0; i < emitters.length; i++) {
        if (emitters[i] && typeof emitters[i].setMaxListeners === "function") {
            emitters[i].setMaxListeners(n);
        }
    }
}

export default EventEmitter;
