let currentStream;
let audioContext;
let analyser;

const MIN_DB = -20;
const MAX_DB = 3;

// State object includes physics properties for realistic needle movement
const vuState = {
    value: MIN_DB,
    peak: MIN_DB,
    velocity: 0,
    acceleration: 0,
};

let noisePattern = null;

// Helper to create the meter face's "old paper" texture
function createNoiseTexture(ctx) {
    const size = 128;
    const noiseCanvas = document.createElement('canvas');
    noiseCanvas.width = size;
    noiseCanvas.height = size;
    const noiseCtx = noiseCanvas.getContext('2d');
    const imageData = noiseCtx.createImageData(size, size);
    for (let i = 0; i < imageData.data.length; i += 4) {
        const val = Math.random() * 45;
        // Creates a subtle, warm gray noise pattern
        imageData.data[i] = imageData.data[i + 1] = imageData.data[i + 2] = 208 + val;
        imageData.data[i + 3] = 15; // Low alpha to make it a subtle texture
    }
    noiseCtx.putImageData(imageData, 0, 0);
    return ctx.createPattern(noiseCanvas, 'repeat');
}

window.addEventListener('DOMContentLoaded', () => {
    const select = document.getElementById('source-select');
    const alwaysOnTopCheckbox = document.getElementById('always-on-top-checkbox');
    resetDropdown('Loading sources...');
    const saved = localStorage.getItem('lastSourceId');

    if (window.electronAPI) {
        window.electronAPI.onSetSources((sources) => {
            populateDropdown(sources);
            if (saved && sources.some(s => s.id === saved)) {
                select.value = saved;
                startCapture(saved);
            }
        });
        alwaysOnTopCheckbox.addEventListener('change', () =>
            window.electronAPI.setAlwaysOnTop(alwaysOnTopCheckbox.checked)
        );
    } else {
        console.warn('Electron API not found. Running in browser mode.');
        resetDropdown('-- No sources found --');
    }

    select.addEventListener('change', () => {
        localStorage.setItem('lastSourceId', select.value);
        startCapture(select.value);
    });

    drawMeter();
    updateVolume();
});

function resetDropdown(text) {
    const select = document.getElementById('source-select');
    select.innerHTML = '';
    const option = document.createElement('option');
    option.innerText = text;
    option.value = '';
    select.appendChild(option);
}

function populateDropdown(sources) {
    resetDropdown('-- Select Audio Source --');
    sources.forEach(src => {
        const opt = document.createElement('option');
        opt.value = src.id;
        opt.innerText = src.name;
        document.getElementById('source-select').appendChild(opt);
    });
}

async function startCapture(sourceId) {
    analyser = null;
    if (!sourceId || sourceId.startsWith('--')) return;
    if (currentStream) currentStream.getTracks().forEach(t => t.stop());
    if (audioContext) await audioContext.close();

    try {
        const constraints = {
            audio: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId } },
            video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId } }
        };
        currentStream = await navigator.mediaDevices.getUserMedia(constraints);
        audioContext = new AudioContext();
        const source = audioContext.createMediaStreamSource(currentStream);
        const newAnalyser = audioContext.createAnalyser();
        newAnalyser.fftSize = 2048;
        newAnalyser.smoothingTimeConstant = 0.25;
        source.connect(newAnalyser);
        analyser = newAnalyser;
    } catch (err) {
        console.error('Error capturing audio:', err);
    }
}

function byteToDb(byteVal) {
    const amplitude = byteVal / 255;
    if (amplitude === 0) return MIN_DB;
    const db = 20 * Math.log10(amplitude);
    return Math.max(db, MIN_DB);
}

function updateVolume() {
    let targetDb = MIN_DB;
    if (analyser) {
        const data = new Uint8Array(analyser.frequencyBinCount);
        analyser.getByteFrequencyData(data);
        // Use RMS of amplitude for a value closer to perceived loudness
        const avgAmplitude = data.reduce((sum, v) => sum + v * v, 0) / data.length;
        targetDb = byteToDb(Math.sqrt(avgAmplitude) * 1.6);
    }

    // --- Needle Physics (Mass, Spring, Damping) ---
    const springiness = 0.07; // How strongly the needle is pulled to the target (Spring)
    const damping = 0.88;     // How much friction/resistance opposes the movement (Damping)

    // Calculate the force pulling the needle (F = kx)
    const force = (targetDb - vuState.value) * springiness;

    // Update acceleration (a = F/m, assuming mass m=1)
    vuState.acceleration = force;

    // Update velocity
    vuState.velocity += vuState.acceleration;
    vuState.velocity *= damping; // Apply damping

    // Update the needle's position
    vuState.value += vuState.velocity;

    // --- Peak-hold Logic ---
    if (vuState.value > vuState.peak) {
        vuState.peak = vuState.value;
    } else {
        vuState.peak -= 0.04; // How quickly the peak value falls
    }
    vuState.peak = Math.max(vuState.peak, MIN_DB);

    requestAnimationFrame(updateVolume);
}

