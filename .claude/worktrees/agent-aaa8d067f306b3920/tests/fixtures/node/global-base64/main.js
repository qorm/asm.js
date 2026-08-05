console.log(btoa("Hello, World!"));
console.log(atob("SGVsbG8sIFdvcmxkIQ=="));
console.log(btoa("foo"), btoa("fo"), btoa("f"));
console.log(atob("Zm9v"), atob("Zm8="), atob("Zg=="));
console.log(atob(btoa("round-trip 123!")));
