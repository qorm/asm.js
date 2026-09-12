var valueOf = BigInt.prototype.valueOf;
var threw = false;
try { valueOf.call(undefined); } catch (e) { threw = true; }
if (!threw) throw new Error("undefined");
threw = false;
try { valueOf.call(0); } catch (e) { threw = true; }
if (!threw) throw new Error("zero");
threw = false;
try { valueOf.call(null); } catch (e) { threw = true; }
if (!threw) throw new Error("null");
console.log("ok");
