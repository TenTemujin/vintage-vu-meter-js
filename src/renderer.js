let targetDb = -60;
let activeDeviceId = null;

const MIN_DB = -20;
const MAX_DB = 3;

// The Rust backend reports raw dBFS RMS (0 dBFS = digital full scale, -60
// dBFS floor). A VU meter is calibrated against an analog reference level,
// not digital full scale — ordinary listening-level audio sits around -30
// to -18 dBFS RMS, which is already below MIN_DB, so without this offset
// the needle reads silence for anything short of near-clipping and never
// leaves the bottom peg. -18 dBFS is a common "0 VU" calibration point.
const DBFS_TO_VU_OFFSET = 18;

// Standard VU ballistic scale markings (ANSI C16.5) — unevenly spaced in dB
// on purpose: finer resolution is printed near 0 VU where precision matters most.
const VU_MARKS = [-20, -10, -7, -5, -3, -2, -1, 0, 1, 2, 3];
const VU_MAJOR_MARKS = new Set([-20, -10, -7, -5, -3, 0, 3]);
const PERCENT_MARKS = [0, 20, 40, 60, 80, 100, 120];

// State object includes physics properties for realistic needle movement.
// springiness/damping tuned so a full-scale step reaches 99% of its target
// in ~300ms with ~1% overshoot, matching the ANSI C16.5 VU ballistic spec.
const vuState = {
    value: MIN_DB,
    peak: MIN_DB,
    velocity: 0,
    acceleration: 0,
};
const NEEDLE_SPRINGINESS = 0.06;
const NEEDLE_DAMPING = 0.69;

let noisePattern = null;
let dustPattern = null;
const startTime = performance.now();

// Cached static layers, rebuilt only on resize instead of every animation frame.
let bgLayer = null;
let glassLayer = null;
let geom = null;

// Power-on self test: sweeps the needle full-scale and back on launch, like
// real VU hardware settling after being switched on. Doubles as a visible,
// at-a-glance proof that the render loop and needle physics are actually
// running, independent of whether audio capture is working.
const SELF_TEST_DURATION = 1400;
let selfTestUntil = null;

function startSelfTest() {
    selfTestUntil = performance.now() + SELF_TEST_DURATION;
}

function selfTestLevel(elapsed) {
    const t = elapsed / SELF_TEST_DURATION;
    if (t < 0.35) return MIN_DB + (MAX_DB - MIN_DB) * (t / 0.35);
    if (t < 0.55) return MAX_DB;
    return MAX_DB - (MAX_DB - MIN_DB) * ((t - 0.55) / 0.45);
}

function getTauri() {
    return window.__TAURI__ || null;
}

let statusClearTimer = null;

function setStatus(message, kind = 'error') {
    const status = document.getElementById('status-message');
    if (!status) return;
    if (statusClearTimer) {
        clearTimeout(statusClearTimer);
        statusClearTimer = null;
    }
    status.textContent = message || '';
    status.classList.toggle('status-ok', kind === 'ok');
}

// Shows a message and clears it after `duration` — used for transient
// confirmations (e.g. "capture started") that shouldn't linger like an error.
function flashStatus(message, kind, duration = 2500) {
    setStatus(message, kind);
    statusClearTimer = setTimeout(() => setStatus(''), duration);
}

// IMPROVEMENT: Helper to create a more organic, aged paper texture
function createNoiseTexture(ctx) {
    const size = 256; // Larger size for a less repetitive pattern
    const noiseCanvas = document.createElement('canvas');
    noiseCanvas.width = size;
    noiseCanvas.height = size;
    const noiseCtx = noiseCanvas.getContext('2d');
    const imageData = noiseCtx.createImageData(size, size);
    const data = imageData.data;
    for (let i = 0; i < data.length; i += 4) {
        // Base noise for texture
        const val = Math.random() * 40;
        // Subtle, large-scale mottling/staining effect
        const x = (i / 4) % size;
        const y = Math.floor((i / 4) / size);
        const stain = (Math.sin(x * 0.05) + Math.cos(y * 0.03)) * 5; // Larger, smoother waves of color

        // Creates a warm, aged gray with hints of yellow/brown
        data[i]     = 225 + val + stain; // R
        data[i + 1] = 218 + val;         // G
        data[i + 2] = 208 + val;         // B
        data[i + 3] = 18;                // Low alpha for subtlety
    }
    noiseCtx.putImageData(imageData, 0, 0);
    return ctx.createPattern(noiseCanvas, 'repeat');
}

