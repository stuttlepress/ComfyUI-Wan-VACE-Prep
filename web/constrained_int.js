import { app } from "../../scripts/app.js";

// Int (Constrained): min / max / step are advanced widgets. Under Nodes 2.0
// they are hidden on the node and edited in the properties panel. On the
// legacy canvas they are hidden outright and mirrored into node.properties,
// where the legacy Properties Panel edits them. The widgets stay the source
// of truth: they are what gets serialized and sent to the backend, which
// enforces the same snap at execution.

const NODE_CLASS = "ConstrainedInt";
// A min or max at +-MAX_SAFE_INTEGER means "not set" (see SAFE_INT in
// constrained_int.py). Unset bounds clamp at the safe range, since a JS
// double can't hold the backend's +-sys.maxsize exactly.
const SAFE = Number.MAX_SAFE_INTEGER;
const CONSTRAINTS = [
    { widget: "min_value", prop: "min", unset: -SAFE },
    { widget: "max_value", prop: "max", unset: SAFE },
    { widget: "step", prop: "step", unset: 1 },
];

// Mirrors snap_int in constrained_int.py - keep the two in step. Returns
// undefined when the constraints admit no value (backend raises in that case).
function gridBounds(lo, hi, step) {
    const loSet = lo > -SAFE;
    lo = loSet ? lo : -SAFE;
    hi = hi < SAFE ? hi : SAFE;
    if (lo > hi) return undefined;
    const base = loSet ? lo : 0;
    const loGrid = base - Math.floor((base - lo) / step) * step;  // smallest grid point >= lo
    const hiGrid = base + Math.floor((hi - base) / step) * step;  // largest grid point <= hi
    if (loGrid > hiGrid) return undefined;
    return { base, loGrid, hiGrid };
}

function snapInt(value, lo, hi, step) {
    step = Math.max(1, step);
    const g = gridBounds(lo, hi, step);
    if (!g) return undefined;
    let q = Math.floor((value - g.base) / step);
    const r = value - g.base - q * step;
    if (2 * r >= step) q += 1;
    return Math.min(Math.max(g.base + q * step, g.loGrid), g.hiGrid);
}

// Widget value -> text shown in the legacy Properties Panel ("" = not set).
function toProp(c, v) {
    return c.prop !== "step" && v === c.unset ? "" : String(v);
}

// Properties Panel text -> widget value, or undefined if it isn't valid.
function fromProp(c, text) {
    const s = String(text ?? "").trim();
    if (s === "") return c.unset;
    const v = Number(s);
    if (!Number.isSafeInteger(v)) return undefined;
    if (c.prop === "step" && v < 1) return undefined;
    return v;
}

const isLegacyCanvas = () => !window.LiteGraph?.vueNodesMode;

function setupConstrainedInt(node) {
    const find = (name) => node.widgets?.find((w) => w.name === name);
    const valueW = find("value");
    const widgets = Object.fromEntries(CONSTRAINTS.map((c) => [c.prop, find(c.widget)]));
    if (!valueW || !widgets.min || !widgets.max || !widgets.step) return;

    const constraints = () => ({
        lo: Number(widgets.min.value),
        hi: Number(widgets.max.value),
        step: Math.max(1, Number(widgets.step.value) || 1),
    });

    // Same technique as core PrimitiveInt (onCustomIntCreated), but backed by
    // widgets instead of node.properties, which have no editor under Nodes 2.0.
    // Bounds are the outermost grid points so arrows and drag stay on the grid.
    const bound = (key) => () => {
        const { lo, hi, step } = constraints();
        const g = gridBounds(lo, hi, step);
        if (key === "min") return g ? g.loGrid : lo;
        return g ? g.hiGrid : hi;
    };
    Object.defineProperty(valueW.options, "min", { get: bound("min"), configurable: true, enumerable: true });
    Object.defineProperty(valueW.options, "max", { get: bound("max"), configurable: true, enumerable: true });
    Object.defineProperty(valueW.options, "step2", {
        get: () => constraints().step,
        configurable: true,
        enumerable: true,
    });

    // Hide on the legacy canvas only; under Nodes 2.0 the advanced flag does
    // the hiding. widget.options is a Proxy that answers hidden from the
    // widget's visibility state, so this getter is not read live: the
    // frontend evaluates it once here and again on each Nodes 2.0 <-> legacy
    // switch (syncLiveVisibilityOptions), which is all this needs.
    for (const c of CONSTRAINTS) {
        Object.defineProperty(widgets[c.prop].options, "hidden", {
            get: isLegacyCanvas,
            set: () => {},
            configurable: true,
            enumerable: true,
        });
    }

    // Declared as strings so the legacy panel shows "8", not "8.000", and an
    // empty field can mean "not set".
    for (const c of CONSTRAINTS) {
        if (!node.properties_info?.some((p) => p.name === c.prop)) {
            node.addProperty(c.prop, toProp(c, widgets[c.prop].value), "string");
        }
    }
    const syncProps = () => {
        for (const c of CONSTRAINTS) node.properties[c.prop] = toProp(c, widgets[c.prop].value);
    };
    syncProps();

    const snapValue = () => {
        const { lo, hi, step } = constraints();
        const snapped = snapInt(Number(valueW.value), lo, hi, step);
        if (snapped !== undefined && snapped !== valueW.value) valueW.value = snapped;
        return valueW.value;
    };

    const valueCallback = valueW.callback;
    valueW.callback = function (v, ...rest) {
        if (typeof v === "number") valueW.value = v;
        const snapped = snapValue();
        return valueCallback?.call(this, snapped, ...rest);
    };

    // Nodes 2.0 edits arrive through the widgets.
    for (const c of CONSTRAINTS) {
        const w = widgets[c.prop];
        const cb = w.callback;
        w.callback = function (...args) {
            const r = cb?.apply(this, args);
            syncProps();
            snapValue();
            node.setDirtyCanvas?.(true, true);
            return r;
        };
    }

    // Legacy Properties Panel edits arrive through setProperty.
    const onPropertyChanged = node.onPropertyChanged;
    node.onPropertyChanged = function (name, value, prev) {
        const c = CONSTRAINTS.find((c) => c.prop === name);
        if (!c) return onPropertyChanged?.apply(this, arguments);
        const v = fromProp(c, value);
        if (v === undefined) {
            refreshLegacyPanel(node);
            return false;
        }
        widgets[c.prop].value = v;
        this.properties[name] = toProp(c, v);
        snapValue();
        if (this.properties[name] !== value) refreshLegacyPanel(node);
        this.setDirtyCanvas?.(true, true);
    };

    // The default size was computed before the widgets were hidden. A loaded
    // workflow overrides this with its saved size.
    if (isLegacyCanvas()) node.setSize(node.computeSize());

    // Loading a workflow restores widgets_values after creation; widgets win.
    // Re-snap too, so a saved off-grid value shows what the backend outputs.
    const onConfigure = node.onConfigure;
    node.onConfigure = function () {
        const r = onConfigure?.apply(this, arguments);
        syncProps();
        snapValue();
        return r;
    };
}

// Re-open the legacy panel so it shows the normalized (or reverted) text.
function refreshLegacyPanel(node) {
    const canvas = app.canvas;
    if (canvas?.node_panel?.node !== node) return;
    setTimeout(() => canvas.showShowNodePanel(node), 0);
}

app.registerExtension({
    name: "WanVACEPrep.ConstrainedInt",
    beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_CLASS) return;
        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = onNodeCreated?.apply(this, arguments);
            setupConstrainedInt(this);
            return r;
        };
    },
});
