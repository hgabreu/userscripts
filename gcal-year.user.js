// ==UserScript==
// @name         Google Calendar Year Timeline View
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Custom timeline view for Google Calendar year view with full-day events
// @author       Henrique Abreu
// @match        https://calendar.google.com/calendar/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function() {
    'use strict';
    // Bypass Trusted Types for Google Calendar
    if (window.trustedTypes && window.trustedTypes.createPolicy) {
        try {
            window.trustedTypes.createPolicy('default', {
                createHTML: (string) => string,
                createScriptURL: (string) => string,
                createScript: (string) => string,
            });
        } catch (e) {
            // Policy might already exist, ignore
        }
    }

    console.log('� Google Calendar Timeline - Tampermonkey loaded');

    const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const DAY_NAMES = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

    let isTimelineActive = false;
    let timelineData = null;
    let currentYear = null;
    let resizeHandler = null;

    // Get the year from the URL
    function getYearFromURL() {
        const hash = window.location.hash;
        const href = window.location.href;

        // Try to extract year from hash like #year/2026
        const hashMatch = hash.match(/\/year\/(\d{4})/);
        if (hashMatch) {
            return parseInt(hashMatch[1]);
        }

        // Try from full URL
        const urlMatch = href.match(/\/year\/(\d{4})/);
        if (urlMatch) {
            return parseInt(urlMatch[1]);
        }

        // Default to current year
        return new Date().getFullYear();
    }

    // Check if we're in year view
    function isYearView() {
        const hash = window.location.hash;
        const href = window.location.href;

        // Debug logging
        console.log('� Checking view - hash:', hash);

        // Check various patterns for year view
        return hash.includes('/year/') ||
               hash.includes('/year') ||
               hash.startsWith('#year') ||
               href.includes('/year/') ||
               href.includes('/year');
    }

    // Load gapi if not already loaded
    async function loadGapi() {
        if (typeof gapi !== 'undefined') {
            return;
        }

        return new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = "https://apis.google.com/js/api.js";
            script.onload = () => resolve();
            script.onerror = reject;
            document.head.appendChild(script);
        });
    }

    // Initialize calendar client
    async function initCalendarClient() {
        return new Promise((resolve, reject) => {
            gapi.load('client', async () => {
                try {
                    await gapi.client.init({
                        discoveryDocs: ["https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest"],
                    });
                    resolve();
                } catch (error) {
                    reject(error);
                }
            });
        });
    }

    // Get list of visible calendars
    async function getVisibleCalendars() {
        try {
            const response = await gapi.client.calendar.calendarList.list();
            const allCalendars = response.result.items || [];
            const visibleCalendars = allCalendars.filter(cal => cal.selected !== false);
            return visibleCalendars;
        } catch (error) {
            console.error('❌ Error fetching calendar list:', error);
            return [];
        }
    }

    // Fetch full-day events from a specific calendar
    async function fetchEventsFromCalendar(calendarId, calendarName, calendarColor, year) {
        const startOfYear = new Date(year, 0, 1).toISOString();
        const endOfYear = new Date(year, 11, 31, 23, 59, 59).toISOString();

        try {
            const response = await gapi.client.calendar.events.list({
                'calendarId': calendarId,
                'timeMin': startOfYear,
                'timeMax': endOfYear,
                'singleEvents': true,
                'maxResults': 2500,
                'orderBy': 'startTime'
            });

            const allEvents = response.result.items || [];
            const fullDayEvents = allEvents.filter(event => event.start.date);

            fullDayEvents.forEach(event => {
                event._calendarColor = calendarColor;
                event._calendarId = calendarId;
                event._calendarName = calendarName;
            });

            return fullDayEvents;
        } catch (error) {
            console.error(`❌ Error fetching from ${calendarName}:`, error);
            return [];
        }
    }

    // Fetch full-day events from all visible calendars
    async function fetchFullDayEvents(year) {
        const calendars = await getVisibleCalendars();
        if (calendars.length === 0) {
            return null;
        }

        const allEventPromises = calendars.map(cal =>
            fetchEventsFromCalendar(cal.id, cal.summary, cal.backgroundColor, year)
        );

        const eventsArrays = await Promise.all(allEventPromises);

        const eventsByCalendar = {};
        calendars.forEach((cal, index) => {
            eventsByCalendar[cal.id] = {
                name: cal.summary,
                color: cal.backgroundColor,
                events: eventsArrays[index]
            };
        });

        const allEvents = eventsArrays.flat();

        return { allEvents, eventsByCalendar, calendars };
    }

    // Google Calendar color mapping
    function getEventColor(colorId) {
        const colors = {
            '1': '#a4bdfc', '2': '#7ae7bf', '3': '#dbadff', '4': '#ff887c',
            '5': '#fbd75b', '6': '#ffb878', '7': '#46d6db', '8': '#e1e1e1',
            '9': '#5484ed', '10': '#51b749', '11': '#dc2127',
        };
        return colors[colorId] || '#039be5';
    }

    // Determine if a color is light (returns true) or dark (returns false)
    function isLightColor(color) {
        // Convert hex to RGB
        const hex = color.replace('#', '');
        const r = parseInt(hex.substr(0, 2), 16);
        const g = parseInt(hex.substr(2, 2), 16);
        const b = parseInt(hex.substr(4, 2), 16);

        // Calculate relative luminance using the formula from WCAG
        const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;

        // Return true if light (luminance > 0.5)
        return luminance > 0.5;
    }

    // Convert API event to our format
    // Returns an array of event segments (one per month if event spans multiple months)
    function convertEvent(apiEvent, targetYear) {
        // Parse date strings manually to avoid timezone issues
        // Google Calendar returns dates as "YYYY-MM-DD" for all-day events
        const [startYear, startMonth, startDay] = apiEvent.start.date.split('-').map(Number);
        const [endYear, endMonth, endDay] = apiEvent.end.date.split('-').map(Number);

        // Google Calendar end dates are exclusive (e.g., an event on March 27 has end date March 28)
        // Create a date object to handle month rollover when subtracting 1 day
        const adjustedEndDate = new Date(endYear, endMonth - 1, endDay - 1);
        const actualEndMonth = adjustedEndDate.getMonth() + 1;
        const actualEndDay = adjustedEndDate.getDate();
        const actualEndYear = adjustedEndDate.getFullYear();

        let color = apiEvent._calendarColor || '#039be5';
        if (apiEvent.colorId) {
            color = getEventColor(apiEvent.colorId);
        }

        // Check if event spans multiple months
        if (startMonth === actualEndMonth && startYear === actualEndYear) {
            // Single month event - only include if it's in the target year
            if (startYear !== targetYear) {
                return [];
            }
            return [{
                id: apiEvent.id,
                title: apiEvent.summary || 'Untitled',
                month: startMonth,
                startDay: startDay,
                endDay: actualEndDay,
                color: color,
                htmlLink: apiEvent.htmlLink || '',
                calendarId: apiEvent._calendarId || '',
                calendarName: apiEvent._calendarName || '',
                apiEventId: apiEvent.id
            }];
        } else {
            // Multi-month event - split into segments
            const segments = [];
            const startDate = new Date(startYear, startMonth - 1, startDay);
            const endDate = new Date(adjustedEndDate);

            let currentDate = new Date(startDate);

            while (currentDate <= endDate) {
                const currentMonth = currentDate.getMonth() + 1;
                const currentYear = currentDate.getFullYear();
                const daysInMonth = new Date(currentYear, currentMonth, 0).getDate();

                // Only include segments for the target year
                if (currentYear === targetYear) {
                    const segmentStartDay = currentDate.getDate();
                    let segmentEndDay;

                    // Check if this is the last month
                    if (currentYear === actualEndYear && currentMonth === actualEndMonth) {
                        segmentEndDay = actualEndDay;
                    } else {
                        segmentEndDay = daysInMonth;
                    }

                    segments.push({
                        id: apiEvent.id + '_' + currentYear + '_' + currentMonth,
                        title: apiEvent.summary || 'Untitled',
                        month: currentMonth,
                        startDay: segmentStartDay,
                        endDay: segmentEndDay,
                        color: color,
                        htmlLink: apiEvent.htmlLink || '',
                        calendarId: apiEvent._calendarId || '',
                        calendarName: apiEvent._calendarName || '',
                        apiEventId: apiEvent.id
                    });
                }

                // Move to first day of next month
                currentDate = new Date(currentYear, currentMonth, 1);
            }

            return segments;
        }
    }

    // Get day of week
    function getDayOfWeek(year, month, day) {
        return new Date(year, month - 1, day).getDay();
    }

    // Get week of month
    function getWeekOfMonth(year, month, day) {
        const firstDay = new Date(year, month - 1, 1);
        const firstDayOfWeek = firstDay.getDay();
        const daysSinceFirst = day - 1;
        const totalDaysFromSunday = firstDayOfWeek + daysSinceFirst;
        return Math.floor(totalDaysFromSunday / 7);
    }

    // Get weeks in month
    function getWeeksInMonth(year, month) {
        const daysInMonth = new Date(year, month, 0).getDate();
        return getWeekOfMonth(year, month, daysInMonth) + 1;
    }

    // Group events by month
    function groupEventsByMonth(events) {
        const grouped = {};
        for (let m = 1; m <= 12; m++) grouped[m] = [];
        events.forEach(event => {
            if (event.month >= 1 && event.month <= 12) {
                grouped[event.month].push(event);
            }
        });
        return grouped;
    }

    // Reposition events based on actual cell widths after rendering
    function repositionEvents() {
        // Get all month rows
        const monthRows = document.querySelectorAll('#timeline-grid > div > div');

        monthRows.forEach(monthRow => {
            // Get all day cells in this row
            const dayCells = monthRow.querySelectorAll('.day-cell');
            if (dayCells.length === 0) return;

            // Calculate actual cell widths and positions
            const cellPositions = [];
            dayCells.forEach((cell, index) => {
                const rect = cell.getBoundingClientRect();
                const parentRect = cell.parentElement.getBoundingClientRect();
                cellPositions.push({
                    left: rect.left - parentRect.left,
                    width: rect.width
                });
            });

            // Get all events in this month row
            const events = monthRow.querySelectorAll('.timeline-event');
            events.forEach(event => {
                const startCol = parseInt(event.dataset.startCol);
                const endCol = parseInt(event.dataset.endCol);

                if (cellPositions[startCol] && cellPositions[endCol]) {
                    const leftPx = cellPositions[startCol].left + 1;
                    const rightPx = cellPositions[endCol].left + cellPositions[endCol].width;
                    const widthPx = rightPx - leftPx - 2;

                    event.style.left = leftPx + 'px';
                    event.style.width = widthPx + 'px';
                }
            });
        });
    }

    // Build timeline HTML
    function buildTimelineHTML(eventsByMonth, year) {
        const html = [];
        const cellWidth = 40;
        const monthColumnWidth = 24;

        let maxWeeks = 0;
        for (let m = 1; m <= 12; m++) {
            const weeks = getWeeksInMonth(year, m);
            if (weeks > maxWeeks) maxWeeks = weeks;
        }

        let maxUsedCol = 0;
        for (let m = 1; m <= 12; m++) {
            const daysInMonth = new Date(year, m, 0).getDate();
            const lastWeek = getWeekOfMonth(year, m, daysInMonth);
            const lastDow = getDayOfWeek(year, m, daysInMonth);
            const lastCol = lastWeek * 7 + lastDow;
            if (lastCol > maxUsedCol) maxUsedCol = lastCol;
        }

        const totalColumns = maxUsedCol + 1;
        const weeksToShow = maxWeeks;

        html.push(`
            <div style="
                background: #2d2d2d;
                border-radius: 0;
                box-shadow: 0 4px 6px rgba(0,0,0,0.3);
                padding: 0;
                min-width: ${monthColumnWidth + totalColumns * cellWidth}px;
                width: 100%;
                display: flex;
                flex-direction: column;
            ">
        `);

        // Day name headers
        html.push(`
            <div style="display: flex; margin-bottom: 2px; border-bottom: 1px solid #404040; padding-bottom: 2px; flex-wrap: nowrap; flex: 1;">
                <div style="width: ${monthColumnWidth}px; min-width: ${monthColumnWidth}px; flex-shrink: 0; font-weight: 600; font-size: 12px; color: #909090; border-right: 1px solid transparent; box-sizing: border-box;"></div>
                <div style="display: flex; flex: 1; min-width: ${totalColumns * cellWidth}px; flex-wrap: nowrap;">
        `);

        let colIndex = 0;
        for (let week = 0; week < weeksToShow; week++) {
            for (let dow = 0; dow < 7; dow++) {
                if (colIndex >= totalColumns) break;

                const isFirstCell = colIndex === 0;
                const isWeekBoundary = week > 0 && dow === 0;
                const isWeekend = dow === 0 || dow === 6;
                const borderLeft = isFirstCell ? 'none' : (isWeekBoundary ? '2px solid #404040' : '1px solid #383838');

                html.push(`
                    <div style="
                        min-width: ${cellWidth}px;
                        flex: 1;
                        text-align: center;
                        font-size: 10px;
                        font-weight: 500;
                        padding: 0;
                        color: ${isWeekend ? '#8ab4f8' : '#b0b0b0'};
                        border-left: ${borderLeft};
                        box-sizing: border-box;
                    ">${DAY_NAMES[dow]}</div>
                `);
                colIndex++;
            }
            if (colIndex >= totalColumns) break;
        }

        html.push('</div></div>');

        // Month rows
        for (let month = 1; month <= 12; month++) {
            const monthEvents = eventsByMonth[month] || [];
            const weeksInMonth = getWeeksInMonth(year, month);

            // Calculate row height based on overlap
            monthEvents.forEach(event => {
                let row = 0;
                const usedRows = monthEvents.filter(e => e._row !== undefined);

                while (true) {
                    const hasOverlap = usedRows.some(existing => {
                        if (existing._row !== row) return false;
                        return !(event.endDay < existing.startDay || event.startDay > existing.endDay);
                    });

                    if (!hasOverlap) {
                        event._row = row;
                        break;
                    }
                    row++;
                }
            });

            const maxRow = Math.max(0, ...monthEvents.map(e => e._row || 0));
            const actualRows = maxRow + 1;
            const eventHeight = 18;
            const rowHeight = Math.max(50, 26 + (actualRows * (eventHeight + 2)));

            html.push(`
                <div style="
                    display: flex;
                    margin-bottom: 2px;
                    min-height: ${rowHeight}px;
                    position: relative;
                    border-top: 1px solid #404040;
                    flex-wrap: nowrap;
                    flex: 1;
                ">
                    <div style="
                        width: ${monthColumnWidth}px;
                        min-width: ${monthColumnWidth}px;
                        flex-shrink: 0;
                        font-weight: 500;
                        font-size: 11px;
                        padding: 8px 0;
                        background: #252525;
                        color: #e0e0e0;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        border-right: 1px solid #404040;
                        box-sizing: border-box;
                        writing-mode: vertical-rl;
                        text-orientation: upright;
                        letter-spacing: -2px;
                    ">${MONTH_NAMES[month - 1]}</div>
                    <div style="display: flex; flex: 1; min-width: ${totalColumns * cellWidth}px; flex-wrap: nowrap; position: relative; background: #2d2d2d;">
            `);

            const daysInMonth = new Date(year, month, 0).getDate();

            colIndex = 0;
            for (let week = 0; week < weeksToShow; week++) {
                for (let dow = 0; dow < 7; dow++) {
                    if (colIndex >= totalColumns) break;

                    let dayOfMonth = null;
                    if (week < weeksInMonth) {
                        for (let d = 1; d <= daysInMonth; d++) {
                            if (getWeekOfMonth(year, month, d) === week && getDayOfWeek(year, month, d) === dow) {
                                dayOfMonth = d;
                                break;
                            }
                        }
                    }

                    const isFirstCell = colIndex === 0;
                    const isWeekBoundary = week > 0 && dow === 0;
                    const isWeekend = dow === 0 || dow === 6;

                    // Check if this is today
                    const today = new Date();
                    const isToday = dayOfMonth &&
                                    today.getFullYear() === year &&
                                    today.getMonth() + 1 === month &&
                                    today.getDate() === dayOfMonth;

                    let bgColor;
                    if (isToday) {
                        bgColor = '#1a3a52';  // Blue-tinted background for today
                    } else if (!dayOfMonth) {
                        bgColor = '#1f1f1f';  // Empty cells
                    } else if (isWeekend) {
                        bgColor = '#353535';  // Weekend
                    } else {
                        bgColor = '#2d2d2d';  // Regular day
                    }

                    const borderLeft = isFirstCell ? 'none' : (isWeekBoundary ? '2px solid #404040' : '1px solid #383838');
                    const dayColor = isToday ? '#8ab4f8' : '#707070';
                    const dayWeight = isToday ? '700' : 'normal';
                    const todayBorder = isToday ? '2px solid #8ab4f8' : '';

                    // Build data-date attribute for valid day cells (YYYYMMDD format)
                    const dataDateAttr = dayOfMonth ? `data-date="${year}${String(month).padStart(2,'0')}${String(dayOfMonth).padStart(2,'0')}"` : '';

                    html.push(`
                        <div class="day-cell" data-col="${colIndex}" ${dataDateAttr} style="
                            min-width: ${cellWidth}px;
                            flex: 1;
                            border-left: ${borderLeft};
                            background: ${bgColor};
                            position: relative;
                            padding: 2px;
                            font-size: 10px;
                            color: ${dayColor};
                            font-weight: ${dayWeight};
                            box-sizing: border-box;
                            ${dayOfMonth ? 'cursor: pointer;' : ''}
                            ${todayBorder ? `border: ${todayBorder};` : ''}
                        ">
                            ${dayOfMonth ? dayOfMonth : ''}
                        </div>
                    `);
                    colIndex++;
                }
                if (colIndex >= totalColumns) break;
            }

            // Events overlay (pointer-events: none so day cells underneath remain clickable)
            html.push(`<div style="position: absolute; top: 14px; left: 0; right: 0; bottom: 4px; pointer-events: none;">`);

            monthEvents.forEach((event) => {
                const startWeek = getWeekOfMonth(year, month, event.startDay);
                const startDow = getDayOfWeek(year, month, event.startDay);
                const endWeek = getWeekOfMonth(year, month, event.endDay);
                const endDow = getDayOfWeek(year, month, event.endDay);

                const startCol = startWeek * 7 + startDow;
                const endCol = endWeek * 7 + endDow;
                const leftPx = startCol * cellWidth + 1;
                const widthPx = (endCol - startCol + 1) * cellWidth - 2;
                const topOffset = event._row * (eventHeight + 2);

                // Use black text for light colors, white text for dark colors
                const textColor = isLightColor(event.color) ? '#000000' : '#ffffff';

                html.push(`
                    <div class="timeline-event"
                         data-start-col="${startCol}"
                         data-end-col="${endCol}"
                         data-month="${month}"
                         data-event-id="${event.apiEventId || event.id}"
                         data-calendar-id="${event.calendarId || ''}"
                         data-calendar-name="${event.calendarName || ''}"
                         data-html-link="${event.htmlLink || ''}"
                         data-start-day="${event.startDay}"
                         data-end-day="${event.endDay}"
                         data-color="${event.color}"
                         style="
                        position: absolute;
                        left: ${leftPx}px;
                        top: ${topOffset}px;
                        width: ${widthPx}px;
                        height: ${eventHeight}px;
                        background: ${event.color};
                        border-radius: 3px;
                        font-size: 9px;
                        color: ${textColor};
                        padding: 2px 3px;
                        overflow: hidden;
                        text-overflow: ellipsis;
                        white-space: nowrap;
                        cursor: pointer;
                        pointer-events: auto;
                        box-shadow: 0 1px 2px rgba(0,0,0,0.2);
                        font-weight: 500;
                        box-sizing: border-box;
                    "
                    title="${event.title} (${MONTH_NAMES[month-1]} ${event.startDay}${event.endDay !== event.startDay ? '-' + event.endDay : ''})"
                    >${event.title}</div>
                `);
            });

            html.push('</div></div></div>');
        }

        html.push('</div>');
        return html.join('');
    }

    // Build calendar control panel
    function buildControlPanel(calendars, selectedCalendarIds, isFullscreen) {
        return `
            <div id="calendar-controls" style="
                background: #2d2d2d;
                border-bottom: 1px solid #404040;
                padding: 8px 12px;
                display: flex;
                align-items: center;
                gap: 12px;
                flex-wrap: wrap;
            ">
                <button id="fullscreen-toggle" style="
                    background: #404040;
                    border: none;
                    border-radius: 4px;
                    padding: 6px 12px;
                    color: #e0e0e0;
                    font-size: 11px;
                    font-weight: 600;
                    cursor: pointer;
                    display: flex;
                    align-items: center;
                    gap: 4px;
                    transition: background 0.2s;
                "
                onmouseover="this.style.background='#505050'"
                onmouseout="this.style.background='#404040'">
                    <span>${isFullscreen ? '⊗' : '⛶'}</span>
                    <span>${isFullscreen ? 'Exit Fullscreen' : 'Fullscreen'}</span>
                </button>
                <div style="width: 1px; height: 20px; background: #404040;"></div>
                <div style="color: #e0e0e0; font-size: 11px; font-weight: 600;">Calendars:</div>
                ${calendars.map(cal => `
                    <label style="
                        display: flex;
                        align-items: center;
                        gap: 4px;
                        cursor: pointer;
                        font-size: 11px;
                        color: #e0e0e0;
                    ">
                        <input
                            type="checkbox"
                            data-calendar-id="${cal.id}"
                            ${selectedCalendarIds.has(cal.id) ? 'checked' : ''}
                            style="cursor: pointer;"
                        />
                        <span style="
                            display: inline-block;
                            width: 12px;
                            height: 12px;
                            background: ${cal.backgroundColor};
                            border-radius: 2px;
                        "></span>
                        <span>${cal.summary}</span>
                    </label>
                `).join('')}
            </div>
        `;
    }

    // Save selected calendars to localStorage
    function saveSelectedCalendars(selectedCalendarIds) {
        const selectedArray = Array.from(selectedCalendarIds);
        localStorage.setItem('gcal_timeline_selected_calendars', JSON.stringify(selectedArray));
    }

    // Load selected calendars from localStorage
    function loadSelectedCalendars(availableCalendarIds) {
        try {
            const saved = localStorage.getItem('gcal_timeline_selected_calendars');
            if (saved) {
                const selectedArray = JSON.parse(saved);
                const validSelected = selectedArray.filter(id => availableCalendarIds.includes(id));
                if (validSelected.length > 0) {
                    return new Set(validSelected);
                }
            }
        } catch (e) {
            // Ignore errors
        }
        return new Set(availableCalendarIds);
    }

    // Save fullscreen preference
    function saveFullscreenPreference(isFullscreen) {
        localStorage.setItem('gcal_timeline_fullscreen', JSON.stringify(isFullscreen));
    }

    // Load fullscreen preference
    function loadFullscreenPreference() {
        try {
            const saved = localStorage.getItem('gcal_timeline_fullscreen');
            if (saved) {
                return JSON.parse(saved);
            }
        } catch (e) {
            // Ignore errors
        }
        return false;
    }

    // Toggle fullscreen mode
    function toggleFullscreen() {
        const container = document.getElementById('timeline-container');
        if (!container) return;

        const isCurrentlyFullscreen = container.style.position === 'fixed';
        const newFullscreenState = !isCurrentlyFullscreen;

        if (newFullscreenState) {
            // Enter fullscreen
            container.style.position = 'fixed';
            container.style.top = '0';
            container.style.left = '0';
            container.style.width = '100vw';
            container.style.height = '100vh';
            container.style.zIndex = '9999';
        } else {
            // Exit fullscreen
            container.style.position = '';
            container.style.top = '';
            container.style.left = '';
            container.style.width = '';
            container.style.height = '';
            container.style.zIndex = '';
        }

        // Update button text
        const button = document.getElementById('fullscreen-toggle');
        if (button) {
            const icon = button.querySelector('span:first-child');
            const text = button.querySelector('span:last-child');
            if (icon && text) {
                icon.textContent = newFullscreenState ? '⊗' : '⛶';
                text.textContent = newFullscreenState ? 'Exit Fullscreen' : 'Fullscreen';
            }
        }

        // Save preference
        saveFullscreenPreference(newFullscreenState);
    }

    // --- Event interaction functions ---

    // Open a URL in a centered popup window and refresh timeline when user returns
    let _refreshPending = false;
    function openEventWindow(url) {
        const w = 900, h = 700;
        const left = Math.round((screen.width - w) / 2);
        const top = Math.round((screen.height - h) / 2);
        window.open(url, '_blank', `width=${w},height=${h},left=${left},top=${top}`);
        hideEventPopup();

        // When user returns to this window, refresh timeline data
        if (!_refreshPending) {
            _refreshPending = true;
            const onFocus = () => {
                window.removeEventListener('focus', onFocus);
                _refreshPending = false;
                // Small delay to let GCal API propagate changes
                setTimeout(() => refreshTimeline(), 500);
            };
            window.addEventListener('focus', onFocus);
        }
    }

    // Re-fetch events from API and rebuild the timeline in-place
    async function refreshTimeline() {
        if (!isTimelineActive || !currentYear) return;
        console.log('🔄 Refreshing timeline data...');

        try {
            const fetchResult = await fetchFullDayEvents(currentYear);
            if (!fetchResult) return;

            // Update global data
            timelineData = { eventsByCalendar: fetchResult.eventsByCalendar, calendars: fetchResult.calendars };

            // Preserve current calendar selection
            const selected = new Set();
            document.querySelectorAll('#calendar-controls input[type="checkbox"]:checked').forEach(cb => {
                selected.add(cb.dataset.calendarId);
            });

            rebuildTimeline(timelineData, selected, currentYear);
            console.log('✅ Timeline refreshed');
        } catch (error) {
            console.error('❌ Error refreshing timeline:', error);
        }
    }

    // Handle click on an empty day cell → create new event
    function handleDayCellClick(dateStr) {
        // dateStr is YYYYMMDD format
        // Navigate to Google Calendar's event creation with all-day date pre-filled
        const nextDay = new Date(
            parseInt(dateStr.substring(0, 4)),
            parseInt(dateStr.substring(4, 6)) - 1,
            parseInt(dateStr.substring(6, 8)) + 1
        );
        const endStr = nextDay.getFullYear() +
            String(nextDay.getMonth() + 1).padStart(2, '0') +
            String(nextDay.getDate()).padStart(2, '0');
        openEventWindow(`https://calendar.google.com/calendar/u/0/r/eventedit?dates=${dateStr}/${endStr}`);
    }

    // Show event detail popup
    function showEventPopup(eventEl) {
        // Remove existing popup
        hideEventPopup();

        const title = eventEl.textContent.trim();
        const month = parseInt(eventEl.dataset.month);
        const startDay = parseInt(eventEl.dataset.startDay);
        const endDay = parseInt(eventEl.dataset.endDay);
        const calendarName = eventEl.dataset.calendarName || '';
        const color = eventEl.dataset.color || '#039be5';
        const htmlLink = eventEl.dataset.htmlLink || '';
        const eventId = eventEl.dataset.eventId || '';
        const calendarId = eventEl.dataset.calendarId || '';

        // Format date range
        const monthName = MONTH_NAMES[month - 1];
        const dateRange = startDay === endDay
            ? `${monthName} ${startDay}`
            : `${monthName} ${startDay}–${endDay}`;

        // Position popup near the event
        const rect = eventEl.getBoundingClientRect();
        const popupWidth = 260;
        const popupHeight = 120;
        let left = rect.left + rect.width / 2 - popupWidth / 2;
        let top = rect.bottom + 6;

        // Keep popup within viewport
        if (left < 8) left = 8;
        if (left + popupWidth > window.innerWidth - 8) left = window.innerWidth - popupWidth - 8;
        if (top + popupHeight > window.innerHeight - 8) top = rect.top - popupHeight - 6;

        const popup = document.createElement('div');
        popup.id = 'timeline-event-popup';
        popup.style.cssText = `
            position: fixed;
            left: ${left}px;
            top: ${top}px;
            width: ${popupWidth}px;
            background: #303030;
            border: 1px solid #505050;
            border-radius: 8px;
            box-shadow: 0 8px 24px rgba(0,0,0,0.5);
            z-index: 10001;
            font-family: 'Google Sans', -apple-system, BlinkMacSystemFont, Arial, sans-serif;
            padding: 12px;
            color: #e0e0e0;
        `;

        popup.innerHTML = `
            <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 8px;">
                <div style="font-size: 14px; font-weight: 600; color: #fff; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-right: 8px;">${title}</div>
                <div style="display: flex; gap: 4px; flex-shrink: 0;">
                    <button id="popup-edit-btn" title="Edit event" style="
                        background: none; border: none; cursor: pointer; padding: 4px 6px; border-radius: 4px; color: #b0b0b0; font-size: 16px;
                        display: flex; align-items: center; justify-content: center;
                    " onmouseover="this.style.background='#404040';this.style.color='#fff'" onmouseout="this.style.background='none';this.style.color='#b0b0b0'">&#9998;</button>
                    <button id="popup-delete-btn" title="Delete event" style="
                        background: none; border: none; cursor: pointer; padding: 4px 6px; border-radius: 4px; color: #b0b0b0; font-size: 16px;
                        display: flex; align-items: center; justify-content: center;
                    " onmouseover="this.style.background='#5c2020';this.style.color='#ff6b6b'" onmouseout="this.style.background='none';this.style.color='#b0b0b0'">&#128465;</button>
                </div>
            </div>
            <div style="font-size: 12px; color: #b0b0b0; margin-bottom: 6px;">${dateRange}</div>
            <div style="display: flex; align-items: center; gap: 6px; font-size: 11px; color: #909090;">
                <span style="display: inline-block; width: 10px; height: 10px; background: ${color}; border-radius: 2px; flex-shrink: 0;"></span>
                <span>${calendarName}</span>
            </div>
        `;

        document.body.appendChild(popup);

        // Edit button → open event edit page in a popup window
        popup.querySelector('#popup-edit-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            if (htmlLink) {
                const eidMatch = htmlLink.match(/[?&]eid=([^&]+)/);
                if (eidMatch) {
                    openEventWindow(`https://calendar.google.com/calendar/u/0/r/eventedit/${eidMatch[1]}`);
                }
            }
        });

        // Delete button → confirm, then delete via API and rebuild timeline
        popup.querySelector('#popup-delete-btn').addEventListener('click', async (e) => {
            e.stopPropagation();
            if (!eventId || !calendarId) return;

            if (!confirm(`Delete "${title}"?`)) return;

            try {
                await gapi.client.calendar.events.delete({
                    calendarId: calendarId,
                    eventId: eventId
                });
                console.log(`✅ Deleted event: ${title}`);

                // Remove event from timelineData
                if (timelineData && timelineData.eventsByCalendar[calendarId]) {
                    const calEvents = timelineData.eventsByCalendar[calendarId].events;
                    const idx = calEvents.findIndex(ev => ev.id === eventId);
                    if (idx !== -1) calEvents.splice(idx, 1);
                }

                hideEventPopup();

                // Rebuild with current calendar selection
                const selected = new Set();
                document.querySelectorAll('#calendar-controls input[type="checkbox"]:checked').forEach(cb => {
                    selected.add(cb.dataset.calendarId);
                });
                rebuildTimeline(timelineData, selected, currentYear);
            } catch (error) {
                console.error('❌ Error deleting event:', error);
            }
        });

        // Close popup when clicking outside (added on next tick to avoid immediate close)
        setTimeout(() => {
            document.addEventListener('click', handlePopupOutsideClick);
        }, 0);
    }

    // Handle click outside popup
    function handlePopupOutsideClick(e) {
        const popup = document.getElementById('timeline-event-popup');
        if (popup && !popup.contains(e.target) && !e.target.closest('.timeline-event')) {
            hideEventPopup();
        }
    }

    // Hide/remove event popup
    function hideEventPopup() {
        const popup = document.getElementById('timeline-event-popup');
        if (popup) popup.remove();
        document.removeEventListener('click', handlePopupOutsideClick);
    }

    // Set up event delegation on the timeline grid
    function setupEventDelegation() {
        const grid = document.getElementById('timeline-grid');
        if (!grid) return;

        grid.addEventListener('click', (e) => {
            // Check if clicked on an event
            const eventEl = e.target.closest('.timeline-event');
            if (eventEl) {
                e.stopPropagation();
                showEventPopup(eventEl);
                return;
            }

            // Check if clicked on a day cell with a valid date
            const dayCell = e.target.closest('.day-cell');
            if (dayCell && dayCell.dataset.date) {
                hideEventPopup();
                handleDayCellClick(dayCell.dataset.date);
                return;
            }
        });
    }

    // Rebuild timeline with selected calendars
    function rebuildTimeline(allData, selectedCalendarIds, year) {
        const { eventsByCalendar } = allData;

        const selectedEvents = [];
        selectedCalendarIds.forEach(calId => {
            if (eventsByCalendar[calId]) {
                selectedEvents.push(...eventsByCalendar[calId].events);
            }
        });

        const events = selectedEvents.flatMap(e => convertEvent(e, year)).filter(e => e.month >= 1 && e.month <= 12);
        const eventsByMonth = groupEventsByMonth(events);

        const timelineHTML = buildTimelineHTML(eventsByMonth, year);

        const timelineGrid = document.getElementById('timeline-grid');
        if (timelineGrid) {
            timelineGrid.innerHTML = timelineHTML;
            setTimeout(() => {
                repositionEvents();
            }, 0);
        }

        saveSelectedCalendars(selectedCalendarIds);
    }

    // Main function to build timeline
    async function buildTimeline() {
        if (isTimelineActive) {
            console.log('⚠️  Timeline already active');
            return;
        }

        // Get year from URL
        const year = getYearFromURL();
        currentYear = year;
        console.log(`� Building timeline view for year ${year}...`);

        try {
            // Load and initialize
            await loadGapi();
            await initCalendarClient();

            // Fetch events with dynamic year
            const fetchResult = await fetchFullDayEvents(year);
            if (!fetchResult) {
                console.error('❌ Could not fetch events');
                return;
            }

            const { allEvents: apiEvents, eventsByCalendar, calendars } = fetchResult;

            // Store data globally
            timelineData = { eventsByCalendar, calendars };

            // Load saved calendar selection
            const availableCalendarIds = calendars.map(cal => cal.id);
            const selectedCalendarIds = loadSelectedCalendars(availableCalendarIds);

            // Filter events by selected calendars
            const selectedApiEvents = [];
            selectedCalendarIds.forEach(calId => {
                if (eventsByCalendar[calId]) {
                    selectedApiEvents.push(...eventsByCalendar[calId].events);
                }
            });

            // Convert and group
            const events = selectedApiEvents.flatMap(e => convertEvent(e, year)).filter(e => e.month >= 1 && e.month <= 12);
            const eventsByMonth = groupEventsByMonth(events);

            // Load fullscreen preference
            const isFullscreen = loadFullscreenPreference();

            // Build control panel and timeline
            const controlPanelHTML = buildControlPanel(calendars, selectedCalendarIds, isFullscreen);
            const timelineHTML = buildTimelineHTML(eventsByMonth, year);

            // Remove existing timeline
            const existing = document.getElementById('timeline-container');
            if (existing) existing.remove();

            // Inject complete UI
            const container = document.querySelector('.LzOMn') || document.querySelector('main') || document.body;
            const fullscreenStyles = isFullscreen ? `
                position: fixed;
                top: 0;
                left: 0;
                width: 100vw;
                height: 100vh;
                z-index: 9999;
            ` : '';
            const completeHTML = `
                <div id="timeline-container" style="
                    width: 100%;
                    height: 100vh;
                    overflow: auto;
                    padding: 0;
                    background: #1a1a1a;
                    font-family: 'Google Sans', -apple-system, BlinkMacSystemFont, Arial, sans-serif;
                    ${fullscreenStyles}
                ">
                    ${controlPanelHTML}
                    <div id="timeline-grid">${timelineHTML}</div>
                </div>
            `;
            container.insertAdjacentHTML('afterbegin', completeHTML);

            // Hide original calendar
            Array.from(container.children).forEach(child => {
                if (child.id !== 'timeline-container') {
                    child.dataset.originalDisplay = child.style.display || '';
                    child.style.display = 'none';
                }
            });

            // Reposition events based on actual cell widths
            setTimeout(() => {
                repositionEvents();
            }, 0);

            // Reposition events on window resize
            // Remove old resize handler if exists
            if (resizeHandler) {
                window.removeEventListener('resize', resizeHandler);
            }

            let resizeTimeout;
            resizeHandler = () => {
                clearTimeout(resizeTimeout);
                resizeTimeout = setTimeout(() => {
                    repositionEvents();
                }, 100);
            };
            window.addEventListener('resize', resizeHandler);

            // Add event listener for fullscreen button
            const fullscreenButton = document.getElementById('fullscreen-toggle');
            if (fullscreenButton) {
                fullscreenButton.addEventListener('click', () => {
                    toggleFullscreen();
                    setTimeout(() => {
                        repositionEvents();
                    }, 0);
                });
            }

            // Add event listeners to checkboxes
            document.querySelectorAll('#calendar-controls input[type="checkbox"]').forEach(checkbox => {
                checkbox.addEventListener('change', () => {
                    const selected = new Set();
                    document.querySelectorAll('#calendar-controls input[type="checkbox"]:checked').forEach(cb => {
                        selected.add(cb.dataset.calendarId);
                    });
                    rebuildTimeline(timelineData, selected, currentYear);
                });
            });

            // Set up click handlers for day cells and events
            setupEventDelegation();

            isTimelineActive = true;
            console.log(`✅ Timeline view created! Showing ${events.length} events from ${selectedCalendarIds.size} calendars`);

        } catch (error) {
            console.error('❌ Error building timeline:', error);
        }
    }

    // Remove timeline and restore original view
    function removeTimeline() {
        // Clean up event popup
        hideEventPopup();

        const timeline = document.getElementById('timeline-container');
        if (timeline) timeline.remove();

        const container = document.querySelector('.LzOMn') || document.querySelector('main') || document.body;
        Array.from(container.children).forEach(child => {
            if (child.dataset.originalDisplay !== undefined) {
                child.style.display = child.dataset.originalDisplay;
                delete child.dataset.originalDisplay;
            }
        });

        // Clean up resize handler
        if (resizeHandler) {
            window.removeEventListener('resize', resizeHandler);
            resizeHandler = null;
        }

        isTimelineActive = false;
        console.log('✅ Timeline removed, original view restored');
    }

    // Handle view changes
    function handleViewChange() {
        const shouldShowTimeline = isYearView();
        const newYear = getYearFromURL();

        console.log(`� View check result: shouldShow=${shouldShowTimeline}, isActive=${isTimelineActive}, year=${newYear}, currentYear=${currentYear}`);

        if (shouldShowTimeline && !isTimelineActive) {
            console.log('✅ Year view detected! Building timeline...');
            // Delay to ensure Google Calendar has finished loading
            setTimeout(() => {
                buildTimeline();
            }, 1000);
        } else if (!shouldShowTimeline && isTimelineActive) {
            console.log('⬅️  Leaving year view, removing timeline...');
            removeTimeline();
        } else if (shouldShowTimeline && isTimelineActive) {
            // Check if year changed
            if (newYear !== currentYear) {
                console.log(`� Year changed from ${currentYear} to ${newYear}, rebuilding timeline...`);
                removeTimeline();
                setTimeout(() => {
                    buildTimeline();
                }, 1000);
            } else {
                console.log('ℹ️  Already in year view with timeline active');
            }
        } else {
            console.log('ℹ️  Not in year view');
        }
    }

    // Watch for URL changes (Google Calendar is a SPA)
    let lastUrl = window.location.href;
    let lastHash = window.location.hash;

    // Check URL periodically (every 500ms)
    setInterval(() => {
        const currentUrl = window.location.href;
        const currentHash = window.location.hash;

        if (currentUrl !== lastUrl || currentHash !== lastHash) {
            console.log('� URL/Hash changed - checking view');
            lastUrl = currentUrl;
            lastHash = currentHash;
            handleViewChange();
        }
    }, 500);

    // Also listen to hash changes
    window.addEventListener('hashchange', () => {
        console.log('� Hash change event fired');
        handleViewChange();
    });

    // Listen to popstate (browser back/forward)
    window.addEventListener('popstate', () => {
        console.log('� Popstate event fired');
        handleViewChange();
    });

    // Initial check after a delay
    setTimeout(() => {
        console.log('🔍 Initial view check');
        handleViewChange();
    }, 2000);

    console.log('🔄 Watching for year view...');
})();
