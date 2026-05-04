// ==UserScript==
// @name         Google Calendar — Fit Week to Viewport
// @namespace    https://github.com/hgabreu/userscripts
// @version      0.4.1
// @description  Compresses the week/day timed grid so all 24 hours fit the viewport without scrolling.
// @match        https://calendar.google.com/*
// @run-at       document-idle
// @grant        none
// @license      MIT
// ==/UserScript==

(function () {
  'use strict';

  const VERSION = '0.4.1';
  console.log('[gcal-height]', VERSION, 'loaded at', new Date().toISOString());
  if (window.__gcalFitWeekInstalled) {
    console.log('[gcal-height]', VERSION, 'skipping — already installed:', window.__gcalFitWeekInstalled);
    return;
  }
  window.__gcalFitWeekInstalled = VERSION;

  // GCal ships hashed CSS class names that rotate every few months. Instead of
  // pinning the script to those class names, we discover each structural anchor
  // by stable signals (ARIA roles, child counts, scrollability, data-*) and
  // tag the elements with our own data-attribute. CSS then targets the tags,
  // not GCal's classes — so a class rotation no longer breaks the script.
  const ROLE_ATTR = 'data-gcal-fit-week';
  const R = {
    scrollContainer: 'scroll-container',
    innerRow: 'inner-row',
    dayCell: 'day-cell',
    timeColumn: 'time-column',
    hourRuler: 'hour-ruler',
    labelsViewport: 'labels-viewport',
    labelsColumn: 'labels-column',
    labelsColumnLast: 'labels-column-last',
  };
  const tag = (name) => `[${ROLE_ATTR}="${name}"]`;
  const SEL = {
    scrollContainer: tag(R.scrollContainer),
    innerRow: tag(R.innerRow),
    dayCell: tag(R.dayCell),
    timeColumn: tag(R.timeColumn),
    hourRuler: tag(R.hourRuler),
    labelsViewport: tag(R.labelsViewport),
    labelsColumn: tag(R.labelsColumn),
    labelsColumnLast: tag(R.labelsColumnLast),
    // Hour labels: every direct child of any tagged labels column.
    hourLabel: `${tag(R.labelsColumn)} > *, ${tag(R.labelsColumnLast)} > *`,
    // Anything in the timed grid that GCal positions with inline `top: Xpx`.
    // Covers event chips (which also have inline `height: Ypx`, marked with
    // [data-eventchip]) and the now-line + now-dot indicators (top only). All
    // need px → % conversion or they fall outside the compressed day cell and
    // get clipped.
    inlinePositioned: `${tag(R.innerRow)} [style*="top:"]`,
  };
  const NATURAL_HOUR_PX = 60;
  const NATURAL_DAY_PX = NATURAL_HOUR_PX * 24; // 1440
  const STYLE_ID = 'gcal-fit-week-style';

  let styleEl = null;
  let observer = null;
  let resizeRaf = 0;
  let applyRaf = 0;
  let lastTarget = -1;
  let lastInnerRowW = -1;
  let cachedAnchors = null;
  let lastDiscoveryError = null;

  function ensureStyle() {
    if (styleEl && styleEl.isConnected) return styleEl;
    styleEl = document.createElement('style');
    styleEl.id = STYLE_ID;
    document.head.appendChild(styleEl);
    return styleEl;
  }

  // ---------- discovery ----------

  function isScrollableY(el) {
    const cs = getComputedStyle(el);
    return /(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 1;
  }

  function discover() {
    // 1. Main week grid: the [role=grid] DIV with [role=row] children.
    //    (Excludes the mini-calendar, which is a TABLE with no [role=row].)
    const grid = [...document.querySelectorAll('[role="grid"]')].find(
      (g) => g.tagName === 'DIV' && g.querySelectorAll('[role="row"]').length >= 2,
    );
    if (!grid) return null;

    // 2. Timed row: the row whose direct children include [role=gridcell].
    //    (Header and all-day rows nest gridcells deeper or have none.)
    const timedRow = [...grid.querySelectorAll('[role="row"]')].find(
      (r) => r.querySelector(':scope > [role="gridcell"]'),
    );
    if (!timedRow) return null;

    // 3. Day cells: 1 in day view, 7 in week view.
    const dayCells = [...timedRow.querySelectorAll(':scope > [role="gridcell"]')];
    if (dayCells.length < 1 || dayCells.length > 7) return null;

    // 4. Time column: the non-gridcell child of timedRow with 24 equal-height
    //    children. GCal uses one of those as its px-per-hour ruler.
    let timeColumn = null;
    for (const c of timedRow.children) {
      if (c.getAttribute('role') === 'gridcell') continue;
      if (c.children.length !== 24) continue;
      const heights = [...c.children].map((h) => h.getBoundingClientRect().height);
      const h0 = heights[0];
      if (h0 > 0 && heights.every((h) => Math.abs(h - h0) < 1)) {
        timeColumn = c;
        break;
      }
    }
    if (!timeColumn) return null;
    const hourRuler = timeColumn.firstElementChild;

    // 5. Scroll container: closest scrollable ancestor of timedRow.
    let scrollContainer = timedRow.parentElement;
    while (scrollContainer && !isScrollableY(scrollContainer)) {
      scrollContainer = scrollContainer.parentElement;
    }
    if (!scrollContainer) return null;

    // 6. Labels viewport: a sibling of the scroll container that holds one or
    //    more columns of 24+ equal-height children (the hour-label columns,
    //    one per timezone). Optional — script still works if missing.
    let labelsViewport = null;
    let labelsColumns = [];
    if (scrollContainer.parentElement) {
      for (const sib of scrollContainer.parentElement.children) {
        if (sib === scrollContainer) continue;
        const cols = [...sib.children].filter((c) => c.children.length >= 24);
        if (cols.length >= 1) {
          labelsViewport = sib;
          labelsColumns = cols;
          break;
        }
      }
    }

    return { grid, timedRow, dayCells, timeColumn, hourRuler, scrollContainer, labelsViewport, labelsColumns };
  }

  function validate(found) {
    if (!found) return 'discover() returned null';
    if (!found.scrollContainer.isConnected) return 'scrollContainer detached';
    if (found.timeColumn.children.length !== 24) {
      return `timeColumn has ${found.timeColumn.children.length} children, expected 24`;
    }
    if (found.hourRuler.getBoundingClientRect().height <= 0) return 'hourRuler has zero height';
    if (found.dayCells.length < 1 || found.dayCells.length > 7) {
      return `unexpected dayCells count: ${found.dayCells.length}`;
    }
    return null;
  }

  function clearTags(found) {
    if (!found) return;
    [found.scrollContainer, found.timedRow, found.timeColumn, found.hourRuler, found.labelsViewport]
      .forEach((el) => el && el.removeAttribute(ROLE_ATTR));
    found.dayCells.forEach((d) => d.removeAttribute(ROLE_ATTR));
    found.labelsColumns.forEach((c) => c.removeAttribute(ROLE_ATTR));
  }

  function applyTags(found) {
    found.scrollContainer.setAttribute(ROLE_ATTR, R.scrollContainer);
    found.timedRow.setAttribute(ROLE_ATTR, R.innerRow);
    found.timeColumn.setAttribute(ROLE_ATTR, R.timeColumn);
    found.hourRuler.setAttribute(ROLE_ATTR, R.hourRuler);
    found.dayCells.forEach((d) => d.setAttribute(ROLE_ATTR, R.dayCell));
    if (found.labelsViewport) found.labelsViewport.setAttribute(ROLE_ATTR, R.labelsViewport);
    // Tag the rightmost labels column distinctly so we can draw the hour-line
    // tick only on the column adjacent to Sunday — without depending on
    // sibling-only structure (in case GCal interleaves siblings).
    found.labelsColumns.forEach((c, i) => {
      const isLast = i === found.labelsColumns.length - 1;
      c.setAttribute(ROLE_ATTR, isLast ? R.labelsColumnLast : R.labelsColumn);
    });
  }

  function anchorsAreLive(a) {
    if (!a) return false;
    if (!a.scrollContainer.isConnected) return false;
    if (!a.timedRow.isConnected) return false;
    if (a.dayCells.length === 0 || !a.dayCells.every((d) => d.isConnected)) return false;
    return true;
  }

  function getAnchors() {
    if (anchorsAreLive(cachedAnchors)) return cachedAnchors;
    const override = window.__gcalFitWeekConfig?.discover;
    const found = (typeof override === 'function' && override()) || discover();
    if (!found) {
      // No grid present (e.g., month view). Don't error — just bail quietly.
      if (cachedAnchors) clearTags(cachedAnchors);
      cachedAnchors = null;
      return null;
    }
    const err = validate(found);
    if (err) {
      if (err !== lastDiscoveryError) {
        console.error('[gcal-height]', VERSION, 'DOM shape changed —', err, '— bailing. Override via window.__gcalFitWeekConfig.discover().');
        lastDiscoveryError = err;
      }
      if (cachedAnchors) clearTags(cachedAnchors);
      cachedAnchors = null;
      return null;
    }
    lastDiscoveryError = null;
    if (cachedAnchors && cachedAnchors.scrollContainer !== found.scrollContainer) {
      clearTags(cachedAnchors);
    }
    applyTags(found);
    cachedAnchors = found;
    return found;
  }

  // ---------- measurement & CSS ----------

  function measure() {
    const a = getAnchors();
    if (!a) return null;
    const top = a.scrollContainer.getBoundingClientRect().top;
    const target = window.innerHeight - top - 4;
    if (target <= 0) return null;
    return { target, scale: target / NATURAL_DAY_PX };
  }

  // Force the timed-grid day cells to match the all-day strip's cell widths so
  // the vertical day-separators land on the same X coordinates above and below
  // the boundary. Without this, GCal's flex distribution gives the two rows
  // slightly different fractional widths — and where the fractional offsets
  // round to different pixel columns, the 1px borders show a visible kink at
  // the all-day boundary (typically appearing on a few of the rightmost days
  // and shifting around as the viewport is resized).
  //
  // Applied as inline styles (not stylesheet rules) because each cell needs
  // its own width — emitting N CSS rules with structural selectors would be
  // brittle if GCal's child ordering shifted.
  function alignDayCellWidths(a) {
    // Re-find the all-day row fresh each call — GCal replaces this row's
    // subtree during lazy hydration, so any reference cached during discover()
    // becomes detached even though .isConnected may still report true.
    if (!a.timedRow.isConnected) return;
    const grid = a.timedRow.closest('[role="grid"]');
    if (!grid) return;
    const rows = [...grid.querySelectorAll('[role="row"]')];
    const idx = rows.indexOf(a.timedRow);
    if (idx <= 0) return;
    const allDayRow = rows[idx - 1];
    const allDayCells = [...allDayRow.querySelectorAll('[role="gridcell"]')];
    if (allDayCells.length !== a.dayCells.length) return;
    a.dayCells.forEach((d, i) => {
      const w = allDayCells[i].getBoundingClientRect().width;
      if (w <= 0) return;
      const v = w + 'px';
      d.style.setProperty('width', v, 'important');
      d.style.setProperty('min-width', v, 'important');
      d.style.setProperty('max-width', v, 'important');
      d.style.setProperty('flex', `0 0 ${v}`, 'important');
    });
  }

  function applyCss() {
    const m = measure();
    if (!m) return false;
    document.querySelectorAll(SEL.inlinePositioned).forEach(processInlinePositioned);
    // Re-align widths on every apply — the all-day cells may lazy-render after
    // the initial pass, and they re-flow on width changes.
    alignDayCellWidths(cachedAnchors);
    // Use scroll container's clientWidth — innerRow's width here is fed by
    // our own forced cell widths and wouldn't change on viewport shrinks.
    const containerW = cachedAnchors.scrollContainer.clientWidth;
    if (Math.abs(m.target - lastTarget) < 1 && Math.abs(containerW - lastInnerRowW) < 1) return true;
    lastTarget = m.target;
    lastInnerRowW = containerW;
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
      ${SEL.labelsColumn},
      ${SEL.labelsColumnLast} {
        height: ${totalH}px !important;
        min-height: ${totalH}px !important;
      }
      ${SEL.hourLabel} {
        height: ${rowH}px !important;
        min-height: ${rowH}px !important;
        max-height: ${rowH}px !important;
      }
      /* Don't touch the hour-cell height — GCal uses its rendered height as
         the px-per-hour ruler for chip positioning, and stretching it confuses
         chip top values that were computed against the previous ruler.
         Instead, hide the native grid-lines (which only fill the top 960px
         of a stretched cell) on every hour cell and draw our own via a
         background pattern. Must target all 24 children of timeColumn — not
         just the first one tagged as hour-ruler — or 23 of GCal's 80px-pitch
         lines remain visible under our compressed lines, producing a double
         grid where the two cadences only intersect at hour 0. */
      ${SEL.timeColumn} > *::after { border-bottom-width: 0 !important; }
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
         (adjacent to Sunday). The labels columns have an opaque background
         that would cover a gradient on the viewport, so we draw on the column
         instead. Width is small enough to leave a clear gap between the label
         text and the tick — the tick should visually connect to the day-cell
         grid-line, not to the label. */
      ${SEL.labelsColumnLast} {
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
  // px-per-hour, which equals the hour-ruler's rendered height. Convert to a
  // percentage of the *natural* day (24 × that ruler) so chips resolve to the
  // right fraction regardless of what cell height our CSS has imposed.
  //
  // The same conversion applies to the "now" indicator (red horizontal line +
  // dot), which GCal positions with inline `top: Xpx` (no inline height).
  // Without this conversion the indicator falls outside our compressed day
  // cell and gets clipped.
  //
  // For chips, GCal sets top = ideal - 1 and height = ideal - 2 so consecutive
  // chips have a small visual gap. Add 1 to chip top so chip-top lands exactly
  // on the hour line; leave height alone so the bottom keeps GCal's 2px gap.
  // The now-line/dot have no such offset — their inline top is exact.
  const CHIP_TOP_PX_OFFSET = 1;
  const CHIP_HEIGHT_PX_OFFSET = 0;
  function processInlinePositioned(el) {
    const ts = el.style.top;
    if (!ts || ts.endsWith('%')) return;
    const t = parseFloat(ts);
    if (Number.isNaN(t)) return;
    const ruler = cachedAnchors?.hourRuler ?? document.querySelector(SEL.hourRuler);
    const oneHour = ruler?.getBoundingClientRect().height || NATURAL_HOUR_PX;
    if (oneHour <= 0) return;
    const dayPx = oneHour * 24;
    const isChip = el.hasAttribute('data-eventchip');
    const topOff = isChip ? CHIP_TOP_PX_OFFSET : 0;
    el.style.top = ((t + topOff) / dayPx * 100).toFixed(4) + '%';
    // Convert inline height too, but only if GCal set it in px. The now-line
    // and dot have height set via CSS class (not inline) — leave those alone.
    const hs = el.style.height;
    if (hs && !hs.endsWith('%')) {
      const h = parseFloat(hs);
      if (!Number.isNaN(h)) {
        el.style.height = ((h + CHIP_HEIGHT_PX_OFFSET) / dayPx * 100).toFixed(4) + '%';
      }
    }
  }

  function startObserver() {
    if (observer) observer.disconnect();
    // Observe document.body (never replaced) instead of [role="main"], which
    // GCal swaps out when toggling between month and week/day views.
    const root = document.body;
    observer = new MutationObserver((muts) => {
      let needsApply = false;
      for (const m of muts) {
        if (m.type === 'attributes' && m.target instanceof Element && m.target.matches(SEL.inlinePositioned)) {
          processInlinePositioned(m.target);
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
      lastTarget = -1;
      lastInnerRowW = -1;
      applyCss();
    });
  }

  function tryStart() {
    if (!applyCss()) {
      setTimeout(tryStart, 200);
      return;
    }
    console.log('[gcal-height]', VERSION, 'anchors discovered:', {
      dayCells: cachedAnchors.dayCells.length,
      labelsColumns: cachedAnchors.labelsColumns.length,
      hourPx: cachedAnchors.hourRuler.getBoundingClientRect().height,
    });
    startObserver();
    window.addEventListener('resize', onResize, { passive: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', tryStart, { once: true });
  } else {
    tryStart();
  }
})();
