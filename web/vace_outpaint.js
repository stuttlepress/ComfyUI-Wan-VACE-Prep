import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// ── Constants ─────────────────────────────────────────────────────────

const NODE_CLASS  = "VACEOutpaint";
const API_PREFIX  = "/vace_outpaint";
const CANVAS_H    = 320;   // minimum canvas area height (px)
const MARGIN      = 22;    // canvas margin around source frame (px)
const GRID        = 16;    // quantisation grid (source px)
const OVERHANG    = 1;     // minimum required outpaint (source px)

// ── Geometry helpers ──────────────────────────────────────────────────

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// cr = crop rect in canvas px; sf = source frame rect in canvas px; scale = canvas px / source px
function crToSrc(cr, sf, scale) {
    return {
        x: (cr.x - sf.x) / scale,
        y: (cr.y - sf.y) / scale,
        w: cr.w / scale,
        h: cr.h / scale,
    };
}

function srcToCr(s, sf, scale) {
    return {
        x: sf.x + s.x * scale,
        y: sf.y + s.y * scale,
        w: s.w * scale,
        h: s.h * scale,
    };
}

function quantizeSrc(s) {
    return {
        x: Math.round(s.x / GRID) * GRID,
        y: Math.round(s.y / GRID) * GRID,
        w: Math.max(GRID, Math.round(s.w / GRID) * GRID),
        h: Math.max(GRID, Math.round(s.h / GRID) * GRID),
    };
}

/** Adjust outW/outH AR to match cropAR (no-op when outW/outH are unset).
 *  preserveArea=true keeps pixel count constant (used by preset chips).
 *  preserveArea=false keeps outW fixed, adjusts only outH (used by drag-resize). */
function syncOutToAR(st, preserveArea = false) {
    if (st.outW >= GRID && st.outH >= GRID) {
        if (preserveArea) {
            const area = st.outW * st.outH;
            st.outW = Math.max(GRID, Math.round(Math.sqrt(area * st.cropAR) / GRID) * GRID);
        }
        st.outH = Math.max(GRID, Math.round(st.outW / st.cropAR / GRID) * GRID);
    }
}

/** Default output resolution for a new node: fixed 1280×720. */
function defaultOut(_st) {
    return { w: 1280, h: 720 };
}

/** Enforce overlap constraint: crop must intersect source by at least OVERHANG px. */
function clampToValid(s, srcW, srcH) {
    const c = { ...s };
    if (c.x >= srcW - OVERHANG) c.x = srcW - OVERHANG;
    if (c.y >= srcH - OVERHANG) c.y = srcH - OVERHANG;
    if (c.x + c.w <= OVERHANG)  c.x = OVERHANG - c.w;
    if (c.y + c.h <= OVERHANG)  c.y = OVERHANG - c.h;
    return c;
}

/** Full pipeline: canvas px → source px → quantise → constrain → canvas px. */
function applyCanvasCr(canvasCr, st) {
    let s = crToSrc(canvasCr, st.sf, st.scale);
    s = quantizeSrc(s);
    s = clampToValid(s, st.srcW, st.srcH);
    st.cr = srcToCr(s, st.sf, st.scale);
}

// ── Per-node state ────────────────────────────────────────────────────

function createState() {
    return {
        srcW: 1280, srcH: 720,
        frameCount: 1,
        scale: 1,
        sf: { x: 0, y: 0, w: 0, h: 0 },
        cr: { x: 0, y: 0, w: 0, h: 0 },
        cropAR: 16 / 9,
        arLocked: true,
        initialized: false,
        view: { zoom: 1.0, panX: 0, panY: 0 },
        outW: 0, outH: 0,
        maskColor: "wan",
        customColor: "128,128,128",
    };
}

/** Convert a screen-space pointer event to world (canvas) coordinates. */
function toWorld(e, wrapEl, view) {
    const rect = wrapEl.getBoundingClientRect();
    return {
        x: (e.clientX - rect.left  - view.panX) / view.zoom,
        y: (e.clientY - rect.top   - view.panY) / view.zoom,
    };
}

/** Compute source-frame rect, scale, and default crop window from current canvas size. */
function initLayout(st, wrapEl) {
    const W = wrapEl.clientWidth;
    if (W <= 0) return false;
    const maxW = W - MARGIN * 2;
    const maxH = wrapEl.clientHeight - MARGIN * 2;
    const ar   = st.srcW / st.srcH;
    // Fit source frame inside (maxW × maxH) while preserving aspect ratio.
    let sfW, sfH;
    if (maxW / ar <= maxH) {
        sfW = maxW;
        sfH = Math.round(maxW / ar);
    } else {
        sfH = maxH;
        sfW = Math.round(maxH * ar);
    }
    const sfX = Math.round((W - sfW) / 2);
    const sfY = Math.max(MARGIN, Math.round((wrapEl.clientHeight - sfH) / 2));
    st.sf = { x: sfX, y: sfY, w: sfW, h: sfH };
    st.scale = sfW / st.srcW;
    st.view = { zoom: 1.0, panX: 0, panY: 0 };
    // Default: 1280×720 centered on the source frame.
    const defW = 1280, defH = 720;
    const defX = Math.round((st.srcW - defW) / (2 * GRID)) * GRID;
    const defY = Math.round((st.srcH - defH) / (2 * GRID)) * GRID;
    const def = clampToValid({ x: defX, y: defY, w: defW, h: defH }, st.srcW, st.srcH);
    st.cr = srcToCr(def, st.sf, st.scale);
    st.cropAR = st.cr.w / st.cr.h;
    st.initialized = true;
    return true;
}

/** Restore crop rect from the saved crop_state widget value (workflow load).
 *  @param {string} [overrideVal] - use this value instead of reading the widget
 *    (pass the value latched at onConfigure time to avoid rAF/configure races). */
function restoreCropFromWidgets(st, widgets, overrideVal) {
    const val = overrideVal !== undefined ? overrideVal : (widgets.cropState?.value ?? "");
    if (!val) return;
    const parts = val.split(",").map(Number);
    if (parts.length < 4 || parts.some(isNaN)) return;
    const [cx, cy, cw, ch] = parts;
    if (cw >= GRID && ch >= GRID) {
        st.cr = srcToCr({ x: cx, y: cy, w: cw, h: ch }, st.sf, st.scale);
        st.cropAR = cw / ch;
    }
    if (parts.length >= 6) {
        st.outW = parts[4] || 0;
        st.outH = parts[5] || 0;
    }
    if (parts.length >= 7 && !isNaN(parts[6])) {
        st.arLocked = parts[6] !== 0;
    }
}

