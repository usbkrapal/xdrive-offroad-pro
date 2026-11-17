'use strict';
/**
 * signals.js - read live vehicle signals over SOME/IP.
 *
 * Interface configs come from the app's own oap_<uid>/someipInterfaces/,
 * which the installer generates from the app's manifest.json with BMW's own
 * generator (kit/tools/oapgen) against the unit's master catalog
 * /etc/oap/someip/someip-interfaces.json - exactly what MainApp does when it
 * installs an app. So any interface/field listed in app.json "signals" is
 * reachable, not just the trimmed MainApp subset.
 *
 *   const sub = await signals.watch('de.bmw.infotainment.vehicle.CDS', '1', {
 *       statusEngineSpeed2: (v) => rpm = v.actualValueRPMEngineCrankshaft,
 *   });
 *   sub.available  // true once the provider (the car) answers
 */
const fs = require('fs');
const path = require('path');

let someip = null;
try { someip = require('someip'); } catch (e) { /* host preview / not installed */ }

const APP_ROOT = path.resolve(__dirname, '..', '..', '..');
const DIRS = [path.join(APP_ROOT, 'someipInterfaces'), path.join(__dirname, '..', '..', 'someipdefs')];

// The native binding deadlocks (main thread stuck on a futex) when buildProxy/
// init run inline inside the app's promise chains next to the SDK's own SOME/IP
// traffic. The SDK always calls them from a fresh setImmediate tick, one at a
// time - do the same.
// Two queues, still one call at a time: method calls and the set-up of a proxy for them (proxy, on, onAvailable:
// the diagnostic link) go before the watch() set-ups waiting. An app that watches ten interfaces queues ~40 of
// those at start, and every UDS request used to wait behind all of them. After URGENT_RUN urgent calls in a row a
// set-up waiting goes next: an app with several UDS readers going at once (Live Data's engine page, Redline's
// knock, gearbox and 12 V) can keep the urgent lane busy without a break, and its signals (rpm, gear) would start
// late or never.
const lanes = [[], []];         // [urgent, set-up]
const URGENT_RUN = 4;
let running = false, urgentRun = 0;
function pump() {
    if (running) return;
    const setup = lanes[1].length > 0 && (!lanes[0].length || urgentRun >= URGENT_RUN);
    const job = setup ? lanes[1].shift() : lanes[0].shift();
    if (!job) return;
    urgentRun = setup ? 0 : urgentRun + 1;
    running = true;
    setImmediate(() => {
        let p;
        try { p = Promise.resolve(job.fn()); } catch (e) { p = Promise.reject(e); }
        p.then(job.resolve, job.reject).then(() => { running = false; pump(); });
    });
}
function nativeTick(fn, urgent) {
    return new Promise((resolve, reject) => { lanes[urgent ? 0 : 1].push({ fn, resolve, reject }); pump(); });
}

