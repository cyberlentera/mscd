// Template binding helpers matching the prototype's rendering rules.
export const txt = (x) => (x === null || x === undefined || typeof x === 'boolean' ? null : typeof x === 'object' ? x : String(x));
export const list = (x) => (Array.isArray(x) ? x : []);