// ── DOM builder ───────────────────────────────────────────────────────

function mkEl(tag, css, extra) {
    const el = document.createElement(tag);
    if (css) el.style.cssText = css;
    if (extra) Object.assign(el, extra);
    return el;
}

function mkBtn(label, css) {
    const b = mkEl("button", `padding:2px 7px;font-size:10px;border:1px solid #444;border-radius:4px;background:#2a2a2a;color:#bbb;cursor:pointer;${css || ""}`);
    b.textContent = label;
    b.onmouseenter = () => { b.style.background = "#3a3a3a"; };
    b.onmouseleave = () => { b.style.background = b._active ? "#1a3a5a" : "#2a2a2a"; };
    return b;
}

function buildUI() {
    // ── Root container ──
    const root = mkEl("div", "width:100%;box-sizing:border-box;padding:6px 8px 10px;font-family:system-ui,sans-serif;font-size:12px;color:#ccc;");

    // ── Canvas area ──
    const wrap = mkEl("div", `position:relative;min-height:${CANVAS_H}px;background:#181818;border:1px solid #3a3a3a;border-radius:6px;overflow:hidden;user-select:none;touch-action:none;cursor:default;`);

    // Source frame (holds actual frame image)
    const sfEl = mkEl("div", "position:absolute;background:#222;overflow:hidden;border:1px solid #333;");

    const frameImg = mkEl("img", "position:absolute;inset:0;width:100%;height:100%;object-fit:fill;display:none;");
    frameImg.alt = "";

    const srcLabel = mkEl("div", "position:absolute;bottom:5px;right:7px;font-size:9px;color:rgba(255,255,255,0.3);font-family:monospace;pointer-events:none;");
    srcLabel.textContent = "source";

    const noDataMsg = mkEl("div", "position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:11px;color:rgba(255,255,255,0.2);pointer-events:none;text-align:center;padding:8px;");
    noDataMsg.textContent = "Run node once to display frames";

    sfEl.append(frameImg, srcLabel, noDataMsg);

    // Mask overlay divs (outside source frame, inside crop box)
    const mkMask = () => mkEl("div", "position:absolute;background:rgba(210,70,70,0.28);pointer-events:none;display:none;");
    const [maskTop, maskBot, maskLeft, maskRight] = [mkMask(), mkMask(), mkMask(), mkMask()];

    // Crop/output box
    const cropBox = mkEl("div", "position:absolute;cursor:move;border:2px solid rgba(80,150,255,0.9);background:rgba(50,120,200,0.08);");


    // Corner handles
    const HBASE = "position:absolute;width:11px;height:11px;background:#ddd;border:1.5px solid rgba(60,120,200,0.85);border-radius:2px;";
    const corners = {
        tl: mkEl("div", HBASE + "top:0;left:0;transform:translate(-50%,-50%);cursor:nw-resize;"),
        tr: mkEl("div", HBASE + "top:0;right:0;transform:translate(50%,-50%);cursor:ne-resize;"),
        bl: mkEl("div", HBASE + "bottom:0;left:0;transform:translate(-50%,50%);cursor:sw-resize;"),
        br: mkEl("div", HBASE + "bottom:0;right:0;transform:translate(50%,50%);cursor:se-resize;"),
    };
    for (const [dir, el] of Object.entries(corners)) {
        el.dataset.dir = dir;
        cropBox.appendChild(el);
    }

    // Canvas overlays (absolutely positioned inside viewport)
    const sizeLabel = mkEl("div",
        "position:absolute;font-family:monospace;font-size:11px;font-weight:600;" +
        "color:rgba(255,255,255,0.85);background:rgba(0,0,0,0.45);padding:1px 6px;" +
        "border-radius:3px;pointer-events:none;white-space:nowrap;transform:translateX(-50%);"
    );
    const PAD_CSS = "position:absolute;font-family:monospace;font-size:10px;" +
        "color:rgba(255,200,200,0.80);pointer-events:none;white-space:nowrap;";
    const padLabelT = mkEl("div", PAD_CSS);
    const padLabelB = mkEl("div", PAD_CSS);
    const padLabelL = mkEl("div", PAD_CSS);
    const padLabelR = mkEl("div", PAD_CSS);

    // Edge midpoint resize handles
    const EBASE = "position:absolute;background:#ddd;border:1.5px solid rgba(60,120,200,0.85);border-radius:2px;pointer-events:auto;";
    const edges = {
        t: mkEl("div", EBASE + "width:18px;height:7px;top:0;left:50%;transform:translate(-50%,-50%);cursor:n-resize;"),
        b: mkEl("div", EBASE + "width:18px;height:7px;bottom:0;left:50%;transform:translate(-50%,50%);cursor:s-resize;"),
        l: mkEl("div", EBASE + "width:7px;height:18px;left:0;top:50%;transform:translate(-50%,-50%);cursor:w-resize;"),
        r: mkEl("div", EBASE + "width:7px;height:18px;right:0;top:50%;transform:translate(50%,-50%);cursor:e-resize;"),
    };
    for (const [dir, el] of Object.entries(edges)) {
        el.dataset.dir = dir;
        cropBox.appendChild(el);
    }

    // Viewport: receives CSS transform for zoom/pan; contains all positioned elements.
    const viewport = mkEl("div", "position:absolute;inset:0;transform-origin:0 0;");
    viewport.append(sfEl, maskTop, maskBot, maskLeft, maskRight, cropBox, sizeLabel, padLabelT, padLabelB, padLabelL, padLabelR);
    wrap.appendChild(viewport);

    // Zoom indicator (bottom-left overlay, doubles as reset button).
    const zoomIndicator = mkEl("button",
        "position:absolute;bottom:6px;left:7px;padding:2px 6px;font-size:10px;font-family:monospace;" +
        "background:rgba(0,0,0,0.55);color:#888;border:1px solid #444;border-radius:3px;cursor:pointer;z-index:10;"
    );
    zoomIndicator.title = "Click to reset zoom (scroll to zoom, middle-drag to pan)";
    zoomIndicator.textContent = "100%";
    wrap.appendChild(zoomIndicator);

    // ── Controls ──
    const ctrl = mkEl("div", "display:flex;flex-direction:column;gap:5px;margin-top:7px;");

    // ── Crop Size Row ──
    const cropSizeRow = mkEl("div", "display:flex;align-items:center;gap:5px;flex-wrap:wrap;");
    const INPUT_CSS =
        "width:58px;padding:2px 5px;font-size:11px;font-family:monospace;" +
        "background:#1e1e1e;color:#ccc;border:1px solid #444;border-radius:4px;text-align:right;";
    const wLabel = mkEl("span", "font-size:10px;color:#999;"); wLabel.textContent = "W";
    const wInput = mkEl("input", INPUT_CSS, { type: "number", min: GRID, step: GRID, value: 1280 });
    const hLabel = mkEl("span", "font-size:10px;color:#999;"); hLabel.textContent = "H";
    const hInput = mkEl("input", INPUT_CSS, { type: "number", min: GRID, step: GRID, value: 720 });
    const arBtn = mkEl("button",
        "padding:3px 9px;font-size:11px;border:1px solid #99c0ee;border-radius:5px;" +
        "background:#1a3a5a;color:#aadaff;cursor:pointer;"
    );
    arBtn.textContent = "🔒"; arBtn._active = true; arBtn.title = "Lock aspect ratio";
    const resetBtn = mkBtn("reset");
    resetBtn.title = "Reset to default 1280×720 centered crop";
    cropSizeRow.append(wLabel, wInput, hLabel, hInput, arBtn, resetBtn);

    // ── Preset Chips Row ──
    const CHIP_PRESETS = [
        ["16:9", 1280,  720], ["9:16",  720, 1280], ["21:9", 1344,  576], ["9:21",  576, 1344],
        ["4:3",   960,  720], ["3:4",   720,  960], ["1:1",   960,  960],
        ["3:2",  1080,  720], ["2:3",   720, 1080],
    ];
    const CHIP_CSS = "padding:2px 7px;font-size:10px;font-family:monospace;" +
        "border:1px solid #444;border-radius:12px;background:#222;color:#999;" +
        "cursor:pointer;white-space:nowrap;flex-shrink:0;";
    const presetRow = mkEl("div", "display:flex;gap:4px;overflow-x:auto;padding-bottom:2px;flex-wrap:nowrap;");
    const chipBtns = CHIP_PRESETS.map(([label, w, h]) => {
        const btn = mkEl("button", CHIP_CSS);
        btn.textContent = label;
        btn.dataset.chipW = w; btn.dataset.chipH = h; btn.dataset.chipAR = w / h;
        presetRow.appendChild(btn);
        return btn;
    });

    // ── Snap Buttons (7, joined strip) ──
    const snapRow = mkEl("div", "display:flex;align-items:center;gap:0;");
    const snapLabel = mkEl("span", "font-size:10px;color:#999;margin-right:4px;");
    snapLabel.textContent = "snap:";
    const SNAP_DEFS = [
        ["center","center"], ["top","top"], ["bottom","bottom"],
        ["left","left"], ["right","right"], ["fitW","fit W"], ["fitH","fit H"],
    ];
    const snapBtns = SNAP_DEFS.map(([key, label], i) => {
        const isFirst = i === 0, isLast = i === SNAP_DEFS.length - 1;
        const radius = isFirst ? "4px 0 0 4px" : (isLast ? "0 4px 4px 0" : "0");
        const bl = isFirst ? "1px solid #444" : "none";
        const b = mkEl("button",
            `padding:2px 7px;font-size:10px;border:1px solid #444;border-left:${bl};` +
            `border-radius:${radius};background:#2a2a2a;color:#bbb;cursor:pointer;white-space:nowrap;`
        );
        b.textContent = label; b.dataset.snap = key;
        b.onmouseenter = () => { b.style.background = "#3a3a3a"; };
        b.onmouseleave = () => { b.style.background = "#2a2a2a"; };
        return b;
    });
    snapRow.append(snapLabel, ...snapBtns);

    // Frame scrubber
    const scrubRow = mkEl("div", "display:flex;align-items:center;gap:7px;");
    const frameLabel = mkEl("span", "font-size:10px;color:#999;");
    frameLabel.textContent = "frame:";
    const scrubber = mkEl("input", "flex:1;cursor:pointer;", { type: "range", min: 0, max: 0, value: 0 });
    const scrubIdx = mkEl("span", "font-size:10px;font-family:monospace;color:#999;min-width:50px;text-align:right;");
    scrubIdx.textContent = "0 / 0";
    scrubRow.append(frameLabel, scrubber, scrubIdx);

    // ── Output Size + Mask Color Row (shared) ──
    const outSizeRow = mkEl("div", "display:flex;align-items:center;gap:5px;flex-wrap:wrap;");
    const outLabel = mkEl("span", "font-size:10px;color:#999;"); outLabel.textContent = "output resolution:";
    const outWInput = mkEl("input", INPUT_CSS, { type: "number", min: 0, step: GRID, value: 0 });
    outWInput.placeholder = "auto";
    const outXLabel = mkEl("span", "font-size:10px;color:#999;"); outXLabel.textContent = "×";
    const outHInput = mkEl("input", INPUT_CSS, { type: "number", min: 0, step: GRID, value: 0 });
    outHInput.placeholder = "auto";
    const maskColorLabel = mkEl("span", "font-size:10px;color:#999;margin-left:24px;"); maskColorLabel.textContent = "pad color:";
    const SELECT_CSS = "padding:2px 5px;font-size:11px;font-family:monospace;background:#1e1e1e;color:#ccc;border:1px solid #444;border-radius:4px;cursor:pointer;";
    const maskColorSelect = mkEl("select", SELECT_CSS);
    for (const [val, label] of [["wan", "wan (gray)"], ["ltx", "ltx (black)"], ["custom", "custom"]]) {
        const opt = document.createElement("option");
        opt.value = val; opt.textContent = label;
        maskColorSelect.appendChild(opt);
    }
    const customColorInput = mkEl("input", INPUT_CSS + "width:100px;display:none;", { type: "text", value: "128,128,128", placeholder: "#RRGGBB or R,G,B" });
    outSizeRow.append(outLabel, outWInput, outXLabel, outHInput, maskColorLabel, maskColorSelect, customColorInput);

    ctrl.append(scrubRow, cropSizeRow, presetRow, snapRow, outSizeRow);
    root.append(wrap, ctrl);

    return { root, wrap, viewport, zoomIndicator, sfEl, frameImg, srcLabel, noDataMsg, maskTop, maskBot, maskLeft, maskRight, cropBox, arBtn, snapBtns, scrubber, scrubIdx, wInput, hInput, resetBtn, chipBtns, sizeLabel, padLabelT, padLabelB, padLabelL, padLabelR, edges, outWInput, outHInput, maskColorSelect, customColorInput };
}

