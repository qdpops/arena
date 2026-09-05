// ==UserScript==
// @name         InPlay Schedule Sync
// @namespace    https://sportarena.win
// @version      3.0
// @description  Тихо собирает расписание inplayip.tv за несколько дней и отправляет на сервер. Не мешает работе в учётной записи.
// @author       sportarena
// @match        https://inplayip.tv/*
// @match        https://www.inplayip.tv/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      api.inplayip.tv
// @connect      sportarena.win
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    // ── Конфигурация (правится здесь) ──────────────────────────────────────────
    const CONFIG = {
        DEBUG: true,

        API_URL:     'https://api.inplayip.tv/api/schedule/table',
        REFRESH_URL: 'https://api.inplayip.tv/api/auth/refresh',
        HEADERS_URL: 'https://api.inplayip.tv/api/schedule/stream_settings_aliases',

        // Приёмник на сервере и его токен (schedule_ingest.php).
        INGEST_URL:   'https://sportarena.win/schedule_ingest.php',
        INGEST_TOKEN: '18242a65458b18a77998e5f3f6ec2b39',

        ALLOWED_DOMAINS: ['inplayip.tv', 'www.inplayip.tv'],

        // Диапазон сбора.
        DAYS_BACK: 1,
        DAYS_FORWARD: 3,

        // Щадящий режим: случайная пауза между днями, чтобы не слать всё залпом.
        MIN_GAP_MS: 6000,
        MAX_GAP_MS: 18000,

        RETRIES: 2,               // повторов на день при сбое
        INITIAL_DELAY_MS: 8000,   // пауза перед первым сбором после загрузки
        SYNC_INTERVAL_MIN: 30,    // как часто повторять полный сбор
        SLIM: false,              // true — только ключевые поля
    };

    const currentDomain = window.location.hostname;
    if (!CONFIG.ALLOWED_DOMAINS.includes(currentDomain)) return;

    function log(msg, isError) {
        if (!CONFIG.DEBUG) return;
        (isError ? console.error : console.log)(
            `[InPlaySync][${new Date().toLocaleTimeString()}] ${msg}`);
    }

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const rand = (min, max) => Math.round(min + Math.random() * (max - min));

    const EMPTY_FILTERS = {
        searchWord: '', onlyNew: false, showVOD: false, showLive: false,
        sportsCriteria: [], countriesCriteria: [], servicesCriteria: [],
    };

    const SLIM_FIELDS = [
        'wtScheduledEventId', 'eventId', 'startTime', 'endTime', 'sport', 'competition',
        'competitor1', 'competitor2', 'description', 'information', 'countryName', 'countryCode',
        'region', 'service', 'sourceName', 'channel', 'package', 'serverName',
        'cancelled', 'verified', 'internalSchedule', 'isAudio', 'isRestricted', 'isEnhancedVod',
        'isStadiumFeed', 'created', 'wssLink', 'rtmpLink',
    ];
    const slimEvent = (e) => {
        const o = {};
        for (const f of SLIM_FIELDS) if (e[f] !== undefined) o[f] = e[f];
        return o;
    };

    // ── Перехват авторизации (запасной источник, если localStorage пуст) ────────
    let capturedHeaders = null; // {Authorization, DeviceUuid, ...} из XHR приложения
    let capturedToken = null;   // access_token из WebSocket

    (function setupInterceptors() {
        const origOpen = XMLHttpRequest.prototype.open;
        const origSend = XMLHttpRequest.prototype.send;
        const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;

        XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
            (this._hdrs || (this._hdrs = {}))[name] = value;
            return origSetHeader.apply(this, arguments);
        };
        XMLHttpRequest.prototype.open = function (method, url) {
            this._url = url;
            return origOpen.apply(this, arguments);
        };
        XMLHttpRequest.prototype.send = function (data) {
            if (this._url === CONFIG.HEADERS_URL) {
                this.addEventListener('load', () => {
                    if (this.status === 200 && this._hdrs) {
                        capturedHeaders = this._hdrs;
                        log('Заголовки авторизации перехвачены из XHR');
                    }
                });
            }
            return origSend.apply(this, arguments);
        };

        const NativeWS = window.WebSocket;
        window.WebSocket = function (url, protocols) {
            const ws = new NativeWS(url, protocols);
            if (typeof url === 'string' && url.includes('api.inplayip.tv/api-hub')) {
                const m = url.match(/access_token=([^&]+)/);
                if (m && m[1]) {
                    capturedToken = decodeURIComponent(m[1]);
                    log('Токен перехвачен из WebSocket');
                }
            }
            return ws;
        };
        window.WebSocket.prototype = NativeWS.prototype;
    })();

    // ── Авторизация ─────────────────────────────────────────────────────────────
    // Приоритет: localStorage (как у самого сайта) → перехваченные значения.
    function authHeaders() {
        const token = localStorage.getItem('token') || capturedToken;
        const deviceUuid = localStorage.getItem('deviceUuid') || (capturedHeaders && capturedHeaders.DeviceUuid) || '';
        const h = { 'Content-Type': 'application/json; charset=utf-8', 'Accept': 'application/json, text/plain, */*' };
        if (token) {
            h['Authorization'] = 'Bearer ' + token;
            if (deviceUuid) h['DeviceUuid'] = deviceUuid;
            return h;
        }
        if (capturedHeaders && capturedHeaders.Authorization) {
            return Object.assign(h, capturedHeaders);
        }
        return null;
    }

    function gm(opts) {
        return new Promise((resolve) => {
            GM_xmlhttpRequest(Object.assign({
                onload: (r) => resolve(r),
                onerror: () => resolve({ status: 0 }),
                ontimeout: () => resolve({ status: 0 }),
            }, opts));
        });
    }

    // Обновление токена тем же способом, что и сайт: GET /api/auth/refresh.
    async function refreshToken() {
        const refresh = localStorage.getItem('refreshToken');
        if (!refresh) return false;
        const r = await gm({
            method: 'GET', url: CONFIG.REFRESH_URL,
            headers: { 'Authorization': 'Bearer ' + refresh }, timeout: 20000,
        });
        if (r.status !== 200) return false;
        try {
            const d = JSON.parse(r.responseText);
            if (!d || !d.accessToken) return false;
            localStorage.setItem('token', d.accessToken);
            if (d.refreshToken) localStorage.setItem('refreshToken', d.refreshToken);
            log('Токен обновлён');
            return true;
        } catch (e) { return false; }
    }

    // ── Сбор ────────────────────────────────────────────────────────────────────
    async function requestDay(date) {
        const headers = authHeaders();
        if (!headers) throw new Error('нет авторизации');
        return gm({
            method: 'POST', url: CONFIG.API_URL, headers, timeout: 120000,
            data: JSON.stringify({
                filters: Object.assign({}, EMPTY_FILTERS, { searchDate: date.toISOString() }),
                timezoneOffset: new Date().getTimezoneOffset(),
            }),
        });
    }

    async function fetchDay(date) {
        let r = await requestDay(date);
        if (r.status === 401 && await refreshToken()) r = await requestDay(date);
        if (r.status === 401) throw new Error('401 — сессия истекла');
        if (r.status !== 200) throw new Error('HTTP ' + r.status);
        const data = JSON.parse(r.responseText);
        return Array.isArray(data) ? data : (data && data.events) || [];
    }

    function sendToServer(events, range) {
        const url = CONFIG.INGEST_URL +
            (CONFIG.INGEST_URL.includes('?') ? '&' : '?') +
            'token=' + encodeURIComponent(CONFIG.INGEST_TOKEN);
        return gm({
            method: 'POST', url, timeout: 60000,
            headers: { 'Content-Type': 'application/json' },
            data: JSON.stringify({ collectedAt: new Date().toISOString(), range, events }),
        }).then((r) => {
            if (r.status === 200) log(`Сервер принял выгрузку (${events.length} событий)`);
            else log(`Сервер вернул HTTP ${r.status}: ${(r.responseText || '').slice(0, 150)}`, true);
        });
    }

    let running = false;

    async function collectAndSend() {
        if (running) return;
        if (!authHeaders()) { log('Пока нет авторизации, пропуск цикла'); return; }
        running = true;
        const t0 = Date.now();

        const noon = (ms) => { const d = new Date(ms); d.setHours(12, 0, 0, 0); return d; };
        const start = noon(Date.now() - CONFIG.DAYS_BACK * 864e5);
        const end = noon(Date.now() + CONFIG.DAYS_FORWARD * 864e5);
        const days = [];
        for (let d = new Date(start); d <= end; d = new Date(d.getTime() + 864e5)) days.push(new Date(d));

        const byKey = new Map();
        let errors = 0;

        try {
            for (let i = 0; i < days.length; i++) {
                const day = days[i];
                const label = day.toISOString().slice(0, 10);
                let events = null;
                for (let attempt = 0; attempt <= CONFIG.RETRIES; attempt++) {
                    try { events = await fetchDay(day); break; }
                    catch (e) {
                        if (String(e.message).startsWith('401')) throw e;
                        if (attempt === CONFIG.RETRIES) { errors++; log(`${label}: ${e.message}`, true); }
                        else await sleep(rand(1000, 2500) * (attempt + 1));
                    }
                }
                if (events) {
                    for (const ev of events) {
                        const key = ev.wtScheduledEventId != null ? ev.wtScheduledEventId
                            : (ev.eventId != null ? ev.eventId
                                : JSON.stringify([ev.startTime, ev.competitor1, ev.competitor2, ev.channel]));
                        if (!byKey.has(key)) byKey.set(key, CONFIG.SLIM ? slimEvent(ev) : ev);
                    }
                    log(`${label}: ${events.length} (уникальных всего: ${byKey.size})`);
                }
                if (i < days.length - 1) await sleep(rand(CONFIG.MIN_GAP_MS, CONFIG.MAX_GAP_MS));
            }

            const all = [...byKey.values()].sort(
                (a, b) => new Date(a.startTime || 0) - new Date(b.startTime || 0));

            if (all.length) {
                await sendToServer(all, {
                    from: days[0].toISOString().slice(0, 10),
                    to: days[days.length - 1].toISOString().slice(0, 10),
                });
                GM_setValue('lastSync', { at: Date.now(), count: all.length, errors });
            } else {
                log('Собрано 0 событий — на сервер не отправляю', true);
            }
            log(`Готово: ${all.length} событий, ${errors} ошибок, ${Math.round((Date.now() - t0) / 1000)} с`);
        } catch (e) {
            log(`Цикл прерван: ${e.message}`, true);
        } finally {
            running = false;
        }
    }

    // ── Запуск ────────────────────────────────────────────────────────────────
    log(`Запущен на ${currentDomain}`);
    setTimeout(collectAndSend, CONFIG.INITIAL_DELAY_MS);
    setInterval(collectAndSend, Math.max(5, CONFIG.SYNC_INTERVAL_MIN) * 60000);
})();
