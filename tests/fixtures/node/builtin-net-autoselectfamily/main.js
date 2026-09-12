import net from "node:net";

console.log(net.getDefaultAutoSelectFamily());
console.log(net.setDefaultAutoSelectFamily(true));
console.log(net.getDefaultAutoSelectFamily());
console.log(net.setDefaultAutoSelectFamily(false));
console.log(net.getDefaultAutoSelectFamily());

console.log(net.getDefaultAutoSelectFamilyAttemptTimeout());
console.log(net.setDefaultAutoSelectFamilyAttemptTimeout(500));
console.log(net.getDefaultAutoSelectFamilyAttemptTimeout());
console.log(net.setDefaultAutoSelectFamilyAttemptTimeout(1));
console.log(net.getDefaultAutoSelectFamilyAttemptTimeout());