// ── Render ────────────────────────────────────────────────────────────

function render(st, dom) {
    if (!st.initialized) return;
    const { sf, cr, srcW, srcH, view } = st;

    // Viewport zoom/pan
    dom.viewport.style.transform = `translate(${view.panX}px,${view.panY}px) scale(${view.zoom})`;
    dom.zoomIndicator.textContent = Math.round(view.zoom * 100) + "%";

    // Source frame
    dom.sfEl.style.left   = sf.x + "px";
    dom.sfEl.style.top    = sf.y + "px";
    dom.sfEl.style.width  = sf.w + "px";
    dom.sfEl.style.height = sf.h + "px";
    dom.srcLabel.textContent = `${srcW} × ${srcH}`;

    // Crop box
    dom.cropBox.style.left   = cr.x + "px";
    dom.cropBox.style.top    = cr.y + "px";
    dom.cropBox.style.width  = cr.w + "px";
    dom.cropBox.style.height = cr.h + "px";

    const s   = crToSrc(cr, sf, st.scale);

    // Mask overlays
    const ix1 = Math.max(cr.x, sf.x), iy1 = Math.max(cr.y, sf.y);
    const ix2 = Math.min(cr.x + cr.w, sf.x + sf.w);
    const iy2 = Math.min(cr.y + cr.h, sf.y + sf.h);

    const setMask = (el, x, y, w, h) => {
        if (w > 0 && h > 0) {
            el.style.cssText = `position:absolute;background:rgba(210,70,70,0.28);pointer-events:none;display:block;left:${x}px;top:${y}px;width:${w}px;height:${h}px;`;
        } else {
            el.style.display = "none";
        }
    };
    setMask(dom.maskTop,   cr.x, cr.y, cr.w, Math.max(0, iy1 - cr.y));
    setMask(dom.maskBot,   cr.x, iy2,  cr.w, Math.max(0, cr.y + cr.h - iy2));
    setMask(dom.maskLeft,  cr.x, iy1,  Math.max(0, ix1 - cr.x), iy2 - iy1);
    setMask(dom.maskRight, ix2,  iy1,  Math.max(0, cr.x + cr.w - ix2), iy2 - iy1);

    // Pad amounts
    const padT = Math.max(0, -s.y);
    const padB = Math.max(0, s.y + s.h - srcH);
    const padL = Math.max(0, -s.x);
    const padR = Math.max(0, s.x + s.w - srcW);

    // Canvas overlays
    const outW = Math.round(s.w), outH = Math.round(s.h);
    const effOutW = st.outW;
    const effOutH = st.outH;
    const hasOutScale = effOutW >= GRID && effOutH >= GRID && (effOutW !== outW || effOutH !== outH);
    dom.sizeLabel.textContent = hasOutScale
        ? `${outW}×${outH} → ${effOutW}×${effOutH}`
        : `${outW} × ${outH}`;
    dom.sizeLabel.style.display = "block";
    dom.sizeLabel.style.left = (cr.x + cr.w / 2) + "px";
    dom.sizeLabel.style.top  = (cr.y + cr.h - 18) + "px";

    const showPad = (el, text, show, cx, cy) => {
        el.textContent = text; el.style.display = show ? "block" : "none";
        if (show) { el.style.left = cx + "px"; el.style.top = cy + "px"; el.style.transform = "translate(-50%,-50%)"; }
    };
    showPad(dom.padLabelT, `▲ ${Math.round(padT)}`, padT > 0, cr.x + cr.w / 2, cr.y + (padT * st.scale) / 2);
    showPad(dom.padLabelB, `▼ ${Math.round(padB)}`, padB > 0, cr.x + cr.w / 2, cr.y + cr.h - (padB * st.scale) / 2);
    showPad(dom.padLabelL, `◀ ${Math.round(padL)}`, padL > 0, cr.x + (padL * st.scale) / 2, cr.y + cr.h / 2);
    showPad(dom.padLabelR, `▶ ${Math.round(padR)}`, padR > 0, cr.x + cr.w - (padR * st.scale) / 2, cr.y + cr.h / 2);

    // Sync W/H inputs
    if (document.activeElement !== dom.wInput) dom.wInput.value = outW;
    if (document.activeElement !== dom.hInput) dom.hInput.value = outH;

    // Sync output size inputs
    if (document.activeElement !== dom.outWInput)
        dom.outWInput.value = st.outW || "";
    if (document.activeElement !== dom.outHInput)
        dom.outHInput.value = st.outH || "";

    // Sync active preset chip
    const actualAR = st.arLocked ? st.cropAR : s.w / s.h;
    for (const btn of dom.chipBtns) {
        const chipAR = parseFloat(btn.dataset.chipAR);
        const active = Math.abs(chipAR - actualAR) < 0.005;
        btn.style.borderColor = active ? "#5090cc" : "#444";
        btn.style.color       = active ? "#aadaff" : "#999";
        btn.style.background  = active ? "#1a3050" : "#222";
    }

}

