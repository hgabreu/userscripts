// ==UserScript==
// @name         Google Calendar — Fit Week to Viewport
// @namespace    github.com/henrique
// @version      0.3.11
// @description  Compresses the week/day timed grid so all 24 hours fit the viewport without scrolling.
// @match        https://calendar.google.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const VERSION = '0.3.11';
  console.log('[gcal-height]', VERSION, 'loaded at', new Date().toISOString());
  // Guard against double-install (e.g. Tampermonkey + manual injection).
  if (window.__gcalFitWeekInstalled) {
    console.log('[gcal-height]', VERSION, 'skipping — already installed:', window.__gcalFitWeekInstalled);
    return;
  }
  window.__gcalFitWeekInstalled = VERSION;

  const SEL = {
    // Day-columns scroll container (events live here).
    scrollContainer: '.mDPmMe',
    innerRow: '.mDPmMe > .Tmdkcc.ChfiMc',
    timeColumn: '.mDPmMe .aLC8Le',
    sizer: '.mDPmMe .EDDeke',
    dayCell: '.mDPmMe [role="gridcell"].BiKU4b',
    eventChip: '.mDPmMe .GTG3wb',
    // Single hour-cell GCal uses internally as the px-per-hour ruler. Its rendered
    // height varies by viewport (e.g. 60px / 40px / 30px), so chip pixel values
    // must be normalised against this — not against a hard-coded 60px/hour.
    // Also draws the horizontal hour grid-line via ::after, so when we stretch
    // the cell we MUST also stretch this so the grid-lines stretch with it.
    hourRuler: '.mDPmMe .aLC8Le > .sJ9Raf',
    // Sibling time-labels column (one or more timezones).
    labelsViewport: '.lqYlwe',
    labelsColumn: '.lqYlwe .R6TFwe',
    hourLabel: '.lqYlwe .R6TFwe .XsRa1c',
  };
  const NATURAL_HOUR_PX = 60;
  const NATURAL_DAY_PX = NATURAL_HOUR_PX * 24; // 1440
  const STYLE_ID = 'gcal-fit-week-style';

  let styleEl = null;
  let observer = null;
  let resizeRaf = 0;
  let applyRaf = 0;
  let lastTarget = -1;

  function ensureStyle() {
    if (styleEl && styleEl.isConnected) return styleEl;
    styleEl = document.createElement('style');
    styleEl.id = STYLE_ID;
    document.head.appendChild(styleEl);
    return styleEl;
  }

  function measure() {
    const sc = document.querySelector(SEL.scrollContainer);
    if (!sc) return null;
    const top = sc.getBoundingClientRect().top;
    const target = window.innerHeight - top - 4;
    if (target <= 0) return null;
    return { target, scale: target / NATURAL_DAY_PX };
  }

  function applyCss() {
    const m = measure();
    if (!m) return false;
    // Always re-process chips — handles initial paint and post-CSS GCal rewrites.
    document.querySelectorAll(SEL.eventChip).forEach(processChip);
    // Idempotent: skip CSS rewrite if target hasn't shifted by >=1px.
    if (Math.abs(m.target - lastTarget) < 1) return true;
    lastTarget = m.target;
    const rowH = NATURAL_HOUR_PX * m.scale;
    const totalH = NATURAL_DAY_PX * m.scale;
    ensureStyle().textContent = `
      /* Keep GCal's native overflow-y:scroll so the 16px scrollbar gutter
         stays reserved. If we switch to overflow:hidden (or hide the bar
         with scrollbar-width:none / ::-webkit-scrollbar{display:none}), the
         16px is reclaimed and day-cell widths shift, breaking alignment
         with the all-day strip and day headers. Instead, paint the bar
         transparent so the gutter is preserved. */
      ${SEL.scrollContainer},
      ${SEL.labelsViewport} {
        height: ${m.target}px !important;
        max-height: ${m.target}px !important;
        scrollbar-color: transparent transparent !important;
      }
      ${SEL.scrollContainer}::-webkit-scrollbar-thumb,
      ${SEL.labelsViewport}::-webkit-scrollbar-thumb,
      ${SEL.scrollContainer}::-webkit-scrollbar-track,
      ${SEL.labelsViewport}::-webkit-scrollbar-track {
        background: transparent !important;
      }
      ${SEL.innerRow},
      ${SEL.dayCell},
      ${SEL.labelsColumn} {
        height: ${totalH}px !important;
        min-height: ${totalH}px !important;
      }
      ${SEL.hourLabel} {
        height: ${rowH}px !important;
        min-height: ${rowH}px !important;
        max-height: ${rowH}px !important;
      }
      /* Don't touch .sJ9Raf height — GCal uses its rendered height as the
         px-per-hour ruler for chip positioning, and stretching it confuses
         chip top values that were computed against the previous ruler.
         Instead, hide the native grid-lines (which only fill the top 960px
         of a stretched cell) and draw our own via a background pattern. */
      ${SEL.hourRuler}::after { border-bottom-width: 0 !important; }
      /* Lines at the TOP of each row instead of the bottom — that places
         the first line at y=0 (00:00 boundary, separating the all-day strip
         from the timed grid). 24 lines total at y=0..23*rowH. */
      ${SEL.innerRow} {
        background-image: linear-gradient(to bottom,
          rgba(95, 99, 104, 0.5) 0,
          rgba(95, 99, 104, 0.5) 1px,
          transparent 1px,
          transparent ${rowH}px) !important;
        background-size: 100% ${rowH}px !important;
        background-repeat: repeat-y !important;
      }
      /* Extend each grid-line a few px to the left of Sunday by drawing the
         same line pattern on the right edge of the rightmost timezone column
         (adjacent to Sunday). The .R6TFwe columns have an opaque background
         that would cover a gradient on .lqYlwe, so we go on the column
         instead. Width is small enough to leave a clear gap between the label
         text and the tick — the tick should visually connect to the day-cell
         grid-line, not to the label. */
      ${SEL.labelsColumn}:last-child {
        background-image: linear-gradient(to bottom,
          rgba(95, 99, 104, 0.5) 0,
          rgba(95, 99, 104, 0.5) 1px,
          transparent 1px,
          transparent ${rowH}px) !important;
        background-size: 4px ${rowH}px !important;
        background-position: right top !important;
        background-repeat: repeat-y !important;
      }
    `;
    return true;
  }

  // GCal positions chips with inline 'top: Xpx; height: Ypx' against its own
  // px-per-hour, which equals .sJ9Raf's rendered height. Convert to a percentage
  // of the *natural* day (24 × that ruler) so chips resolve to the right fraction
  // regardless of what cell height our CSS has imposed.
  //
  // GCal positions chips at (ideal_top - 1) and (ideal_height - 2) so
  // consecutive chips have a small visual gap. Add 1 to top so chip-top lands
  // exactly on the hour line; leave height alone so the bottom keeps GCal's
  // 2px gap to the next event.
  const TOP_PX_OFFSET = 1;
  const HEIGHT_PX_OFFSET = 0;
  function processChip(el) {
    const ts = el.style.top;
    const hs = el.style.height;
    if (!ts || !hs) return;
    if (ts.endsWith('%') && hs.endsWith('%')) return;
    const t = parseFloat(ts);
    const h = parseFloat(hs);
    if (Number.isNaN(t) || Number.isNaN(h)) return;
    const ruler = document.querySelector(SEL.hourRuler);
    const oneHour = ruler?.getBoundingClientRect().height || NATURAL_HOUR_PX;
    if (oneHour <= 0) return;
    const dayPx = oneHour * 24;
    el.style.top = ((t + TOP_PX_OFFSET) / dayPx * 100).toFixed(4) + '%';
    el.style.height = ((h + HEIGHT_PX_OFFSET) / dayPx * 100).toFixed(4) + '%';
  }

  function startObserver() {
    if (observer) observer.disconnect();
    // Observe document.body (never replaced) instead of [role="main"], which
    // GCal swaps out when toggling between month and week/day views.
    const root = document.body;
    observer = new MutationObserver((muts) => {
      let needsApply = false;
      for (const m of muts) {
        if (m.type === 'attributes' && m.target instanceof Element && m.target.matches(SEL.eventChip)) {
          // GCal re-wrote a chip's inline style — convert it back to %.
          processChip(m.target);
        } else if (m.type === 'childList' && (m.addedNodes.length || m.removedNodes.length)) {
          needsApply = true;
        }
      }
      if (needsApply) scheduleApply();
    });
    observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['style'],
    });
  }

  function scheduleApply() {
    cancelAnimationFrame(applyRaf);
    applyRaf = requestAnimationFrame(applyCss);
  }

  function onResize() {
    cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(() => {
      lastTarget = -1; // force recompute on window resize
      applyCss();
    });
  }

  function tryStart() {
    if (!applyCss()) {
      setTimeout(tryStart, 200);
      return;
    }
    startObserver();
    window.addEventListener('resize', onResize, { passive: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', tryStart, { once: true });
  } else {
    tryStart();
  }
})();
