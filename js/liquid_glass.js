/* =====================================================================
 * liquid_glass.js — Apple-style "Liquid Glass" displacement filter for
 * the qualitative-comparison slider bars.
 *
 * This file ports Technique C (SDF / per-pixel displacement) from
 * `liquid-glass/examples/04-draggable-lens.html` to the vertical
 * splitter pills (`.glass-splitter`) in this page. That example is
 * the "real Apple WWDC 2025 look": pixels deep inside the pill map to
 * themselves (no shift), pixels in the rim bezel get strongly pulled
 * toward the center, and the result is a heavy curved-glass
 * refraction — not the subtle gradient-pill rim bend of Technique B.
 *
 * How the math works (same as example 04)
 * ---------------------------------------
 *  - For every pixel (x, y) in the bar's bounding box we run a
 *    *fragment shader* in JS that returns a UV offset.
 *  - The shader computes a signed distance to a rounded-rect
 *    (`roundedRectSDF`) and a smoothStep falloff so deep-inside pixels
 *    return their own UV (no displacement) while bezel pixels return a
 *    UV pulled toward the center.
 *  - The (dx, dy) shifts get encoded into the R / G channels of a
 *    canvas, normalised to fit in [0, 255]. That canvas becomes a
 *    data URL, which is fed into <feImage> → <feDisplacementMap>.
 *  - <feDisplacementMap scale="N"> tells the browser how many pixels
 *    R=128 (= 0 shift) ± 127 corresponds to. We set N = peak shift so
 *    the encoding is exactly invertible.
 *
 * One shared filter
 * -----------------
 * All bars are the same CSS size, so a single shared filter is
 * correct and cheap. We rebuild the map only when:
 *   - the page first loads, or
 *   - the bar's measured size changes (window resize re-flowing the
 *     comparison cells changes the bar height).
 *
 * Browser reality
 * ---------------
 * `backdrop-filter: url(#filter)` is Chromium-only. Safari / Firefox
 * silently ignore the `url(...)` and fall back to the rest of the
 * chain (blur + saturate). The CSS keeps a reasonable fallback alive
 * via `@supports`.
 * ===================================================================== */