// Faint dust specks and micro-scratches for the glass layer, so the meter
// reads as a photographed object rather than a flat vector render.
function createDustTexture(ctx, w, h) {
    const dustCanvas = document.createElement('canvas');
    dustCanvas.width = w;
    dustCanvas.height = h;
    const dctx = dustCanvas.getContext('2d');

    for (let i = 0; i < w * h * 0.0004; i++) {
        const x = Math.random() * w;
        const y = Math.random() * h;
        const radius = Math.random() * 0.9 + 0.2;
        dctx.beginPath();
        dctx.arc(x, y, radius, 0, Math.PI * 2);
        dctx.fillStyle = `rgba(255,255,255,${Math.random() * 0.15 + 0.03})`;
        dctx.fill();
    }
    for (let i = 0; i < 14; i++) {
        const x = Math.random() * w;
        const y = Math.random() * h;
        const len = Math.random() * w * 0.06 + w * 0.01;
        const angle = Math.random() * Math.PI * 2;
        dctx.beginPath();
        dctx.moveTo(x, y);
        dctx.lineTo(x + Math.cos(angle) * len, y + Math.sin(angle) * len);
        dctx.strokeStyle = `rgba(255,255,255,${Math.random() * 0.05 + 0.02})`;
        dctx.lineWidth = 0.5;
        dctx.stroke();
    }
    return dustCanvas;
}

function drawInkedText(ctx, text, x, y, sizePx, color, align = 'center', weight = 'normal') {
    ctx.font = `${weight} ${sizePx}px ${geom.font}`;
    ctx.textAlign = align;
    // IMPROVEMENT: Added a tiny shadowBlur to simulate ink bleeding into the paper.
    ctx.shadowColor = 'rgba(0,0,0,0.3)';
    ctx.shadowBlur = 0.8;
    ctx.shadowOffsetX = 0.5;
    ctx.shadowOffsetY = 0.5;
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
    // Reset shadow for subsequent drawing operations
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
}

// Renders a small monochrome noise tile and applies it as the grain
// overlay's background — the one texture no CSS gradient can fake, and
// what makes the whole composited scene read as a single photograph.
function applyFilmGrain() {
    const overlay = document.querySelector('.grain-overlay');
    if (!overlay) return;
    const size = 128;
    const noiseCanvas = document.createElement('canvas');
    noiseCanvas.width = size;
    noiseCanvas.height = size;
    const noiseCtx = noiseCanvas.getContext('2d');
    const imageData = noiseCtx.createImageData(size, size);
    const data = imageData.data;
    for (let i = 0; i < data.length; i += 4) {
        const v = Math.random() * 255;
        data[i] = data[i + 1] = data[i + 2] = v;
        data[i + 3] = 255;
    }
    noiseCtx.putImageData(imageData, 0, 0);
    overlay.style.backgroundImage = `url(${noiseCanvas.toDataURL()})`;
}

window.addEventListener('DOMContentLoaded', () => {
    const select = document.getElementById('source-select');
    const themeSelect = document.getElementById('theme-select');
    const alwaysOnTopCheckbox = document.getElementById('always-on-top-checkbox');
    const canvas = document.getElementById('vuMeter');
    const appContainer = document.querySelector('.app-container');
    resetDropdown('Loading devices...');

    // Load saved theme
    const savedTheme = localStorage.getItem('vuTheme') || 'neve';
    themeSelect.value = savedTheme;
    appContainer.setAttribute('data-theme', savedTheme);

    themeSelect.addEventListener('change', () => {
        const newTheme = themeSelect.value;
        appContainer.setAttribute('data-theme', newTheme);
        localStorage.setItem('vuTheme', newTheme);
        buildStaticLayers(canvas); // Redraw meter face
    });

    initMeter(canvas);
    startSelfTest();
    applyFilmGrain();

    const tauri = getTauri();
    if (tauri) {
        loadDevices(select);

        alwaysOnTopCheckbox.addEventListener('change', () => {
            tauri.core.invoke('set_always_on_top', { flag: alwaysOnTopCheckbox.checked })
                .catch((err) => setStatus(`Could not toggle always-on-top: ${err}`));
        });
    } else {
        console.warn('Tauri API not found. Run this app with "npm run dev".');
        resetDropdown('-- No devices found --');
        setStatus('Tauri API not found. Run with "npm run dev".');
    }

    select.addEventListener('change', () => {
        localStorage.setItem('lastDeviceId', select.value);
        startCapture(select.value);
    });

    if (typeof ResizeObserver !== 'undefined') {
        new ResizeObserver(() => buildStaticLayers(canvas)).observe(canvas);
    } else {
        window.addEventListener('resize', () => buildStaticLayers(canvas));
    }

    // --- Interactive 3D Parallax Tilt ---
    document.addEventListener('mousemove', (e) => {
        const x = (e.clientX / window.innerWidth - 0.5) * 2; // -1 to 1
        const y = (e.clientY / window.innerHeight - 0.5) * 2; // -1 to 1
        
        // Max tilt of 6 degrees
        const tiltX = x * 6;
        const tiltY = -y * 6 + 4; // Add 4deg base upward tilt

        document.documentElement.style.setProperty('--tilt-x', tiltX);
        document.documentElement.style.setProperty('--tilt-y', tiltY);
    });

    requestAnimationFrame(function loop() {
        updateVolume();
        drawMeter(canvas);
        requestAnimationFrame(loop);
    });
});