/** Zoom out (only) and/or re-center so both the source frame and crop box are fully visible. */
function fitCropInView(st, dom) {
    const wrapW = dom.wrap.clientWidth;
    const wrapH = dom.wrap.clientHeight;
    if (wrapW <= 0 || wrapH <= 0) return; // node is offscreen / collapsed
    const pad = MARGIN;
    // Union bounding box of source frame and crop box (canvas coords).
    const bx1 = Math.min(st.sf.x, st.cr.x);
    const by1 = Math.min(st.sf.y, st.cr.y);
    const bx2 = Math.max(st.sf.x + st.sf.w, st.cr.x + st.cr.w);
    const by2 = Math.max(st.sf.y + st.sf.h, st.cr.y + st.cr.h);
    const bw = bx2 - bx1, bh = by2 - by1;
    const fitZoom = Math.min(
        (wrapW - pad * 2) / bw,
        (wrapH - pad * 2) / bh,
    );
    const needsZoomOut = fitZoom < st.view.zoom;
    const z = needsZoomOut ? Math.max(0.15, fitZoom) : st.view.zoom;
    // Check if any part of the union rect is outside the visible canvas area.
    const scL = bx1 * z + st.view.panX;
    const scT = by1 * z + st.view.panY;
    const scR = bx2 * z + st.view.panX;
    const scB = by2 * z + st.view.panY;
    const outOfBounds = scL < 0 || scT < 0 || scR > wrapW || scB > wrapH;
    if (!needsZoomOut && !outOfBounds) return;
    st.view.zoom = z;
    st.view.panX = (wrapW - bw * z) / 2 - bx1 * z;
    st.view.panY = (wrapH - bh * z) / 2 - by1 * z;
}

