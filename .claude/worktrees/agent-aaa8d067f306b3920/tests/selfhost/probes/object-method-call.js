const obj = {
    value: "method-ok",
    get() {
        return this.value;
    },
};

console.log(obj.get());
