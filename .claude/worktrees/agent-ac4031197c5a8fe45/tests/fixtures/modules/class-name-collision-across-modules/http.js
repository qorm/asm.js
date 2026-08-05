export class Server {
  constructor(cond) { if (cond) { this.a = 1; } this.blah(); this.finish("HTTP"); }
  blah() { this.b = 9; }
  finish(x) { this.kind = x; }
  who() { return this.kind; }
}
export function makeHttp() { return new Server(true); }