// ── Widget sync ───────────────────────────────────────────────────────

function syncWidgets(st, widgets, node) {
    const s = quantizeSrc(crToSrc(st.cr, st.sf, st.scale));
    if (widgets.cropState)
        widgets.cropState.value = `${s.x},${s.y},${s.w},${s.h},${st.outW},${st.outH},${st.arLocked ? 1 : 0}`;
    if (widgets.maskColor)
        widgets.maskColor.value = st.maskColor;
    if (widgets.customColor)
        widgets.customColor.value = st.customColor;
    if (node.graph) node.graph.setDirtyCanvas(true, true);
}

// ── AR lock helper ────────────────────────────────────────────────────

function setArLocked(st, dom, locked) {
    st.arLocked = locked;
    if (locked) st.cropAR = st.cr.w / st.cr.h;
    dom.arBtn.textContent    = locked ? "🔒" : "🔓";
    dom.arBtn.style.border   = `1px solid ${locked ? "#99c0ee" : "#444"}`;
    dom.arBtn.style.background = locked ? "#1a3a5a" : "#2a2a2a";
    dom.arBtn.style.color    = locked ? "#aadaff" : "#bbb";
    dom.arBtn._active        = locked;
}

// ── Frame fetching ────────────────────────────────────────────────────

async function fetchInfo(nodeId) {
    try {
        const r = await fetch(`${API_PREFIX}/info?node_id=${nodeId}`);
        if (!r.ok) return null;
        return await r.json();
    } catch { return null; }
}

async function fetchFrame(nodeId, idx, dom) {
    try {
        const r = await fetch(`${API_PREFIX}/frame?node_id=${nodeId}&idx=${idx}`);
        if (!r.ok) return;
        const blob = await r.blob();
        const url  = URL.createObjectURL(blob);
        const old  = dom.frameImg.src;
        dom.frameImg.src = url;
        dom.frameImg.style.display = "block";
        dom.noDataMsg.style.display = "none";
        if (old && old.startsWith("blob:")) URL.revokeObjectURL(old);
    } catch { /* ignore */ }
}

// ── Interaction wiring ────────────────────────────────────────────────

function applyCropDim(st, dom, widgets, node, axis, rawVal) {
    const isW = axis === "w";
    const r = Math.max(GRID, Math.round(parseInt(rawVal, 10) / GRID) * GRID) || GRID;
    let s = crToSrc(st.cr, st.sf, st.scale);
    const cx = s.x + s.w / 2, cy = s.y + s.h / 2;
    if (isW) { s.w = r; if (st.arLocked) s.h = Math.max(GRID, Math.round(r / st.cropAR / GRID) * GRID); }
    else     { s.h = r; if (st.arLocked) s.w = Math.max(GRID, Math.round(r * st.cropAR / GRID) * GRID); }
    s.x = Math.round((cx - s.w / 2) / GRID) * GRID;
    s.y = Math.round((cy - s.h / 2) / GRID) * GRID;
    s = clampToValid(quantizeSrc(s), st.srcW, st.srcH);
    st.cr = srcToCr(s, st.sf, st.scale);
    if (!st.arLocked) st.cropAR = s.w / s.h;
    syncOutToAR(st);
    fitCropInView(st, dom); render(st, dom); syncWidgets(st, widgets, node);
}

function applyOutDim(st, dom, widgets, node, axis, rawVal) {
    const v = parseInt(rawVal, 10);
    if (isNaN(v) || v < GRID) {
        const d = defaultOut(st); st.outW = d.w; st.outH = d.h;
    } else {
        const r = Math.round(v / GRID) * GRID;
        if (axis === "w") { st.outW = r; st.outH = Math.max(GRID, Math.round(r / st.cropAR / GRID) * GRID); }
        else              { st.outH = r; st.outW = Math.max(GRID, Math.round(r * st.cropAR / GRID) * GRID); }
    }
    render(st, dom); syncWidgets(st, widgets, node);
}