async function loadDevices(select) {
    const tauri = getTauri();
    const saved = localStorage.getItem('lastDeviceId');
    try {
        const devices = await tauri.core.invoke('list_output_devices');
        populateDropdown(devices);
        setStatus('');
        const preferred = (saved && devices.some(d => d.id === saved))
            ? saved
            : (devices.find(d => d.isDefault) || devices[0] || {}).id;
        if (preferred) {
            select.value = preferred;
            startCapture(preferred);
        }
    } catch (err) {
        resetDropdown('-- No devices found --');
        setStatus(`Could not list audio devices: ${err}`);
    }
}

function resetDropdown(text) {
    const select = document.getElementById('source-select');
    select.innerHTML = '';
    const option = document.createElement('option');
    option.innerText = text;
    option.value = '';
    select.appendChild(option);
}

function populateDropdown(devices) {
    resetDropdown('-- Select Audio Device --');
    devices.forEach(device => {
        const opt = document.createElement('option');
        opt.value = device.id;
        opt.innerText = device.isDefault ? `${device.name} (Default)` : device.name;
        document.getElementById('source-select').appendChild(opt);
    });
}

async function startCapture(deviceId) {
    const tauri = getTauri();
    activeDeviceId = deviceId || null;

    if (!deviceId) {
        targetDb = MIN_DB;
        if (tauri) tauri.core.invoke('stop_capture').catch(() => {});
        return;
    }

    try {
        const onEvent = new tauri.core.Channel();
        onEvent.onmessage = (payload) => {
            if (activeDeviceId === deviceId) targetDb = payload.db + DBFS_TO_VU_OFFSET;
        };
        setStatus('');
        await tauri.core.invoke('start_capture', { deviceId, onEvent });
        const select = document.getElementById('source-select');
        const label = select.options[select.selectedIndex]
            ? select.options[select.selectedIndex].text
            : 'device';
        flashStatus(`Listening to ${label}`, 'ok');
    } catch (err) {
        targetDb = MIN_DB;
        setStatus(`Could not capture this device: ${err}`);
    }
}

function updateVolume() {
    let level;
    if (selfTestUntil !== null) {
        const remaining = selfTestUntil - performance.now();
        if (remaining <= 0) {
            selfTestUntil = null;
        } else {
            level = selfTestLevel(SELF_TEST_DURATION - remaining);
        }
    }
    if (level === undefined) {
        level = Math.max(MIN_DB, Math.min(MAX_DB, targetDb));
    }

    // --- Needle Physics (Mass, Spring, Damping) ---
    // Tuned to the ANSI C16.5 VU ballistic characteristic: ~300ms to reach
    // 99% of a suddenly-applied full-scale reading, with a slight overshoot.
    const force = (level - vuState.value) * NEEDLE_SPRINGINESS;
    vuState.acceleration = force;
    vuState.velocity += vuState.acceleration;
    vuState.velocity *= NEEDLE_DAMPING;
    vuState.value += vuState.velocity;

    // --- Peak-hold Logic ---
    if (vuState.value > vuState.peak) {
        vuState.peak = vuState.value;
    } else {
        vuState.peak -= 0.04;
    }
    vuState.peak = Math.max(vuState.peak, MIN_DB);
}

function initMeter(canvas) {
    buildStaticLayers(canvas);
}

/**
 * Rebuilds the static background (bezel, face, scale, "VU" logo) and the static
 * glass overlay into offscreen canvases. Only needed once and on resize — the
 * per-frame draw just composites these plus the dynamic needle/peak/readout.
 */
