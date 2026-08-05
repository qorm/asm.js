// asm.js Runtime - Node.js timers
// setTimeout / setImmediate / queueMicrotask 委托给编译器内建的事件循环桥接
// 函数（__asmjs_*），退出前由 _ev_run drain。返回值是句柄对象，可用于
// clearTimeout / clearImmediate 取消。

export function setTimeout(callback, delay, ...args) {
    return __asmjs_setTimeout(callback);
}

export function clearTimeout(handle) {
    __asmjs_clearTimer(handle);
}

// setInterval: asm.js has no real repeat timer, but the event loop re-drains
// microtasks/immediates until they run out. We model an interval as a callback
// that reschedules itself via setImmediate until cleared. This makes the common
// "setInterval + clearInterval after N ticks" pattern terminate correctly.
// (An interval that is never cleared reschedules forever — the process will not
// reach its drain-exit, mirroring Node's "runs until cleared" semantics.)
export function setInterval(callback, period, ...args) {
    const handle = { _isInterval: true, _cancelled: false };
    const tick = () => {
        if (handle._cancelled) return;
        callback(...args);
        if (!handle._cancelled) __asmjs_setImmediate(tick);
    };
    __asmjs_setImmediate(tick);
    return handle;
}

export function clearInterval(handle) {
    if (handle && typeof handle === "object") handle._cancelled = true;
}

export function setImmediate(callback, ...args) {
    return __asmjs_setImmediate(callback);
}

export function clearImmediate(handle) {
    __asmjs_clearTimer(handle);
}

export default { setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, clearImmediate };