function wireInteractions(st, dom, widgets, node, nodeId) {
    const { wrap, arBtn, snapBtns, scrubber, scrubIdx, wInput, hInput, resetBtn, chipBtns, outWInput, outHInput } = dom;

    // AR lock toggle
    arBtn.addEventListener("click", () => setArLocked(st, dom, !st.arLocked));

    // W / H inputs
    wInput.addEventListener("change", () => applyCropDim(st, dom, widgets, node, "w", wInput.value));
    hInput.addEventListener("change", () => applyCropDim(st, dom, widgets, node, "h", hInput.value));

    // Reset button
    resetBtn.addEventListener("click", () => {
        initLayout(st, dom.wrap);
        const d = defaultOut(st); st.outW = d.w; st.outH = d.h;
        fitCropInView(st, dom); render(st, dom); syncWidgets(st, widgets, node);
    });

    // Output W / H inputs
    outWInput.addEventListener("change", () => applyOutDim(st, dom, widgets, node, "w", outWInput.value));
    outHInput.addEventListener("change", () => applyOutDim(st, dom, widgets, node, "h", outHInput.value));

    // Preset chips
    for (const btn of chipBtns) {
        btn.addEventListener("click", () => {
            const rw = parseInt(btn.dataset.chipW, 10), rh = parseInt(btn.dataset.chipH, 10);
            const chipAR = rw / rh;
            setArLocked(st, dom, true); st.cropAR = chipAR;
            let s = crToSrc(st.cr, st.sf, st.scale);
            const cx = s.x + s.w / 2, cy = s.y + s.h / 2;
            // Preserve pixel count: solve w*h=area, w/h=chipAR
            const area = s.w * s.h;
            s.w = Math.max(GRID, Math.round(Math.sqrt(area * chipAR) / GRID) * GRID);
            s.h = Math.max(GRID, Math.round(s.w / chipAR / GRID) * GRID);
            s.x = Math.round((cx - s.w / 2) / GRID) * GRID;
            s.y = Math.round((cy - s.h / 2) / GRID) * GRID;
            s = clampToValid(s, st.srcW, st.srcH);
            st.cr = srcToCr(s, st.sf, st.scale);
            if (st.outW < GRID || st.outH < GRID) { st.outW = rw; st.outH = rh; }
            else syncOutToAR(st, true);
            fitCropInView(st, dom); render(st, dom); syncWidgets(st, widgets, node);
        });
    }

    // Snap buttons
    for (const btn of snapBtns) {
        btn.addEventListener("click", () => {
            const mode = btn.dataset.snap;
            let s = crToSrc(st.cr, st.sf, st.scale);
            const { srcW, srcH } = st;
            if (mode === "center") {
                s.x = Math.round((srcW - s.w) / 2 / GRID) * GRID;
                s.y = Math.round((srcH - s.h) / 2 / GRID) * GRID;
            } else if (mode === "top") {
                s.y = 0;
            } else if (mode === "bottom") {
                s.y = Math.round((srcH - s.h) / GRID) * GRID;
            } else if (mode === "fitW") {
                s.w = srcW;
                if (st.arLocked) s.h = Math.round(s.w / st.cropAR / GRID) * GRID;
                s.x = 0;
                s.y = Math.round((srcH - s.h) / 2 / GRID) * GRID;
            } else if (mode === "fitH") {
                s.h = srcH;
                if (st.arLocked) s.w = Math.round(s.h * st.cropAR / GRID) * GRID;
                s.y = 0;
                s.x = Math.round((srcW - s.w) / 2 / GRID) * GRID;
            } else if (mode === "left") {
                s.x = 0;
            } else if (mode === "right") {
                s.x = Math.round((srcW - s.w) / GRID) * GRID;
            }
            s = clampToValid(quantizeSrc(s), st.srcW, st.srcH);
            st.cr = srcToCr(s, st.sf, st.scale);
            if (!st.arLocked) st.cropAR = s.w / s.h;
            syncOutToAR(st);
            render(st, dom);
            syncWidgets(st, widgets, node);
        });
    }

    // Frame scrubber
    scrubber.addEventListener("input", () => {
        const idx = parseInt(scrubber.value);
        scrubIdx.textContent = idx + " / " + Math.max(0, st.frameCount - 1);
        fetchFrame(nodeId, idx, dom);
    });

    // ── Zoom (scroll wheel) ──
    wrap.addEventListener("wheel", e => {
        e.preventDefault();
        const rect   = wrap.getBoundingClientRect();
        const sx     = e.clientX - rect.left;
        const sy     = e.clientY - rect.top;
        const factor = e.deltaY < 0 ? 1.12 : (1 / 1.12);
        const newZoom = clamp(st.view.zoom * factor, 0.15, 5.0);
        // Keep the world point currently under the cursor in place.
        st.view.panX = sx - (sx - st.view.panX) * (newZoom / st.view.zoom);
        st.view.panY = sy - (sy - st.view.panY) * (newZoom / st.view.zoom);
        st.view.zoom = newZoom;
        render(st, dom);
    }, { passive: false });

    // Zoom reset button — fit both frame and crop box fully into view
    dom.zoomIndicator.addEventListener("click", () => {
        st.view = { zoom: Infinity, panX: 0, panY: 0 };
        fitCropInView(st, dom);
        render(st, dom);
    });

    // ── Pan (middle-click drag) ──
    let pan = null;

    // ── Pointer drag/resize ──
    let drag = null;
    const MIN_DRAG_PX = GRID;

    wrap.addEventListener("pointerdown", e => {
        // Middle-click → pan
        if (e.button === 1) {
            pan = { sx: e.clientX, sy: e.clientY, ox: st.view.panX, oy: st.view.panY };
            wrap.setPointerCapture(e.pointerId);
            e.preventDefault();
            return;
        }

        const handle    = e.target.closest("[data-dir]");
        const inCropBox = dom.cropBox.contains(e.target);
        const wc        = toWorld(e, wrap, st.view);

        if (handle) {
            drag = { type: "resize", dir: handle.dataset.dir, sx: wc.x, sy: wc.y, sb: { ...st.cr }, ar: st.arLocked ? st.cropAR : null };
            e.preventDefault();
        } else if (inCropBox) {
            drag = { type: "move", sx: wc.x, sy: wc.y, sb: { ...st.cr } };
            e.preventDefault();
        }
        if (drag) wrap.setPointerCapture(e.pointerId);
    });

    wrap.addEventListener("pointermove", e => {
        if (pan) {
            st.view.panX = pan.ox + (e.clientX - pan.sx);
            st.view.panY = pan.oy + (e.clientY - pan.sy);
            render(st, dom);
            return;
        }
        if (!drag) return;

        const wc   = toWorld(e, wrap, st.view);
        const dx   = wc.x - drag.sx;
        const dy   = wc.y - drag.sy;
        const minPx = MIN_DRAG_PX * st.scale;

        if (drag.type === "move") {
            applyCanvasCr({ ...drag.sb, x: drag.sb.x + dx, y: drag.sb.y + dy }, st);
            render(st, dom);
            return;
        }

        let { x, y, w, h } = drag.sb;
        const { dir, ar } = drag;

        if (dir === "br") {
            w = Math.max(minPx, w + dx);
            h = ar ? Math.round(w / ar) : Math.max(minPx, h + dy);
        } else if (dir === "bl") {
            const nw = Math.max(minPx, w - dx); x += w - nw; w = nw;
            h = ar ? Math.round(w / ar) : Math.max(minPx, h + dy);
        } else if (dir === "tr") {
            w = Math.max(minPx, w + dx);
            const nh = ar ? Math.round(w / ar) : Math.max(minPx, h - dy);
            y += h - nh; h = nh;
        } else if (dir === "tl") {
            const nw = Math.max(minPx, w - dx); x += w - nw; w = nw;
            const nh = ar ? Math.round(w / ar) : Math.max(minPx, h - dy);
            y += h - nh; h = nh;
        } else if (dir === "t") {
            const nh = Math.max(minPx, h - dy);
            const nw = ar ? Math.round(nh * ar) : w;
            if (ar) x += Math.round((w - nw) / 2);
            y += h - nh; h = nh; w = nw;
        } else if (dir === "b") {
            const nh = Math.max(minPx, h + dy);
            const nw = ar ? Math.round(nh * ar) : w;
            if (ar) x += Math.round((w - nw) / 2);
            h = nh; w = nw;
        } else if (dir === "l") {
            const nw = Math.max(minPx, w - dx);
            const nh = ar ? Math.round(nw / ar) : h;
            if (ar) y += Math.round((h - nh) / 2);
            x += w - nw; w = nw; h = nh;
        } else if (dir === "r") {
            const nw = Math.max(minPx, w + dx);
            const nh = ar ? Math.round(nw / ar) : h;
            if (ar) y += Math.round((h - nh) / 2);
            w = nw; h = nh;
        }

        applyCanvasCr({ x, y, w, h }, st);
        render(st, dom);
    });

    wrap.addEventListener("pointerup", () => {
        if (pan)  { pan  = null; return; }
        if (drag) {
            const type = drag.type;
            drag = null;
            if (type === "resize" && st.arLocked) {
                // Re-derive h from w so the final dimensions honour the exact locked AR,
                // undoing any divergence introduced by independent GRID rounding.
                let s = crToSrc(st.cr, st.sf, st.scale);
                s = quantizeSrc(s);
                s.h = Math.max(GRID, Math.round(s.w / st.cropAR / GRID) * GRID);
                s = clampToValid(s, st.srcW, st.srcH);
                st.cr = srcToCr(s, st.sf, st.scale);
            }
            if (type === "resize") {
                if (!st.arLocked) {
                    const s = crToSrc(st.cr, st.sf, st.scale);
                    st.cropAR = s.w / s.h;
                }
                syncOutToAR(st);
            }
            if (type === "resize" || type === "move") fitCropInView(st, dom);
            render(st, dom);
            syncWidgets(st, widgets, node);
        }
    });
    wrap.addEventListener("pointercancel", () => { pan = null; drag = null; });

    // ── Keyboard nudge ──
    wrap.tabIndex = 0;
    wrap.addEventListener("keydown", e => {
        const arrows = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];
        if (!arrows.includes(e.key)) return;
        if ([wInput, hInput, outWInput, outHInput].includes(document.activeElement)) return;
        e.preventDefault(); e.stopPropagation();
        let s = crToSrc(st.cr, st.sf, st.scale);
        const step = e.shiftKey ? GRID * 4 : GRID;
        if (e.key === "ArrowUp")    s.y -= step;
        if (e.key === "ArrowDown")  s.y += step;
        if (e.key === "ArrowLeft")  s.x -= step;
        if (e.key === "ArrowRight") s.x += step;
        s = clampToValid(quantizeSrc(s), st.srcW, st.srcH);
        st.cr = srcToCr(s, st.sf, st.scale);
        render(st, dom); syncWidgets(st, widgets, node);
    });

    // ── Mask color controls ──
    dom.maskColorSelect.value = st.maskColor;
    dom.customColorInput.style.display = st.maskColor === "custom" ? "inline-block" : "none";
    dom.customColorInput.value = st.customColor;

    dom.maskColorSelect.addEventListener("change", () => {
        st.maskColor = dom.maskColorSelect.value;
        dom.customColorInput.style.display = st.maskColor === "custom" ? "inline-block" : "none";
        syncWidgets(st, widgets, node);
    });
    dom.customColorInput.addEventListener("change", () => {
        st.customColor = dom.customColorInput.value.trim();
        syncWidgets(st, widgets, node);
    });
}