function buildStaticLayers(canvas) {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w === 0 || h === 0) return;

    // Render at native device resolution so scale text and hairline ticks
    // stay crisp on HiDPI displays instead of being upscaled and blurred.
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);

    if (!bgLayer) bgLayer = document.createElement('canvas');
    if (!glassLayer) glassLayer = document.createElement('canvas');
    bgLayer.width = glassLayer.width = canvas.width;
    bgLayer.height = glassLayer.height = canvas.height;

    const pivot = { x: w / 2, y: h * 0.88 };
    // r is sized so the dB scale's ticks AND their labels (r + labelOffset,
    // below) stay inside faceRect at every angle in the sweep — the box is a
    // wide 5:3 shape with limited headroom above the pivot, so this can't be
    // driven by width alone the way a taller enclosure could.
    const r = w * 0.40;
    const r2 = r * 0.76; // inner radius for the % modulation scale — kept clear of both the dB scale and the VU logo
    const inset = w * 0.065; // a real metal bezel margin, not a hairline
    const centerAngle = -Math.PI / 2;
    const sweepAngle = Math.PI * 0.85;
    const minA = centerAngle - sweepAngle / 2;
    const maxA = centerAngle + sweepAngle / 2;
    const range = sweepAngle;
    const font = `'Helvetica Neue', 'Helvetica', 'Arial', sans-serif`;
    const faceRect = [inset, inset, w - inset * 2, h - inset * 2];
    // Warm backlight bulb fixtures, tucked behind the upper scale like real
    // incandescent-lit VU meters.
    const lamps = [
        { x: w * 0.26, y: h * 0.2 },
        { x: w * 0.74, y: h * 0.2 },
    ];

    geom = { w, h, dpr, pivot, r, r2, inset, minA, maxA, range, font, faceRect, lamps };

    const bgCtx = bgLayer.getContext('2d');
    const glassCtx = glassLayer.getContext('2d');
    bgCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    glassCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

    drawBackgroundLayer(bgCtx);
    drawGlassLayer(glassCtx);
}

function angleForDb(db) {
    const { minA, range } = geom;
    const pos = (db - MIN_DB) / (MAX_DB - MIN_DB);
    return minA + range * pos;
}

