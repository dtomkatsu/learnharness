/**
 * crypto.randomUUID exists only in a secure context (https, localhost). The
 * app is also opened over plain http on a tailnet name or a LAN address
 * (http://madisons-mac-mini:3010), where it is undefined, and every browser
 * call to it throws: a send sat on Thinking… for good, with nothing reaching
 * the server (2026-11-10). Some of those calls are ours, many are upstream's
 * (inline side questions, the flashcards review, the coding-questions
 * plugin), so one shim before hydration covers them all rather than a patch
 * per call site.
 *
 * Inline source, ES5 on purpose: it runs before any bundle, on the oldest
 * browser the tablet or the phone brings. A page that already has
 * randomUUID, or has no getRandomValues to build one from, is left alone.
 */
export const RANDOM_UUID_SHIM = `(function(){
var c=typeof window!=="undefined"?window.crypto:undefined;
if(!c||typeof c.randomUUID==="function"||typeof c.getRandomValues!=="function")return;
try{c.randomUUID=function randomUUID(){
var b=c.getRandomValues(new Uint8Array(16)),h="",i;
b[6]=(b[6]&15)|64;b[8]=(b[8]&63)|128;
for(i=0;i<16;i++)h+=(b[i]+256).toString(16).slice(1);
return h.slice(0,8)+"-"+h.slice(8,12)+"-"+h.slice(12,16)+"-"+h.slice(16,20)+"-"+h.slice(20);
};}catch(e){}
})();`;
