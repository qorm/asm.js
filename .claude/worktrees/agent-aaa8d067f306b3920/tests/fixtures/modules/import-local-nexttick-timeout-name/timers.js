export function setTimeout(callback, delay, ...args) {
    __asmjsNextTick(callback);
}
