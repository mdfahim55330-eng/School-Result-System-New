"use strict";

const NodeCache = require("node-cache");
const config = require("./config");

const store = new NodeCache({
    stdTTL: config.cacheSeconds,
    checkperiod: 120,
    useClones: true
});

/** Return the cached value or compute + store it. */
async function remember(key, compute) {
    if (config.cacheSeconds <= 0) return compute();
    const hit = store.get(key);
    if (hit !== undefined) return hit;
    const value = await compute();
    store.set(key, value);
    return value;
}

/** Called after every successful data change, so nobody ever sees stale results. */
function clear() {
    store.flushAll();
}

module.exports = { remember, clear };
