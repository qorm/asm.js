// asm.js Runtime - Node.js timers/promises
// 注:asm.js 无真实定时;这里以已解决 Promise 交付值(微任务时序,非真延时)。
// await setTimeout(ms, v) 立即在微任务点解决为 v,足够覆盖顺序/值语义。

export function setTimeout(delay, value, options) {
    return new Promise((resolve) => { resolve(value); });
}

export function setImmediate(value, options) {
    return new Promise((resolve) => { resolve(value); });
}

export function setInterval(delay, value, options) {
    // async 迭代器:每次 next() 交付 value(无限);占位以保 import/for-await 不崩。
    return {
        [Symbol.asyncIterator]() {
            return { next() { return Promise.resolve({ value: value, done: false }); } };
        }
    };
}

const timersPromises = { setTimeout, setImmediate, setInterval };
export { timersPromises };
export default timersPromises;
