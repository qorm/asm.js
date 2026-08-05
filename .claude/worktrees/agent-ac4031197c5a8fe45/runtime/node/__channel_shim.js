// [方言] Channel(capacity=0):js f(x) 协程派发配套的 CSP 通道(Go channel 之 asm.js 版)。
// 骑在 Promise/协程挂起-唤醒原语上:
//   ch.send(v)        —— 返回 Promise。缓冲满(或 cap=0 无接收者等待)时挂起发送方;
//                        cap=0 为会合语义:与 recv 一一配对。向已关闭通道 send 抛错。
//   await ch.recv()   —— 返回 Promise<{value, done}>。空时挂起接收方;
//                        {value:v, done:false} = 收到数据;
//                        {value:undefined, done:true} = 通道已关闭且排空(迭代器同形,可解构)。
//   ch.close()        —— 置关闭;唤醒所有等待中的接收者(得 done:true)。幂等。
// 单线程事件循环上运行 → 唤醒顺序 = 入队顺序,完全确定。
export function Channel(capacity) {
    return {
        __cap: capacity === undefined ? 0 : capacity,
        __buf: [],
        __closed: false,
        __sendQ: [], // 等待中的发送者 [{v, resolve}]
        __recvQ: [], // 等待中的接收者 [resolve]
        send(v) {
            if (this.__closed) {
                throw new Error("send on closed channel");
            }
            if (this.__recvQ.length > 0) {
                // 有接收者等待:直接移交(会合/插队皆先服务等待者,保序)
                const r = this.__recvQ.shift();
                r({ value: v, done: false });
                return Promise.resolve(true);
            }
            if (this.__buf.length < this.__cap) {
                this.__buf.push(v);
                return Promise.resolve(true);
            }
            // 缓冲满(或 cap=0 无接收者):挂起发送方
            const q = this.__sendQ;
            return new Promise(function (resolve) {
                q.push({ v: v, resolve: resolve });
            });
        },
        recv() {
            if (this.__buf.length > 0) {
                const v = this.__buf.shift();
                // 腾出一格:唤醒最早的等待发送者,其值入缓冲(保序)
                if (this.__sendQ.length > 0) {
                    const s = this.__sendQ.shift();
                    this.__buf.push(s.v);
                    s.resolve(true);
                }
                return Promise.resolve({ value: v, done: false });
            }
            if (this.__sendQ.length > 0) {
                // cap=0 会合(或缓冲空但有排队发送者):直接移交
                const s = this.__sendQ.shift();
                s.resolve(true);
                return Promise.resolve({ value: s.v, done: false });
            }
            if (this.__closed) {
                return Promise.resolve({ value: undefined, done: true });
            }
            const q = this.__recvQ;
            return new Promise(function (resolve) {
                q.push(resolve);
            });
        },
        close() {
            if (this.__closed) return;
            this.__closed = true;
            while (this.__recvQ.length > 0) {
                const r = this.__recvQ.shift();
                r({ value: undefined, done: true });
            }
        },
    };
}