(function () {
  'use strict';

  // -- shader math (identical to scripts/sdf-lens.js) ----------------
  function smoothStep(a, b, t) {
    t = Math.max(0, Math.min(1, (t - a) / (b - a)));
    return t * t * (3 - 2 * t);
  }
  function length(x, y) { return Math.sqrt(x * x + y * y); }
  function roundedRectSDF(x, y, w, h, r) {
    const qx = Math.abs(x) - w + r;
    const qy = Math.abs(y) - h + r;
    return Math.min(Math.max(qx, qy), 0)
         + length(Math.max(qx, 0), Math.max(qy, 0))
         - r;
  }
  const tex = (x, y) => ({ x, y });

  // -- Build/refresh a single feImage + feDisplacementMap filter -----
  // `filterId` is the <filter> id; CSS references it via
  // `backdrop-filter: url(#<filterId>)`.
  //
  // ANTI-ALIASING NOTE
  // ------------------
  // The bar is only ~26 CSS px wide. If we paint the displacement map
  // at exactly that size, each scanline's rim shift is rounded to a
  // single quantized value, and adjacent rows along the curved bezel
  // can land on visibly different shift amounts → "sawtooth" stair-
  // stepping along the bar's edge (especially obvious against high-
  // contrast frames like white objects on black backgrounds).
  //
  // The fix is to supersample: render the canvas at SS× the display
  // size, but keep the <feImage> region at the *display* size. The
  // SVG renderer bilinearly downsamples the data URL → the curved
  // rim becomes a smooth gradient of shifts instead of integer steps.
  // Visible refraction strength is unchanged (the encoding still
  // maps ±peak ↦ 0..255 and feDisplacementMap's `scale` matches the
  // peak in *display* pixels), but the stair-stepping disappears.
  const SS = 3; // 3× supersample is plenty for a 26 px bar; cheap.
  function buildLensFilter(filterId, width, height, fragment) {
    const ns  = 'http://www.w3.org/2000/svg';
    const xns = 'http://www.w3.org/1999/xlink';
    const defs = document.getElementById('liquid-glass-defs');
    if (!defs) return;

    // Display size — what feImage paints into and what feDisplacementMap
    // measures `scale` in.
    const w = Math.max(2, Math.ceil(width));
    const h = Math.max(2, Math.ceil(height));

    // Hi-res sampling grid for the SDF — the canvas itself is SS× larger
    // than the display region in each axis.
    const sw = w * SS;
    const sh = h * SS;

    // 1) Paint the displacement map onto an off-screen (supersampled)
    //    canvas. UVs stay in [0,1] regardless of SS, so the SDF is
    //    sampled the same way — just at finer resolution.
    const canvas = document.createElement('canvas');
    canvas.width  = sw;
    canvas.height = sh;
    const cctx = canvas.getContext('2d');
    const data = new Uint8ClampedArray(sw * sh * 4);

    const raw = [];
    let max = 0;
    for (let i = 0; i < data.length; i += 4) {
      const px = (i / 4) % sw;
      const py = Math.floor(i / 4 / sw);
      const pos = fragment({ x: px / sw, y: py / sh });
      // dx/dy expressed in *display* pixels (not supersampled pixels)
      // so feDisplacementMap's `scale` units stay in display px.
      const dx  = pos.x * w - (px / SS);
      const dy  = pos.y * h - (py / SS);
      if (Math.abs(dx) > max) max = Math.abs(dx);
      if (Math.abs(dy) > max) max = Math.abs(dy);
      raw.push(dx, dy);
    }
    // The /2 here matches scripts/sdf-lens.js: the encoding maps
    // ±max to the full 0..255 range, and feDisplacementMap's `scale`
    // is set to `max` (not 2*max) so the *visible* shift = peak shift.
    max *= 0.5;

    let k = 0;
    for (let i = 0; i < data.length; i += 4) {
      data[i]     = (raw[k++] / max + 0.5) * 255; // R = X-shift
      data[i + 1] = (raw[k++] / max + 0.5) * 255; // G = Y-shift
      data[i + 2] = 0;
      data[i + 3] = 255;
    }
    cctx.putImageData(new ImageData(data, sw, sh), 0, 0);
    const mapURL = canvas.toDataURL();

    // 2) Create or update the SVG filter that uses this canvas.
    let filter = document.getElementById(filterId);
    if (!filter) {
      filter = document.createElementNS(ns, 'filter');
      filter.setAttribute('id', filterId);
      filter.setAttribute('color-interpolation-filters', 'sRGB');
      filter.setAttribute('filterUnits', 'userSpaceOnUse');

      const feImage = document.createElementNS(ns, 'feImage');
      feImage.setAttribute('id', filterId + '-img');
      feImage.setAttribute('result', 'map');
      feImage.setAttribute('x', '0');
      feImage.setAttribute('y', '0');
      // High-quality downsampling from the SS× canvas to the display
      // region. Without this hint Chromium may pick nearest-neighbour
      // and we lose the entire benefit of supersampling.
      feImage.setAttribute('preserveAspectRatio', 'none');
      filter.appendChild(feImage);

      const feDisp = document.createElementNS(ns, 'feDisplacementMap');
      feDisp.setAttribute('id', filterId + '-disp');
      feDisp.setAttribute('in', 'SourceGraphic');
      feDisp.setAttribute('in2', 'map');
      feDisp.setAttribute('xChannelSelector', 'R');
      feDisp.setAttribute('yChannelSelector', 'G');
      filter.appendChild(feDisp);

      defs.appendChild(filter);
    }

    filter.setAttribute('x', '0');
    filter.setAttribute('y', '0');
    filter.setAttribute('width',  String(w));
    filter.setAttribute('height', String(h));

    const feImage = document.getElementById(filterId + '-img');
    const feDisp  = document.getElementById(filterId + '-disp');
    if (feImage) {
      // feImage region is the *display* size — the data URL is
      // SS× larger and the renderer scales it down with bilinear
      // filtering (same trick as drawing a 3× retina image into a
      // 1× CSS box).
      feImage.setAttribute('width',  String(w));
      feImage.setAttribute('height', String(h));
      // Both `href` and the legacy xlink:href are set so older Chromium
      // and any odd renderers all pick the data URL up.
      feImage.setAttributeNS(xns, 'href', mapURL);
      feImage.setAttribute('href', mapURL);
    }
    if (feDisp) feDisp.setAttribute('scale', String(max));
  }

  // -- Build the displacement for the vertical bar -------------------
  // The bar is a tall rounded-rect pill, so we use the same SDF
  // fragment as example 04, just stretched vertically.
  //
  // Half-extents define the "no-shift core". Anything outside this
  // core (but still inside the element) is the bezel where pixels
  // get pulled toward the centerline:
  //   - 0.18 wide  → leaves ~32% of the bar width on each side as
  //                  bezel rim. Aggressive on purpose: the bar is
  //                  narrow, so we spend most of its width on the
  //                  refracting rim instead of the flat core. This
  //                  is what gives the strong left/right bend the
  //                  user is after.
  //   - 0.46 tall  → leaves only ~4% on top/bottom as bezel; we
  //                  don't want top/bottom refraction competing
  //                  with the long-edge effect.
  // The smoothStep ramp is tighter than the example default
  // (0.5, 0, d - 0.08) so the bend ramps up faster as you approach
  // the rim — sharper curvature, stronger rim pull.
  //
  // We softened it slightly from (0.35, 0, d - 0.04) → (0.42, 0, d - 0.05)
  // so the easing toward the rim is a hair more gradual. Combined with
  // the supersampled displacement map this kills the visible "sawtooth"
  // stair-stepping along the bar edge that appeared on high-contrast
  // frames, while keeping the same overall curved-glass refraction.
  function barFragment(uv) {
    const ix = uv.x - 0.5;
    const iy = uv.y - 0.5;
    const d  = roundedRectSDF(ix, iy, 0.18, 0.46, 0.4);
    const t  = smoothStep(0.42, 0, d - 0.05);
    const s  = smoothStep(0, 1, t);
    return tex(ix * s + 0.5, iy * s + 0.5);
  }

  // -- Build the displacement for the playback-slider thumb ---------
  // The thumb is a circular bauble (think the orange/yellow ball in
  // Apple's WWDC 2025 "Liquid Glass" reference). For a circle the
  // SDF reduces to `length(uv) - r`, with a generous rim so most of
  // the disc bends — this is what gives the spherical-glass look
  // rather than a flat refraction at the very edge only.
  //
  //   r = 0.30  → the no-shift core is ~60% of the disc diameter.
  //               Beyond r the bezel rim ramps up to the full edge.
  //   smoothStep(0.20, 0, d - 0.02) — tight ramp so the rim feels
  //               like a thick spherical glass dome, not a flat
  //               translucent disc.
  function thumbFragment(uv) {
    const ix = uv.x - 0.5;
    const iy = uv.y - 0.5;
    const d  = Math.sqrt(ix * ix + iy * iy) - 0.30;
    const t  = smoothStep(0.20, 0, d - 0.02);
    const s  = smoothStep(0, 1, t);
    return tex(ix * s + 0.5, iy * s + 0.5);
  }

  // -- Actual measurement-driven refresh -----------------------------
  //
  // Only the bar filter is needed in the current "single thick pill"
  // design — the inner handle element is hidden by CSS. The bar has
  // two visual states (rest = 4 px thin rule, active = 26 px liquid
  // pill), so we always build the SDF map at the *active* size. The
  // rest state's CSS doesn't include the url(#…) reference, so the
  // filter is wired but effectively dormant; when the user hovers
  // and the chain morphs to include url(...), the map is already the
  // right size and refraction kicks in immediately.
  //
  // We use the live splitter's *height* (not its width — that
  // changes between states) to size the SDF map. Width is locked to
  // the active-state value of 26 CSS px.
  //
  // We also build a circular `#liquid-glass-thumb` filter — sized to
  // the playback slider's *active* thumb dimensions, so the rest /
  // active state morph doesn't trigger an SDF rebuild on every
  // hover. The rest-state CSS doesn't reference the filter anyway,
  // so the dormant map is harmless.
  const ACTIVE_BAR_WIDTH    = 26;
  // Thumb is 30 × 30 in the active state (was 28). Bumped slightly so
  // the layered Figma rim/halo stack has room to read on top of the
  // SDF refraction — keep this in sync with .glass-slider-thumb's
  // active width/height in main.css.
  const ACTIVE_THUMB_WIDTH  = 30;
  const ACTIVE_THUMB_HEIGHT = 30;
  let lastBarSize   = { w: 0, h: 0 };
  let lastThumbSize = { w: 0, h: 0 };

  function refresh() {
    // -- Splitter bar ---------------------------------------------
    const protoBar = document.querySelector('.glass-splitter');
    let bw = ACTIVE_BAR_WIDTH;
    let bh = 280;
    if (protoBar) {
      const r = protoBar.getBoundingClientRect();
      // Add the active-state's top/bottom overhang (16 px total) so
      // the map covers the area the bar will occupy when expanded.
      // The rest-state height is bar-height + 8, the active-state
      // height is bar-height + 16; we generate at the larger size.
      if (r.height > 0) bh = r.height + 8;
    }
    if (bw !== lastBarSize.w || bh !== lastBarSize.h) {
      buildLensFilter('liquid-glass-bar', bw, bh, barFragment);
      lastBarSize = { w: bw, h: bh };
    }

    // -- Slider thumb (playback bauble) ---------------------------
    // Size locked to the active state — the smaller rest-state pill
    // doesn't use the SDF filter, so we don't need to rebuild it
    // when the user hovers in/out.
    const tw = ACTIVE_THUMB_WIDTH;
    const th = ACTIVE_THUMB_HEIGHT;
    if (tw !== lastThumbSize.w || th !== lastThumbSize.h) {
      buildLensFilter('liquid-glass-thumb', tw, th, thumbFragment);
      lastThumbSize = { w: tw, h: th };
    }
  }

  // -- Wire up: build now, rebuild on resize, rebuild when new
  //    splitters/handles are inserted (index.js builds them lazily
  //    per-panel as videos initialise). -----------------------------
  function init() {
    refresh();

    const obs = new MutationObserver(function (mutations) {
      let needsRefresh = false;
      for (const m of mutations) {
        for (const n of m.addedNodes) {
          if (!(n instanceof HTMLElement)) continue;
          if (n.classList && (n.classList.contains('glass-splitter') ||
                              n.classList.contains('glass-handle')   ||
                              n.classList.contains('glass-slider-thumb'))) {
            needsRefresh = true;
            break;
          }
          if (n.querySelector && n.querySelector(
              '.glass-handle, .glass-splitter, .glass-slider-thumb')) {
            needsRefresh = true;
            break;
          }
        }
        if (needsRefresh) break;
      }
      if (needsRefresh) refresh();
    });
    obs.observe(document.body, { childList: true, subtree: true });

    let resizeTimer = null;
    window.addEventListener('resize', function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(refresh, 120);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
