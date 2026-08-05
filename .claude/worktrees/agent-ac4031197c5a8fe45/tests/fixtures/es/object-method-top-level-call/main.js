function forward(value) {
    console.log("forward", typeof value);
}

const obj = {
    run(cb) {
        console.log("method");
        forward(cb);
        console.log("done");
    }
};

obj.run(() => {});
