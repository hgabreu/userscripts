# Userscripts

Personal Tampermonkey scripts. Each is a single self-contained `*.user.js` you can install in any [Tampermonkey](https://www.tampermonkey.net/)-compatible extension.

## Install (for any of these)

Open the script's link below in a browser that has Tampermonkey installed — it'll detect the `==UserScript==` header and offer **Install**. Tampermonkey will check for updates against the same URL automatically.

---

## `gcal-height.user.js` — Fit Google Calendar's week view to the viewport

[Install →](https://raw.githubusercontent.com/hgabreu/userscripts/main/gcal-height.user.js)

Sets Google Calendar's week/day timed-grid so all 24 hours fit the viewport without scrolling. Resizes the day cells to fill `viewport_height − chrome`, repositions every event chip to the correct fractional time, redraws hour grid-lines at the new spacing. Works in Week and Day views.

---

## `gcal-year.user.js` — Year-timeline view for Google Calendar

[Install →](https://raw.githubusercontent.com/hgabreu/userscripts/main/gcal-year.user.js)

Adds a custom year-timeline view that shows full-day events across the whole year on one screen. Useful for yearly planning, like vacations, travel, recurring events, anything where seeing twelve months at once matters.

Tip: use the browser back button, or Calendar's keyboard shortcuts to switch back to other views: `w` for week, `y` for year, etc.

---

## License

[MIT](./LICENSE) — do whatever, no warranty.
