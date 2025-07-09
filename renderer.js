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
        const avgAmplitude = data.reduce((sum, v) => sum + v * v, 0) / data.length;
        targetDb = byteToDb(Math.sqrt(avgAmplitude) * 1.6);
    }

    // --- Needle Physics (Mass, Spring, Damping) ---
    const springiness = 0.07;
    const damping = 0.88;    

    const force = (targetDb - vuState.value) * springiness;
    vuState.acceleration = force;
    vuState.velocity += vuState.acceleration;
    vuState.velocity *= damping;
    vuState.value += vuState.velocity;

    // --- Peak-hold Logic ---
    if (vuState.value > vuState.peak) {
        vuState.peak = vuState.value;
    } else {
        vuState.peak -= 0.04;
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
    const r = w * 0.26;
    const inset = w * 0.03;

    const centerAngle = -Math.PI / 2;
    const sweepAngle = Math.PI * 0.85;
    const minA = centerAngle - sweepAngle / 2;
    const maxA = centerAngle + sweepAngle / 2;
    const range = sweepAngle;
    const font = `'Helvetica Neue', 'Helvetica', 'Arial', sans-serif`;

    // --- 1. Brushed Metal Bezel ---
    // IMPROVEMENT: Added a base gradient to simulate light on a curved metal surface.
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
        // Vary alpha and add a slight color tint to the brushing
        ctx.strokeStyle = `rgba(255, 255, 255, ${Math.random() * 0.03 + 0.005})`;
        ctx.stroke();
    }
    ctx.restore();

    // --- 2. Meter Face ---
    const faceRect = [inset, inset, w - inset * 2, h - inset * 2];
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(...faceRect, w * 0.015);
    ctx.clip();
    ctx.fillStyle = '#e1d8cc';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = noisePattern;
    ctx.fillRect(0, 0, w, h);
    ctx.shadowColor = 'rgba(0,0,0,0.6)';
    ctx.shadowBlur = inset * 1.2;
    ctx.shadowOffsetX = inset / 3;
    ctx.shadowOffsetY = inset / 3;
    ctx.stroke();
    ctx.restore();

    // --- 3. Scale, Legends, and Text ---
    function drawInkedText(text, x, y, size, color, align = 'center', weight = 'normal') {
        ctx.font = `${weight} ${size}px ${font}`;
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

    // Draw the scale
    for (let db = MIN_DB; db <= MAX_DB; db += 3) {
        const pos = (db - MIN_DB) / (MAX_DB - MIN_DB);
        const a = minA + range * pos;
        const isMajor = db % 6 === 0;
        const tickLen = isMajor ? h * 0.015 : h * 0.009;

        ctx.beginPath();
        ctx.moveTo(pivot.x + Math.cos(a) * (r - tickLen), pivot.y + Math.sin(a) * (r - tickLen));
        ctx.lineTo(pivot.x + Math.cos(a) * r, pivot.y + Math.sin(a) * r);
        ctx.strokeStyle = `rgba(50, 50, 50, ${db >= 0 ? 0.7 : 0.5})`;
        ctx.lineWidth = isMajor ? w * 0.0035 : w * 0.002;
        ctx.stroke();

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
        const gradGlow = ctx.createRadialGradient(lightPos.x, lightPos.y, 0, lightPos.x, lightPos.y, lightRadius * 4);
        gradGlow.addColorStop(0, 'rgba(255, 80, 80, 0.5)');
        gradGlow.addColorStop(1, 'rgba(255, 80, 80, 0)');
        ctx.fillStyle = gradGlow;
        ctx.beginPath();
        ctx.arc(lightPos.x, lightPos.y, lightRadius * 4, 0, 2 * Math.PI);
        ctx.fill();
    }
    
    // IMPROVEMENT: Brighter hotspot in the lens when active.
    const lensColor = peakIsActive ? 'rgba(255, 255, 255, 1)' : 'rgba(50, 20, 20, 1)';
    const lensRimColor = peakIsActive ? 'rgba(255, 100, 100, 1)' : 'rgba(30, 10, 10, 1)';
    const gradLens = ctx.createRadialGradient(lightPos.x - 1, lightPos.y - 1, 0, lightPos.x, lightPos.y, lightRadius);
    gradLens.addColorStop(0, lensColor);
    gradLens.addColorStop(1, lensRimColor);
    
    ctx.fillStyle = gradLens;
    ctx.beginPath();
    ctx.arc(lightPos.x, lightPos.y, lightRadius, 0, 2 * Math.PI);
    ctx.fill();
    
    drawInkedText('PEAK', w / 2, h * 0.65, w * 0.022, peakIsActive ? '#ff5050' : '#655', 'center', 'bold');

    // --- 5. Needle & Pivot ---
    const normValue = Math.max(0, Math.min(1, (vuState.value - MIN_DB) / (MAX_DB - MIN_DB)));
    const angle = minA + range * normValue;

    // Needle Shadow
    ctx.save();
    ctx.translate(pivot.x, pivot.y);
    ctx.rotate(angle);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(r, 0);
    ctx.lineWidth = w * 0.02;
    ctx.strokeStyle = 'rgba(0,0,0,0.12)';
    ctx.shadowColor = 'rgba(0,0,0,0.2)';
    ctx.shadowBlur = 12;
    ctx.shadowOffsetY = 5;
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
    
    // IMPROVEMENT: More complex gradient for a 3D, rounded needle with a specular highlight.
    const needleGrad = ctx.createLinearGradient(r / 2, -w * 0.01, r / 2, w * 0.01);
    needleGrad.addColorStop(0, '#e55a50');
    needleGrad.addColorStop(0.45, '#ff8a80'); // Specular highlight
    needleGrad.addColorStop(0.5, '#ff8a80');  // Specular highlight
    needleGrad.addColorStop(1, '#a02a23');
    ctx.fillStyle = needleGrad;
    ctx.fill();
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
    
    // IMPROVEMENT: Added a simple gradient to the screw slot to give it depth.
    const slotRect = [pivot.x - pivotR * 0.8, pivot.y - pivotR * 0.15, pivotR * 1.6, pivotR * 0.3];
    const slotGrad = ctx.createLinearGradient(slotRect[0], slotRect[1], slotRect[0], slotRect[1] + slotRect[3]);
    slotGrad.addColorStop(0, '#1a1a1a');
    slotGrad.addColorStop(1, '#3a3a3a');
    ctx.fillStyle = slotGrad; 
    ctx.fillRect(...slotRect);

    // --- 6. Glass Glare & Bevel ---
    ctx.save();
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

    // Beveled edge highlight
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 1.5;
    ctx.shadowColor = 'rgba(255, 255, 255, 0.8)';
    ctx.shadowBlur = 5;
    ctx.stroke();
    
    ctx.restore();

    requestAnimationFrame(drawMeter);
}