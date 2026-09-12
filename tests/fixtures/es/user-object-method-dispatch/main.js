function make() {
    return {
        join: function () { return "user-join"; },
        pop: function () { return "user-pop"; }
    };
}
const o = make();
console.log(o.join());
console.log(o["pop"]());
