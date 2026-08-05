const obj = {
    value: "method-ok",
    get() {
        return this.value;
    },
};

const out = obj.get();
console.log(out);
