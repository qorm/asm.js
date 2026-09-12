// (a|ab)*c must still backtrack into the quantified alternation.
var m = /(a|ab)*c/.exec("abc");
if (!m || m[0] !== "abc" || m[1] !== "ab") throw new Error("altstar");

// Quantified capturing group of a sequence (not a simple char/cls atom).
if (!(/(ab)+/.test("ababab"))) throw new Error("grpRep");

// REX MarkupSPE (S15.10.2_A1_T1 index 23): nested groups + * on groups.
// Pre-trampoline: compile ok, .test SIGSEGV (8 MiB stack / 32 KiB frames).
var NameStrt = "[A-Za-z_:]|[^\\x00-\\x7F]";
var NameChar = "[A-Za-z0-9_:.-]|[^\\x00-\\x7F]";
var Name = "(" + NameStrt + ")(" + NameChar + ")*";
var S = "[ \\n\\t\\r]+";
var AttValSE = '"[^<"]' + "*" + '"' + "|'[^<']*'";
var ElemTagCE = Name + "(" + S + Name + "(" + S + ")?=(" + S + ")?(" + AttValSE + "))*(" + S + ")?/?>?";
var UntilHyphen = "[^-]*-";
var Until2Hyphens = UntilHyphen + "([^-]" + UntilHyphen + ")*-";
var CommentCE = Until2Hyphens + ">?";
var UntilRSBs = "[^\\]]*\\]([^\\]]+\\])*\\]+";
var CDATA_CE = UntilRSBs + "([^\\]>]" + UntilRSBs + ")*>";
var QuoteSE = '"[^"]' + "*" + '"' + "|'[^']*'";
var DT_IdentSE = S + Name + "(" + S + "(" + Name + "|" + QuoteSE + "))*";
var MarkupDeclCE = "([^\\]\"'><]+|" + QuoteSE + ")*>";
var S1 = "[\\n\\r\\t ]";
var UntilQMs = "[^?]*\\?+";
var PI_Tail = "\\?>|" + S1 + UntilQMs + "([^>?]" + UntilQMs + ")*>";
var DT_ItemSE = "<(!(--" + Until2Hyphens + ">|[^-]" + MarkupDeclCE + ")|\\?" + Name + "(" + PI_Tail + "))|%" + Name + ";|" + S;
var DocTypeCE = DT_IdentSE + "(" + S + ")?(\\[(" + DT_ItemSE + ")*\\](" + S + ")?)?>?";
var DeclCE = "--(" + CommentCE + ")?|\\[CDATA\\[(" + CDATA_CE + ")?|DOCTYPE(" + DocTypeCE + ")?";
var PI_CE = Name + "(" + PI_Tail + ")?";
var EndTagCE = Name + "(" + S + ")?>?";
var MarkupSPE = "<(!(" + DeclCE + ")?|\\?(" + PI_CE + ")?|/(" + EndTagCE + ")?|(" + ElemTagCE + ")?)";
var html = '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>t</title></head><body><p x="y">z</p></body></html>';
if (!new RegExp(MarkupSPE).test(html)) throw new Error("markup");
console.log("ok");