// ── Mask color DOM sync ───────────────────────────────────────────────

function applyMaskColorToDOM(st, dom) {
    dom.maskColorSelect.value = st.maskColor;
    dom.customColorInput.style.display = st.maskColor === "custom" ? "inline-block" : "none";
    dom.customColorInput.value = st.customColor;
}

// ── Resize observer ───────────────────────────────────────────────────

function setupResizeObserver(st, dom) {
    const ro = new ResizeObserver(() => {
        if (!st.initialized) return;
        // If the node is collapsed or hidden (H=0), clientHeight is 0, which produces
        // negative maxH/scale inside initLayout — bail out to preserve valid state.
        if (dom.wrap.clientHeight <= 0) return;
        // Preserve source-pixel crop before re-layout.
        const prevSrc  = crToSrc(st.cr, st.sf, st.scale);
        const prevZoom = st.view.zoom;
        const prevPan  = { ...st.view };
        if (!initLayout(st, dom.wrap)) return;
        // Restore crop in new coordinate space.
        const s = clampToValid(quantizeSrc(prevSrc), st.srcW, st.srcH);
        st.cr = srcToCr(s, st.sf, st.scale);
        st.cropAR = s.w / s.h;
        // Keep the view if it was non-default (user has zoomed/panned).
        if (prevZoom !== 1.0 || prevPan.panX !== 0 || prevPan.panY !== 0) {
            st.view = prevPan;
        }
        render(st, dom);
    });
    ro.observe(dom.wrap);
    return ro;
}

// ── Node extension ────────────────────────────────────────────────────