function loadConfig(iface) {
    const f = iface.replace(/\./g, '_') + '.json';
    for (const d of DIRS) {
        try { return JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')); } catch (e) { /* next */ }
    }
    throw new Error('no SOME/IP config for ' + iface + ' (add it to app.json "signals")');
}

const GET_TIMEOUT_MS = 3000;

/**
 * Build a proxy and subscribe to fields. handlers = { fieldName: fn(value) }.
 * Also does an initial getValue() for fields that have a getter, so values
 * show up without waiting for the next change.
 * opts.pollMs: also re-read those fields that often while the provider is available - for
 * fields a car may not notify (BMW's x_call only ever reads TPMS, it never subscribes).
 * opts.fieldPollMs: { fieldName: ms } - a field's own re-read period (instead of pollMs).
 * opts.onAvailability: fn(bool) on every change of the provider's availability.
 *
 * Lifecycle (xdrive_offroad_pro patch): shutdown() stops the poll timer and every callback
 * (no handler runs after it, late getValue answers are dropped). A field has at most one
 * getValue() out at a time: the binding's own timeout (GET_TIMEOUT_MS) is what settles it, and
 * while it hasn't, the field's polls are skipped (counted), never stacked. Each loss of the
 * provider starts a new epoch: an answer to a read started before it is dropped, as is a field
 * notification while the provider is known to be away. Each field's read and handler fail on
 * their own. res.losses counts provider losses, so a caller that only looks at res.available now
 * and then still sees a drop it missed. res.reads[field] (getter fields only): counts and times
 * of the reads, the last error's text (short, no values) and pendingSince - no payloads.
 */
async function watch(iface, instance, handlers, log, opts) {
    const res = { iface, available: false, losses: 0, reads: {}, proxy: null, error: null, shutdown: () => Promise.resolve() };
    if (!someip) { res.error = 'someip native module not available'; return res; }
    // epoch: bumped on every loss of the provider; availKnown: the binding has said yes or no at least once
    let stopped = false, timer = null, p = null, epoch = 0, availKnown = false;
    res.shutdown = () => {
        stopped = true;
        if (timer !== null) { clearInterval(timer); timer = null; }
        return Promise.resolve().then(() => p && p.shutdown && p.shutdown()).catch(() => {});
    };
    const deliver = (f, v) => {
        if (stopped) return;
        try { handlers[f](v); } catch (e) { if (log) log.warn(iface + '.' + f + ': ' + e); }
    };
    // a notification while the provider is known to be away is not a sample (it would outlive the loss)
    const notify = (f, v) => { if (!availKnown || res.available) deliver(f, v); };
    const setAvailable = (a) => {
        if (stopped) return;
        availKnown = true;
        if (res.available && !a) { res.losses++; epoch++; }
        const changed = res.available !== a;
        res.available = a;
        if (changed && opts && typeof opts.onAvailability === 'function') {
            try { opts.onAvailability(a); } catch (e) { if (log) log.warn(iface + ' availability: ' + e); }
        }
    };
    try {
        const cfg = loadConfig(iface);
        const px = await nativeTick(() => someip.buildProxy(cfg, String(instance)).then((x) => x.init().then(() => x)));
        p = px;
        res.proxy = px;
        if (stopped) { res.shutdown(); return res; }
        const fields = Object.keys(handlers || {});
        const getters = fields.filter((f) => cfg.fields && cfg.fields[f] && cfg.fields[f].getter);
        const own = (opts && opts.fieldPollMs) || {};
        const periodOf = (f) => (own[f] > 0 ? own[f] : opts && opts.pollMs > 0 ? opts.pollMs : 0);
        // one getValue() per field at a time; its stats in res.reads[f] (no values, a short error text)
        const errText = (e) => String((e && e.message) || e).split('\n')[0].replace(/[^\x20-\x7e]/g, '?').slice(0, 80);
        getters.forEach((f) => {
            res.reads[f] = { ok: 0, failed: 0, consecutiveFailures: 0, dropped: 0, skipped: 0, lastOkAt: null, lastFailAt: null, lastError: null, pendingSince: null };
        });
        const last = {};
        const read = (f, t) => {
            const st = res.reads[f];
            if (stopped || !st) return;
            if (st.pendingSince !== null) { st.skipped++; return; }
            const ep = epoch;
            st.pendingSince = t;
            last[f] = t;
            let q;
            try { q = Promise.resolve(px.getValue(f, GET_TIMEOUT_MS)); } catch (e) { q = Promise.reject(e); }
            q.then((v) => {
                if (stopped) return;
                // started before a loss of the provider, or answered while it is away: not a sample
                if (ep !== epoch || !res.available) { st.dropped++; return; }
                st.ok++; st.consecutiveFailures = 0; st.lastOkAt = Date.now();
                deliver(f, v);
            }, (e) => {
                if (stopped) return;
                st.failed++; st.consecutiveFailures++; st.lastFailAt = Date.now(); st.lastError = errText(e);
            }).then(() => { st.pendingSince = null; });
        };
        const fetchAll = () => { if (!stopped && res.available) getters.forEach((f) => read(f, Date.now())); };
        await nativeTick(() => {
            try { return px.subscribeToAvailability((a) => { setAvailable(!!a); if (a) setImmediate(fetchAll); }); } catch (e) { return null; /* older binding */ }
        });
        for (const f of fields) {
            if (stopped) break;
            try {
                await nativeTick(() => px.subscribe({ name: f, onReceive: (v) => notify(f, v) }));
            } catch (e) {
                if (log) log.warn('subscribe ' + iface + '.' + f + ': ' + e);
            }
        }
        if (stopped) return res;
        if (px.isAvailable && px.isAvailable()) { setAvailable(true); fetchAll(); }
        const polled = getters.filter((f) => periodOf(f) > 0);
        if (polled.length) {
            const tick = Math.min.apply(null, polled.map(periodOf));
            timer = setInterval(() => {
                if (stopped || !res.available) return;
                const now = Date.now();
                // a little slack so a field due on this tick isn't pushed to the next one by timer jitter
                polled.forEach((f) => { if (last[f] === undefined || now - last[f] >= periodOf(f) - tick / 2) read(f, now); });
            }, tick);
        }
    } catch (e) {
        res.error = String(e);
        if (log) log.warn('signals ' + iface + ': ' + e);
    }
    return res;
}

/** Call a method on an interface instance (e.g. UDS over InternalTasu). */
async function proxy(iface, instance) {
    if (!someip) throw new Error('someip native module not available');
    const cfg = loadConfig(iface);
    return nativeTick(() => someip.buildProxy(cfg, String(instance)).then((p) => p.init().then(() => p)), true);
}

/** Call a method on a proxy from proxy(); params = the method's argument struct. */
function call(p, method, params, timeoutMs) {
    return nativeTick(() => p.callMethod(method, params || {}, timeoutMs || 5000), true);
}

/**
 * Write a field that has a setter (e.g. ConditionBasedServicesLegacy.cBSReset) on a proxy from
 * proxy() or watch().proxy, as BMW's SDK does (_someIpProxy.setValue). value = the field's struct;
 * resolves when the provider took it. Needs "w" in the field's app.json flags, or the installer
 * leaves the setter out of the app's interface config.
 */
function set(p, field, value, timeoutMs) {
    return nativeTick(() => p.setValue(field, value, timeoutMs || 5000));
}

/** Subscribe to a broadcast/event or field on a proxy from proxy(). */
function on(p, name, fn, log) {
    return nativeTick(() => p.subscribe({ name, onReceive: (v) => { try { fn(v); } catch (e) { if (log) log.warn(name + ': ' + e); } } }), true);
}

/** Availability of a proxy's provider; fn(bool) on every change. */
function onAvailable(p, fn) {
    return nativeTick(() => { try { return p.subscribeToAvailability((a) => fn(!!a)); } catch (e) { return null; } }, true)
        .then(() => { if (p.isAvailable && p.isAvailable()) fn(true); });
}

module.exports = { watch, proxy, call, set, on, onAvailable, loadConfig, hasNative: () => !!someip };
