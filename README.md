# Userscripts

Personal Tampermonkey scripts. Each is a single self-contained `*.user.js` you can install in any [Tampermonkey](https://www.tampermonkey.net/)-compatible extension.

## Install (for any of these)

Open the script's link below in a browser that has Tampermonkey installed — it'll detect the `==UserScript==` header and offer **Install**. Tampermonkey will check for updates against the same URL automatically.

---

## `gcal-height.user.js` — Fit Google Calendar's week view to the viewport

[Install →](./gcal-height.user.js)

Compresses Google Calendar's week/day timed-grid so all 24 hours fit the viewport without scrolling. Stretches the day cells to fill `viewport_height − chrome`, repositions every event chip to the correct fractional time, redraws hour grid-lines at the new spacing, and adds a small tick from the labels into the grid so the visual reading stays clear.

**Highlights:**
- Works at any viewport size — listens for resize and re-applies.
- Survives view changes (week ↔ day ↔ month) and week navigation.
- Compatible with GCal's "Compact" and "Responsive" density settings.
- Multiple-timezone columns are preserved.

**Limitations:**
- Week and day views only. Month/year/agenda views are untouched.
- Class names like `.mDPmMe`, `.GTG3wb`, `.sJ9Raf`, `.BiKU4b` are GCal's hashed names. If a deploy rotates them and the layout breaks, the `SEL` object at the top of the script is the only thing to update.

---

## `gcal-year.user.js` — Year-timeline view for Google Calendar

[Install →](./gcal-year.user.js)

Adds a custom year-timeline view that shows full-day events across the whole year on one screen. Useful for yearly planning, like vacations, travel, recurring events, anything where seeing twelve months at once matters.
