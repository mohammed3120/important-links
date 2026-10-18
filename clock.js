// Indirection so tests can control time.
export let now = () => Date.now();
export function setClock(fn) { now = fn ?? (() => Date.now()); }