app.registerExtension({
    name: "VACEOutpaint",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_CLASS) return;

        const origOnNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const result = origOnNodeCreated?.apply(this, arguments);
            const node = this;

            // Find canvas-managed widgets.
            const widgets = {
                cropState:   node.widgets?.find(w => w.name === "crop_state"),
                maskColor:   node.widgets?.find(w => w.name === "mask_color"),
                customColor: node.widgets?.find(w => w.name === "custom_color"),
            };

            // Remove input connectors for canvas-driven widgets (not wireable).
            if (node.inputs) {
                const hidden = new Set(["crop_state", "mask_color", "custom_color"]);
                for (let i = node.inputs.length - 1; i >= 0; i--) {
                    if (hidden.has(node.inputs[i].name)) node.removeInput(i);
                }
            }

            // Build the canvas widget.
            const st  = createState();
            const dom = buildUI();

            const domWidget = node.addDOMWidget("vace_outpaint_canvas", "customvideo", dom.root, {
                serialize: false,
                hideOnZoom: false,
            });

            const CTRL_H = 185; // scrubber + size row + presets + snap + out+mask row + gaps
            const NODE_CHROME = 72; // ComfyUI title bar + slot padding overhead
            const MIN_W = 520;
            domWidget.computeSize = () => [440, CANVAS_H + CTRL_H];
            node.setSize([Math.max(node.size[0], MIN_W), Math.max(node.size[1], CANVAS_H + CTRL_H + NODE_CHROME)]);
            let _prevNodeX = node.pos[0];
            let _prevMeasuredChrome = null;
            node.onResize = function(size) {
                if (size[0] < MIN_W) {
                    if (this.pos[0] !== _prevNodeX) {
                        // Left-edge drag: compensate pos so the right edge stays pinned.
                        // Without this, clamping size while pos keeps moving looks like a pan.
                        this.pos[0] += size[0] - MIN_W;
                    }
                    size[0] = MIN_W;
                }
                _prevNodeX = this.pos[0];

                const currentDOMHeight = dom.root.offsetHeight;
                if (currentDOMHeight > 0) {
                    const measuredChrome = size[1] - currentDOMHeight;
                    // In ComfyUI Node2.0 (V2 frontend), the node size is automatically driven by the DOM element size.
                    // If we blindly update the DOM height here, it creates a positive feedback loop of infinite expansion.
                    // When V2 drives the resize, `measuredChrome` remains constant. 
                    // When the user drags the corner, it fluctuates wildly.
                    if (_prevMeasuredChrome !== null && Math.abs(measuredChrome - _prevMeasuredChrome) < 2) {
                        _prevMeasuredChrome = measuredChrome;
                        return; // Break the infinite expansion loop
                    }
                    _prevMeasuredChrome = measuredChrome;
                }

                // Grow the canvas wrap to fill extra node height, but never feed back
                // into computeSize (that would cause an infinite expand loop on load).
                const h = Math.max(CANVAS_H, size[1] - CTRL_H - NODE_CHROME);
                dom.wrap.style.height = h + "px";
                // ResizeObserver on dom.wrap handles re-layout
            };

            // Place canvas widget first; hide all canvas-managed widgets from native UI.
            if (node.widgets) {
                const hideNames = new Set(["crop_state", "mask_color", "custom_color"]);
                const toHide = node.widgets.filter(w => hideNames.has(w.name));
                node.widgets = [domWidget, ...node.widgets.filter(w => w !== domWidget && !hideNames.has(w.name))];
                for (const w of toHide) { node.widgets.push(w); w.computeSize = () => [0, -4]; w.hidden = true; }
            }

            // Latch crop_state at onConfigure time so the rAF callback always has
            // the post-restore value.  Without this, the double-rAF can fire before
            // node.configure() runs the positional widget restore in some loading
            // paths, leaving crop_state.value as the empty default.
            const origOnConfigure = node.onConfigure;
            node.onConfigure = function (info) {
                if (origOnConfigure) origOnConfigure.call(this, info);
                if (widgets.cropState)   st._latchedCropState   = widgets.cropState.value;
                if (widgets.maskColor)   st._latchedMaskColor   = widgets.maskColor.value;
                if (widgets.customColor) st._latchedCustomColor = widgets.customColor.value;
            };

            // Shared helper: apply fetched frame data to the widget.
            const applyFrameData = (data, preserveCrop) => {
                const val = widgets.cropState?.value ?? "";
                const hadCrop = preserveCrop && val !== "" && !val.split(",").some(isNaN);
                const prevSrc = (hadCrop && st.initialized) ? crToSrc(st.cr, st.sf, st.scale) : null;
                st.srcW = data.width;
                st.srcH = data.height;
                st.frameCount = data.frame_count;
                initLayout(st, dom.wrap);
                if (prevSrc) {
                    const s = clampToValid(quantizeSrc(prevSrc), st.srcW, st.srcH);
                    st.cr = srcToCr(s, st.sf, st.scale);
                    st.cropAR = s.w / s.h;
                } else if (hadCrop) {
                    restoreCropFromWidgets(st, widgets);
                }
                // Only set default output resolution if the user hasn't configured one.
                if (st.outW < GRID || st.outH < GRID) {
                    const d = defaultOut(st); st.outW = d.w; st.outH = d.h;
                }
                dom.frameImg.src = "data:image/jpeg;base64," + data.frame;
                dom.frameImg.style.display = "block";
                dom.noDataMsg.style.display = "none";
                dom.scrubber.max = Math.max(0, data.frame_count - 1);
                dom.scrubber.value = 0;
                dom.scrubIdx.textContent = "0 / " + Math.max(0, data.frame_count - 1);
                fitCropInView(st, dom);
                render(st, dom);
                syncWidgets(st, widgets, node);
            };

            // Deferred init so the DOM widget has been laid out and has a real width.
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    const nodeId = String(node.id);

                    if (!initLayout(st, dom.wrap)) return;
                    // Use the value latched at onConfigure time if available.
                    restoreCropFromWidgets(st, widgets, st._latchedCropState);
                    st._latchedCropState = undefined;
                    // Restore mask color state from saved widget values.
                    if (st._latchedMaskColor)   { st.maskColor   = st._latchedMaskColor;   st._latchedMaskColor   = undefined; }
                    if (st._latchedCustomColor) { st.customColor = st._latchedCustomColor; st._latchedCustomColor = undefined; }
                    applyMaskColorToDOM(st, dom);
                    setArLocked(st, dom, st.arLocked);
                    if (st.outW < GRID || st.outH < GRID) {
                        const d = defaultOut(st); st.outW = d.w; st.outH = d.h;
                    } else {
                        syncOutToAR(st);
                    }
                    fitCropInView(st, dom);
                    wireInteractions(st, dom, widgets, node, nodeId);
                    render(st, dom);
                    setupResizeObserver(st, dom);

                    // Re-display frames after every successful workflow run.
                    // execution_success fires once the whole graph has finished,
                    // at which point Python has populated the frame cache for our node.
                    const onExecutionSuccess = async () => {
                        const data = await fetchInfo(nodeId);
                        if (data) applyFrameData(data, true);
                    };
                    api.addEventListener("execution_success", onExecutionSuccess);
                    node._outpaintCleanup = () => api.removeEventListener("execution_success", onExecutionSuccess);

                    // Also try to recover frames cached from a prior server session.
                    fetchInfo(nodeId).then(data => {
                        if (data) applyFrameData(data, true);
                    });
                });
            });

            // Cleanup.
            const origOnRemoved = node.onRemoved;
            node.onRemoved = function () {
                node._outpaintCleanup?.();
                if (origOnRemoved) origOnRemoved.call(this);
            };

            node._outpaintCtx = { st, dom, widgets };
            return result;
        };
    },
});