/**
 * Renders the complete, high-realism VU meter onto the canvas.
 */
function drawMeter() {
    const canvas = document.getElementById('vuMeter');
    const ctx = canvas.getContext('2d');
    canvas.width = canvas.clientWidth;
    canvas.height = canvas.clientHeight;

    if (!noisePattern) noisePattern = createNoiseTexture(ctx);

    const w = canvas.width;
    const h = canvas.height;
    const pivot = { x: w / 2, y: h * 0.88 };
    const r = w * 0.26; // Radius of the scale arc
    const inset = w * 0.03;

    const centerAngle = -Math.PI / 2;
    const sweepAngle = Math.PI * 0.85;
    const minA = centerAngle - sweepAngle / 2;
    const maxA = centerAngle + sweepAngle / 2;
    const range = sweepAngle;
    const font = `'Helvetica Neue', 'Helvetica', 'Arial', sans-serif`;

    // --- 1. Brushed Metal Bezel ---
    ctx.fillStyle = '#111';
    ctx.fillRect(0, 0, w, h);
    ctx.save();
    ctx.translate(w/2, h/2);
    // Draw many fine, semi-transparent arcs to simulate a brushed texture
    for (let i = 0; i < 200; i++) {
        ctx.beginPath();
        ctx.arc(0, 0, Math.max(w,h) * 0.3 + i * 2, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(255, 255, 255, ${Math.random() * 0.035})`;
        ctx.stroke();
    }
    ctx.restore();

    // --- 2. Meter Face ---
    const faceRect = [inset, inset, w - inset * 2, h - inset * 2];
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(...faceRect, w * 0.015);
    ctx.clip();
    ctx.fillStyle = '#e1d8cc'; // Aged paper color
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = noisePattern; // Apply texture
    ctx.fillRect(0, 0, w, h);
    // Inner shadow to make the face look recessed
    ctx.shadowColor = 'rgba(0,0,0,0.5)';
    ctx.shadowBlur = inset;
    ctx.shadowOffsetX = inset / 4;
    ctx.shadowOffsetY = inset / 4;
    ctx.stroke();
    ctx.restore();

    // --- 3. Scale, Legends, and Text ---
    function drawInkedText(text, x, y, size, color, align = 'center', weight = 'normal') {
        ctx.font = `${weight} ${size}px ${font}`;
        ctx.textAlign = align;
        // Draw a slightly offset shadow to simulate raised ink
        ctx.fillStyle = 'rgba(0,0,0,0.25)';
        ctx.fillText(text, x + 0.5, y + 0.5);
        // Draw the main text
        ctx.fillStyle = color;
        ctx.fillText(text, x, y);
    }
    
    // Draw the scale using a loop, with numbers on each tick
    for (let db = MIN_DB; db <= MAX_DB; db += 3) {
        const pos = (db - MIN_DB) / (MAX_DB - MIN_DB);
        const a = minA + range * pos;
        const isMajor = db % 6 === 0;
        const tickLen = isMajor ? h * 0.015 : h * 0.009;
        
        ctx.beginPath();
        ctx.moveTo(pivot.x + Math.cos(a) * (r - tickLen), pivot.y + Math.sin(a) * (r - tickLen));
        ctx.lineTo(pivot.x + Math.cos(a) * r, pivot.y + Math.sin(a) * r);
        ctx.strokeStyle = `rgba(50, 50, 50, ${db >= 0 ? 0.6 : 0.4})`;
        ctx.lineWidth = isMajor ? w * 0.003 : w * 0.002;
        ctx.stroke();

        // Draw number for every point, colored red if in the positive range
        drawInkedText(db.toString(),
            pivot.x + Math.cos(a) * (r + w * 0.03),
            pivot.y + Math.sin(a) * (r + w * 0.03),
            w * 0.022, db >= 0 ? '#c13a33' : '#333'
        );
    }
    
    // VU Logo and dB Readout
    drawInkedText('VU', w / 2, h * 0.45, `bold ${w * 0.05}px ${font}`, '#333');
    drawInkedText(`${vuState.value.toFixed(1)} dB`, w / 2, h * 0.75, `bold ${w * 0.035}px ${font}`, '#444');
    
    // --- 4. Active Peak Light ---
    const peakIsActive = vuState.peak > -3;
    const lightPos = {x: w / 2, y: h * 0.55};
    const lightRadius = w * 0.01;

    if (peakIsActive) {
        // Draw a bright, blooming glow when the light is on
        const gradGlow = ctx.createRadialGradient(lightPos.x, lightPos.y, 0, lightPos.x, lightPos.y, lightRadius * 3);
        gradGlow.addColorStop(0, 'rgba(255, 50, 50, 0.4)');
        gradGlow.addColorStop(1, 'rgba(255, 50, 50, 0)');
        ctx.fillStyle = gradGlow;
        ctx.beginPath();
        ctx.arc(lightPos.x, lightPos.y, lightRadius * 3, 0, 2 * Math.PI);
        ctx.fill();
    }
    // Draw the lens itself, which is brighter when active
    const lensColor = peakIsActive ? 'rgba(255, 180, 180, 1)' : 'rgba(50, 20, 20, 1)';
    const lensRimColor = peakIsActive ? 'rgba(200, 40, 40, 1)' : 'rgba(30, 10, 10, 1)';
    const gradLens = ctx.createRadialGradient(lightPos.x - 2, lightPos.y - 2, 1, lightPos.x, lightPos.y, lightRadius);
    gradLens.addColorStop(0, lensColor);
    gradLens.addColorStop(1, lensRimColor);
    ctx.fillStyle = gradLens;
    ctx.beginPath();
    ctx.arc(lightPos.x, lightPos.y, lightRadius, 0, 2 * Math.PI);
    ctx.fill();

    // The "PEAK" text also lights up
    drawInkedText('PEAK', w / 2, h * 0.65, w * 0.022, peakIsActive ? '#ffbaba' : '#655', 'center', 'bold');

    // --- 5. Needle & Pivot ---
    const normValue = Math.max(0, Math.min(1, (vuState.value - MIN_DB) / (MAX_DB - MIN_DB)));
    const angle = minA + range * normValue;
    
    // Needle Shadow - crucial for 3D effect
    ctx.save();
    ctx.translate(pivot.x, pivot.y);
    ctx.rotate(angle);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(r, 0);
    ctx.lineWidth = w * 0.02;
    ctx.strokeStyle = 'rgba(0,0,0,0.1)';
    ctx.shadowColor = 'rgba(0,0,0,0.15)';
    ctx.shadowBlur = 10;
    ctx.shadowOffsetY = 4;
    ctx.stroke();
    ctx.restore();
    
    // Needle
    ctx.save();
    ctx.translate(pivot.x, pivot.y);
    ctx.rotate(angle);
    ctx.beginPath();
    ctx.moveTo(0, -w * 0.0035);
    ctx.lineTo(r, 0);
    ctx.lineTo(0, w * 0.0035);
    ctx.closePath();
    const needleGrad = ctx.createLinearGradient(0, -w * 0.0035, 0, w * 0.0035);
    needleGrad.addColorStop(0, '#e55a50');
    needleGrad.addColorStop(1, '#a02a23');
    ctx.fillStyle = needleGrad;
    ctx.fill();
    ctx.restore();
    
    // Pivot Screw
    const pivotR = w * 0.015;
    ctx.beginPath();
    ctx.arc(pivot.x, pivot.y, pivotR, 0, 2 * Math.PI);
    const pivotGrad = ctx.createRadialGradient(pivot.x - 2, pivot.y - 2, 1, pivot.x, pivot.y, pivotR);
    pivotGrad.addColorStop(0, '#777');
    pivotGrad.addColorStop(1, '#222');
    ctx.fillStyle = pivotGrad;
    ctx.fill();
    ctx.fillStyle = '#2a2a2a'; // Screw slot
    ctx.fillRect(pivot.x - pivotR * 0.8, pivot.y - pivotR * 0.15, pivotR * 1.6, pivotR * 0.3);

    // --- 6. Glass Glare & Bevel ---
    ctx.save();
    ctx.roundRect(...faceRect, w * 0.015);
    ctx.clip();
    const glassGrad = ctx.createLinearGradient(0, 0, w, h);
    glassGrad.addColorStop(0, 'rgba(255,255,255,0.12)');
    glassGrad.addColorStop(0.5, 'rgba(255,255,255,0)');
    ctx.fillStyle = glassGrad;
    ctx.fillRect(0,0,w,h);
    // Beveled edge highlight
    ctx.strokeStyle = 'rgba(255,255,255,0.3)';
    ctx.lineWidth = 1.5;
    ctx.shadowColor = 'white';
    ctx.shadowBlur = 4;
    ctx.stroke();
    ctx.restore();

    requestAnimationFrame(drawMeter);
}