function drawBackgroundLayer(ctx) {
    const { w, h, pivot, r, r2, inset, minA, maxA, range, faceRect } = geom;

    if (!noisePattern) noisePattern = createNoiseTexture(ctx);

    // --- 1. Brushed Metal Bezel ---
    const bezelGrad = ctx.createLinearGradient(0, inset, 0, h - inset);
    bezelGrad.addColorStop(0, '#555');
    bezelGrad.addColorStop(0.5, '#222');
    bezelGrad.addColorStop(1, '#444');
    ctx.fillStyle = bezelGrad;
    ctx.fillRect(0, 0, w, h);

    ctx.save();
    ctx.translate(w / 2, h / 2);
    for (let i = 0; i < 250; i++) { // More lines for a finer grain
        ctx.beginPath();
        ctx.arc(0, 0, Math.max(w, h) * 0.3 + i * 1.5, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(255, 255, 255, ${Math.random() * 0.03 + 0.005})`;
        ctx.stroke();
    }
    ctx.restore();

    // --- 2. Meter Face ---
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(...faceRect, w * 0.02);
    ctx.clip();

    const currentTheme = document.querySelector('.app-container').getAttribute('data-theme');
    const faceGrad = ctx.createRadialGradient(w / 2, h * 0.32, h * 0.05, w / 2, h * 0.5, h * 0.85);
    
    if (currentTheme === 'ssl') {
        faceGrad.addColorStop(0, '#f8fafc');
        faceGrad.addColorStop(0.55, '#e2e8f0');
        faceGrad.addColorStop(1, '#cbd5e1');
    } else if (currentTheme === 'marantz') {
        faceGrad.addColorStop(0, '#eef2ff');
        faceGrad.addColorStop(0.55, '#c7d2fe');
        faceGrad.addColorStop(1, '#818cf8'); // classic Marantz blue tint
    } else {
        // neve / default warm
        faceGrad.addColorStop(0, '#f1e8d9');
        faceGrad.addColorStop(0.55, '#e4d9c5');
        faceGrad.addColorStop(1, '#c7b89e');
    }

    ctx.fillStyle = faceGrad;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = noisePattern;
    ctx.fillRect(0, 0, w, h);

    // Inner shadow from the metal bezel onto the paper dial to show physical depth
    ctx.shadowColor = 'rgba(0,0,0,0.85)';
    ctx.shadowBlur = inset * 1.5;
    ctx.shadowOffsetX = inset / 2.5;
    ctx.shadowOffsetY = inset / 2.5;
    ctx.strokeStyle = 'rgba(0,0,0,1)';
    ctx.lineWidth = w * 0.01;
    ctx.stroke();
    ctx.restore();

    // Faceplate corner screws, sitting directly on the bezel margin —
    // real meter movements are screwed to their own faceplate, separate
    // from the outer chassis screws on the housing.
    const faceScrewR = w * 0.011;
    const faceScrewInset = inset * 0.55;
    [
        { x: faceScrewInset, y: faceScrewInset, a: 25 },
        { x: w - faceScrewInset, y: faceScrewInset, a: -40 },
        { x: faceScrewInset, y: h - faceScrewInset, a: -15 },
        { x: w - faceScrewInset, y: h - faceScrewInset, a: 55 },
    ].forEach(({ x, y, a }) => {
        const screwGrad = ctx.createRadialGradient(x - faceScrewR * 0.3, y - faceScrewR * 0.3, 0, x, y, faceScrewR);
        screwGrad.addColorStop(0, '#c8c8ce');
        screwGrad.addColorStop(0.6, '#8a8a90');
        screwGrad.addColorStop(1, '#4a4a4e');
        ctx.beginPath();
        ctx.arc(x, y, faceScrewR, 0, Math.PI * 2);
        ctx.fillStyle = screwGrad;
        ctx.fill();
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate((a * Math.PI) / 180);
        ctx.beginPath();
        ctx.moveTo(-faceScrewR * 0.75, 0);
        ctx.lineTo(faceScrewR * 0.75, 0);
        ctx.strokeStyle = 'rgba(0,0,0,0.55)';
        ctx.lineWidth = faceScrewR * 0.22;
        ctx.stroke();
        ctx.restore();
    });

    // --- 3. Red-zone band (0 to +3 VU), restricted to the outer ring so it
    // doesn't wash out the % scale numbers sitting further in. Clipped to the
    // face rect so it can't spill past the ivory face onto the bezel. ---
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(...faceRect, w * 0.02);
    ctx.clip();
    ctx.beginPath();
    ctx.arc(pivot.x, pivot.y, r * 1.03, angleForDb(0), angleForDb(MAX_DB));
    ctx.arc(pivot.x, pivot.y, r - h * 0.02, angleForDb(MAX_DB), angleForDb(0), true);
    ctx.closePath();
    ctx.fillStyle = 'rgba(193, 58, 51, 0.12)';
    ctx.fill();
    ctx.restore();

    // --- 4. Printed guideline arcs the ticks sit on ---
    ctx.beginPath();
    ctx.arc(pivot.x, pivot.y, r, minA, angleForDb(0));
    ctx.strokeStyle = 'rgba(40, 40, 40, 0.55)';
    ctx.lineWidth = w * 0.0018;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(pivot.x, pivot.y, r, angleForDb(0), maxA);
    ctx.strokeStyle = 'rgba(193, 58, 51, 0.55)';
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(pivot.x, pivot.y, r2, minA, maxA);
    ctx.strokeStyle = 'rgba(193, 58, 51, 0.4)';
    ctx.lineWidth = w * 0.0014;
    ctx.stroke();

    // --- 5. dB (VU) scale: authentic ballistic markings, ticks + labels ---
    VU_MARKS.forEach((db) => {
        const a = angleForDb(db);
        const isMajor = VU_MAJOR_MARKS.has(db);
        const tickLen = isMajor ? h * 0.018 : h * 0.01;
        const inRedZone = db >= 0;

        ctx.beginPath();
        ctx.moveTo(pivot.x + Math.cos(a) * (r - tickLen), pivot.y + Math.sin(a) * (r - tickLen));
        ctx.lineTo(pivot.x + Math.cos(a) * r, pivot.y + Math.sin(a) * r);
        ctx.strokeStyle = inRedZone ? 'rgba(193, 58, 51, 0.85)' : 'rgba(40, 40, 40, 0.75)';
        ctx.lineWidth = isMajor ? w * 0.004 : w * 0.0022;
        ctx.stroke();

        drawInkedText(ctx, (db > 0 ? '+' : '') + db,
            pivot.x + Math.cos(a) * (r + w * 0.028),
            pivot.y + Math.sin(a) * (r + w * 0.028),
            isMajor ? w * 0.024 : w * 0.019,
            inRedZone ? '#c13a33' : '#2a2a2a',
            'center', isMajor ? 'bold' : 'normal'
        );
    });

    // --- 6. Percentage modulation scale (red), inner arc — kept visually
    // secondary to the primary dB scale, as on the real instrument. ---
    PERCENT_MARKS.forEach((pct) => {
        const db = pct <= 0 ? MIN_DB : Math.max(MIN_DB, 20 * Math.log10(pct / 100));
        const a = angleForDb(db);
        const isMajor = pct === 100;
        const tickLen = h * 0.006;

        ctx.beginPath();
        ctx.moveTo(pivot.x + Math.cos(a) * (r2 - tickLen), pivot.y + Math.sin(a) * (r2 - tickLen));
        ctx.lineTo(pivot.x + Math.cos(a) * r2, pivot.y + Math.sin(a) * r2);
        ctx.strokeStyle = 'rgba(193, 58, 51, 0.45)';
        ctx.lineWidth = isMajor ? w * 0.0024 : w * 0.0012;
        ctx.stroke();

        drawInkedText(ctx, pct.toString(),
            pivot.x + Math.cos(a) * (r2 - w * 0.045),
            pivot.y + Math.sin(a) * (r2 - w * 0.045),
            w * 0.012, 'rgba(168, 58, 51, 0.75)', 'center', isMajor ? 'bold' : 'normal'
        );
    });
    drawInkedText(ctx, '%', pivot.x + Math.cos(angleForDb(MAX_DB)) * (r2 - w * 0.06),
        pivot.y + Math.sin(angleForDb(MAX_DB)) * (r2 - w * 0.06), w * 0.013, 'rgba(168, 58, 51, 0.75)', 'center', 'bold');

    // --- 7. VU Logo ---
    drawInkedText(ctx, 'VU', w / 2, h * 0.38, w * 0.058, '#2a2a2a', 'center', 'bold');

    // --- 8. Calibration plate: small engraved print on the metal bezel
    // below the glass, like the reference-level etching on real gear. ---
    drawInkedText(ctx, '0 VU = +4 dBu   600Ω BALANCED', w / 2, h * 0.955, w * 0.011, 'rgba(210,208,205,0.45)', 'center', 'normal');
}

function drawGlassLayer(ctx) {
    const { w, h, inset, faceRect } = geom;

    ctx.save();
    ctx.beginPath();
    ctx.roundRect(...faceRect, w * 0.015);
    ctx.clip();

    // Base glare
    const glassGrad = ctx.createLinearGradient(0, 0, w, h);
    glassGrad.addColorStop(0, 'rgba(255,255,255,0.12)');
    glassGrad.addColorStop(0.5, 'rgba(255,255,255,0.05)');
    glassGrad.addColorStop(1, 'rgba(255,255,255,0.1)');
    ctx.fillStyle = glassGrad;
    ctx.fillRect(0, 0, w, h);

    // IMPROVEMENT: Added a second, sharp, curved highlight for more realistic glass.
    ctx.beginPath();
    ctx.moveTo(inset, inset);
    ctx.bezierCurveTo(w * 0.4, inset * 2, w * 0.6, h * 0.3, w - inset, h * 0.4);
    ctx.lineTo(w - inset, inset);
    ctx.closePath();
    ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.fill();

    // Beveled edge highlight, traced along the glass panel's own border
    // (previously this reused the leftover curved-highlight path above,
    // producing a stray diagonal glow line across the whole face).
    ctx.beginPath();
    ctx.roundRect(...faceRect, w * 0.015);
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 1.5;
    ctx.shadowColor = 'rgba(255, 255, 255, 0.8)';
    ctx.shadowBlur = 5;
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Dust specks and micro-scratches on the glass
    if (!dustPattern) dustPattern = createDustTexture(ctx, w, h);
    ctx.drawImage(dustPattern, 0, 0);

    // Edge vignette, as if lit from a single point above the meter
    const vignette = ctx.createRadialGradient(w / 2, h * 0.3, h * 0.25, w / 2, h * 0.5, h * 0.75);
    vignette.addColorStop(0, 'rgba(0,0,0,0)');
    vignette.addColorStop(1, 'rgba(0,0,0,0.28)');
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, w, h);

    ctx.restore();
}

/**
 * Composites the cached static layers plus the dynamic peak light, dB readout,
 * and needle for the current frame.
 */
function drawMeter(canvas) {
    if (!geom) return;
    const ctx = canvas.getContext('2d');
    const { w, h, dpr, pivot, r, minA, range, lamps } = geom;
    const t = (performance.now() - startTime) / 1000;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(bgLayer, 0, 0, w, h);

    // --- Backlight glow: warm, mostly steady incandescent lamps with a
    // faint flicker rather than anything tied to signal level (real VU
    // lamps just stay lit while the unit is powered). Painted with normal
    // alpha compositing — 'screen' barely registers against the light face.
    const flicker = 0.85 + Math.sin(t * 9) * 0.06 + Math.sin(t * 23.7) * 0.04;
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(...geom.faceRect, w * 0.015);
    ctx.clip();
    const currentTheme = document.querySelector('.app-container').getAttribute('data-theme');
    
    lamps.forEach((lamp) => {
        const glow = ctx.createRadialGradient(lamp.x, lamp.y, 0, lamp.x, lamp.y, w * 0.4);
        if (currentTheme === 'ssl') {
            glow.addColorStop(0, `rgba(240, 248, 255, ${0.32 * flicker})`);
            glow.addColorStop(0.4, `rgba(220, 230, 240, ${0.14 * flicker})`);
            glow.addColorStop(1, 'rgba(200, 210, 220, 0)');
        } else if (currentTheme === 'marantz') {
            glow.addColorStop(0, `rgba(130, 180, 255, ${0.4 * flicker})`);
            glow.addColorStop(0.4, `rgba(90, 140, 240, ${0.2 * flicker})`);
            glow.addColorStop(1, 'rgba(50, 100, 200, 0)');
        } else { // neve
            glow.addColorStop(0, `rgba(255, 214, 150, ${0.32 * flicker})`);
            glow.addColorStop(0.4, `rgba(255, 185, 105, ${0.14 * flicker})`);
            glow.addColorStop(1, 'rgba(255, 175, 95, 0)');
        }
        ctx.fillStyle = glow;
        ctx.fillRect(0, 0, w, h);
    });
    ctx.restore();

    // Slow, faint diagonal sheen drifting across the glass — like a studio
    // light source shifting almost imperceptibly, so the meter reads as a
    // living, photographed object rather than a static render.
    const sheenT = (Math.sin(t * 0.18) + 1) / 2; // 0..1, ~35s round trip
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(...geom.faceRect, w * 0.015);
    ctx.clip();
    const sheenX = -w * 0.3 + sheenT * w * 1.6;
    const sheen = ctx.createLinearGradient(sheenX - w * 0.18, 0, sheenX + w * 0.18, h);
    sheen.addColorStop(0, 'rgba(255,255,255,0)');
    sheen.addColorStop(0.5, 'rgba(255,255,255,0.045)');
    sheen.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = sheen;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();

    // dB Readout — clamped to the printed scale like the needle position is
    // (via normValue below), so a transient spring overshoot can't print a
    // number the dial itself has no room to show (e.g. "13.9 dB" on a scale
    // that tops out at +3).
    const displayDb = Math.max(MIN_DB, Math.min(MAX_DB, vuState.value));
    drawInkedText(ctx, `${displayDb.toFixed(1)} dB`, w / 2, h * 0.75, w * 0.035, '#444', 'center', 'bold');

    // --- Active Peak Light ---
    const peakIsActive = vuState.peak > -3;
    const lightPos = { x: w / 2, y: h * 0.55 };
    const lightRadius = w * 0.01;

    if (peakIsActive) {
        // Layered bloom: a tight hot core plus a much wider soft wash, so the
        // light reads as genuinely dazzling rather than a flat halo.
        const pulse = 0.85 + Math.sin(t * 10) * 0.15;
        const gradWide = ctx.createRadialGradient(lightPos.x, lightPos.y, 0, lightPos.x, lightPos.y, lightRadius * 9);
        gradWide.addColorStop(0, `rgba(255, 70, 60, ${0.28 * pulse})`);
        gradWide.addColorStop(0.4, `rgba(255, 70, 60, ${0.1 * pulse})`);
        gradWide.addColorStop(1, 'rgba(255, 70, 60, 0)');
        ctx.fillStyle = gradWide;
        ctx.beginPath();
        ctx.arc(lightPos.x, lightPos.y, lightRadius * 9, 0, 2 * Math.PI);
        ctx.fill();

        const gradGlow = ctx.createRadialGradient(lightPos.x, lightPos.y, 0, lightPos.x, lightPos.y, lightRadius * 4);
        gradGlow.addColorStop(0, `rgba(255, 110, 100, ${0.7 * pulse})`);
        gradGlow.addColorStop(1, 'rgba(255, 80, 80, 0)');
        ctx.fillStyle = gradGlow;
        ctx.beginPath();
        ctx.arc(lightPos.x, lightPos.y, lightRadius * 4, 0, 2 * Math.PI);
        ctx.fill();
    }

    const lensColor = peakIsActive ? 'rgba(255, 255, 255, 1)' : 'rgba(50, 20, 20, 1)';
    const lensRimColor = peakIsActive ? 'rgba(255, 100, 100, 1)' : 'rgba(30, 10, 10, 1)';
    const gradLens = ctx.createRadialGradient(lightPos.x - 1, lightPos.y - 1, 0, lightPos.x, lightPos.y, lightRadius);
    gradLens.addColorStop(0, lensColor);
    gradLens.addColorStop(1, lensRimColor);

    ctx.fillStyle = gradLens;
    ctx.beginPath();
    ctx.arc(lightPos.x, lightPos.y, lightRadius, 0, 2 * Math.PI);
    ctx.fill();

    drawInkedText(ctx, 'PEAK', w / 2, h * 0.65, w * 0.022, peakIsActive ? '#ff5050' : '#655', 'center', 'bold');

    // --- Needle & Pivot ---
    const normValue = Math.max(0, Math.min(1, (vuState.value - MIN_DB) / (MAX_DB - MIN_DB)));
    // Tiny mechanical flutter, only noticeable while the needle is actually
    // moving — like the faint tremble of a real moving-coil movement.
    const flutter = Math.sin(t * 47) * Math.min(0.35, Math.abs(vuState.velocity) * 4) * 0.003;
    const angle = minA + range * normValue + flutter;
    const needleLen = r * 0.97;
    const baseHalfWidth = w * 0.0095;
    const tipHalfWidth = w * 0.0011;
    const tipSplit = 0.86; // where the red tip segment begins, as a fraction of length

    function tracePath(fromFrac, toFrac) {
        ctx.beginPath();
        ctx.moveTo(needleLen * fromFrac, -lerpWidth(fromFrac));
        ctx.lineTo(needleLen * toFrac, -lerpWidth(toFrac));
        ctx.lineTo(needleLen, 0);
        ctx.lineTo(needleLen * toFrac, lerpWidth(toFrac));
        ctx.lineTo(needleLen * fromFrac, lerpWidth(fromFrac));
        if (fromFrac === 0) {
            ctx.closePath();
        }
    }
    function lerpWidth(frac) {
        return baseHalfWidth + (tipHalfWidth - baseHalfWidth) * frac;
    }

    // Needle shadow, cast onto the paper face below with a parallax offset
    // that grows toward the tip, as if the needle floats just under the glass.
    ctx.save();
    ctx.translate(pivot.x, pivot.y);
    ctx.rotate(angle);
    ctx.save();
    ctx.transform(1, 0, 0.06, 1, w * 0.006, w * 0.01);
    ctx.filter = 'blur(2px)';
    tracePath(0, 1);
    ctx.fillStyle = 'rgba(60, 45, 30, 0.28)';
    ctx.fill();
    ctx.restore();

    // Needle body: dark gunmetal with a red tip, like classic Sifam/Simpson movements.
    tracePath(0, tipSplit);
    const needleGrad = ctx.createLinearGradient(0, -baseHalfWidth, 0, baseHalfWidth);
    needleGrad.addColorStop(0, '#4a4a4c');
    needleGrad.addColorStop(0.45, '#232326');
    needleGrad.addColorStop(0.5, '#141416');
    needleGrad.addColorStop(1, '#050506');
    ctx.fillStyle = needleGrad;
    ctx.fill();

    tracePath(tipSplit, 1);
    const tipGrad = ctx.createLinearGradient(0, -tipHalfWidth * 3, 0, tipHalfWidth * 3);
    tipGrad.addColorStop(0, '#ff7a68');
    tipGrad.addColorStop(0.5, '#e8342b');
    tipGrad.addColorStop(1, '#8a1a1a');
    ctx.fillStyle = tipGrad;
    // The red tip glows hotter as the needle swings into the red zone, like
    // it's catching the lamp light directly — a small but dramatic cue that
    // reinforces "you're pushing it too hot."
    const hotness = Math.max(0, Math.min(1, (normValue - 0.7) / 0.3));
    if (hotness > 0) {
        ctx.shadowColor = 'rgba(255, 60, 40, 0.9)';
        ctx.shadowBlur = w * 0.02 * hotness;
    }
    ctx.fill();
    ctx.shadowBlur = 0;

    // Thin specular highlight along the top edge of the needle
    ctx.beginPath();
    ctx.moveTo(0, -baseHalfWidth * 0.5);
    ctx.lineTo(needleLen * 0.9, -tipHalfWidth * 0.5);
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.lineWidth = w * 0.0009;
    ctx.stroke();

    // Brass/Copper counterweight (extends slightly backwards from the pivot)
    const cwLen = needleLen * -0.06;
    const cwWidth = w * 0.012;
    ctx.beginPath();
    ctx.moveTo(0, -cwWidth);
    ctx.lineTo(cwLen, -cwWidth * 0.6);
    ctx.lineTo(cwLen * 1.1, 0);
    ctx.lineTo(cwLen, cwWidth * 0.6);
    ctx.lineTo(0, cwWidth);
    ctx.closePath();
    const cwGrad = ctx.createLinearGradient(0, -cwWidth, 0, cwWidth);
    cwGrad.addColorStop(0, '#b8860b'); // Dark goldenrod
    cwGrad.addColorStop(0.5, '#ffd700'); // Gold
    cwGrad.addColorStop(1, '#8b6508'); // Dark gold
    ctx.fillStyle = cwGrad;
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.lineWidth = w * 0.001;
    ctx.stroke();

    ctx.restore();

    // Pivot Screw
    const pivotR = w * 0.015;
    ctx.beginPath();
    ctx.arc(pivot.x, pivot.y, pivotR, 0, 2 * Math.PI);
    const pivotGrad = ctx.createRadialGradient(pivot.x - 2, pivot.y - 2, 1, pivot.x, pivot.y, pivotR);
    pivotGrad.addColorStop(0, '#999');
    pivotGrad.addColorStop(1, '#111');
    ctx.fillStyle = pivotGrad;
    ctx.fill();

    const slotRect = [pivot.x - pivotR * 0.8, pivot.y - pivotR * 0.15, pivotR * 1.6, pivotR * 0.3];
    const slotGrad = ctx.createLinearGradient(slotRect[0], slotRect[1], slotRect[0], slotRect[1] + slotRect[3]);
    slotGrad.addColorStop(0, '#1a1a1a');
    slotGrad.addColorStop(1, '#3a3a3a');
    ctx.fillStyle = slotGrad;
    ctx.fillRect(...slotRect);

    // --- Glass Glare & Bevel (static, composited on top) ---
    ctx.drawImage(glassLayer, 0, 0, w, h);
}
