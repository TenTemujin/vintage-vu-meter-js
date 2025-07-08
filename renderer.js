let currentStream;
let audioContext;
let analyser;

const MIN_DB = -20;
const MAX_DB = 3;

const vuState = { value: MIN_DB, peak: MIN_DB };

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

    newAnalyser.fftSize = 1024;
    newAnalyser.smoothingTimeConstant = 0.3;

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

    let avgAmplitude = data.reduce((sum, v) => sum + v, 0) / data.length;

    const gain = 2.5;
    avgAmplitude = Math.min(255, avgAmplitude * gain);

    targetDb = byteToDb(avgAmplitude);
  }

  const smoothing = 0.2;
  vuState.value = vuState.value * (1 - smoothing) + targetDb * smoothing;
  vuState.value = Math.max(MIN_DB, vuState.value);

  if (vuState.value > vuState.peak) {
    vuState.peak = vuState.value;
  } else {
    vuState.peak -= 0.05;
  }

  vuState.peak = Math.max(MIN_DB, vuState.peak);

  requestAnimationFrame(updateVolume);
}

function drawMeter() {
  const canvas = document.getElementById('vuMeter');
  const ctx = canvas.getContext('2d');

  canvas.width = canvas.clientWidth;
  canvas.height = canvas.clientHeight;

  const w = canvas.width;
  const h = canvas.height;

  const bezelColor = '#1a1a1a';
  const faceColor = '#f0e8d0';
  const textColor = '#2c2c2c';
  const redColor = '#c83830';

  const inset = w * 0.03;

  const pivot = { x: w / 2, y: h * 0.88 };
  const r = w * 0.25;

  const centerAngle = -Math.PI / 2;
  const sweepAngle = Math.PI * 0.85;
  const minA = centerAngle - sweepAngle / 2;
  const maxA = centerAngle + sweepAngle / 2;
  const range = sweepAngle;

  ctx.fillStyle = bezelColor;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = faceColor;
  ctx.fillRect(inset, inset, w - inset * 2, h - inset * 2);

  // Gerar labels a cada 3 dB de -20 até +3
  const labels = [];
  for (let db = MIN_DB; db <= MAX_DB; db += 3) {
    const pos = (db - MIN_DB) / (MAX_DB - MIN_DB);
    labels.push({ text: db.toString(), pos });
  }

  const zeroDbPos = (0 - MIN_DB) / (MAX_DB - MIN_DB);

  ctx.beginPath();
  const redZoneStartAngle = minA + range * zeroDbPos;
  ctx.arc(pivot.x, pivot.y, r, redZoneStartAngle, maxA, false);
  ctx.strokeStyle = redColor;
  ctx.lineWidth = h * 0.008;
  ctx.stroke();

  ctx.font = `bold ${w * 0.018}px 'Roboto Mono', monospace`;
  ctx.fillStyle = textColor;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  labels.forEach(label => {
    const a = minA + range * label.pos;
    ctx.beginPath();

    const tickStart = {
      x: pivot.x + Math.cos(a) * (r - h * 0.012),
      y: pivot.y + Math.sin(a) * (r - h * 0.012)
    };
    const tickEnd = {
      x: pivot.x + Math.cos(a) * (r + h * 0.012),
      y: pivot.y + Math.sin(a) * (r + h * 0.012)
    };
    ctx.moveTo(tickStart.x, tickStart.y);
    ctx.lineTo(tickEnd.x, tickEnd.y);

    ctx.strokeStyle = label.text === '0' ? redColor : textColor;
    ctx.lineWidth = label.text === '0' ? 2 : 0.8;
    ctx.stroke();

    const labelRadius = r * 1.15;
    const labelX = pivot.x + Math.cos(a) * labelRadius;
    const labelY = pivot.y + Math.sin(a) * labelRadius;
    ctx.fillText(label.text, labelX, labelY);
  });

  ctx.font = `bold ${w * 0.055}px 'Roboto Mono', monospace`;
  ctx.fillText('VU', w / 2, h * 0.45);

  const zeroDbValue = 0;
  const peakFade = Math.max(0, Math.min(1, (vuState.peak - zeroDbValue) / 3));
  const peakX = w * 0.90;
  const peakY = h * 0.80;
  const peakRadius = w * 0.012;

  ctx.beginPath();
  ctx.arc(peakX, peakY, peakRadius, 0, Math.PI * 2);
  ctx.fillStyle = `rgba(255, 69, 0, ${peakFade})`;
  ctx.shadowColor = `rgba(255, 69, 0, ${peakFade})`;
  ctx.shadowBlur = 5;
  ctx.fill();
  ctx.shadowBlur = 0;

  ctx.font = `bold ${w * 0.015}px 'Roboto Mono', monospace`;
  ctx.fillStyle = textColor;
  ctx.fillText('PEAK', peakX, peakY + h * 0.04);

  let normalizedValue = (vuState.value - MIN_DB) / (MAX_DB - MIN_DB);
  normalizedValue = Math.max(0, Math.min(1, normalizedValue));

  const angle = minA + range * normalizedValue;

  ctx.save();
  ctx.translate(pivot.x, pivot.y);
  ctx.rotate(angle + Math.PI / 2);

  const gradient = ctx.createLinearGradient(0, 0, 0, -r);
  gradient.addColorStop(0, '#444');
  gradient.addColorStop(1, '#ff2222');
  ctx.strokeStyle = gradient;

  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(0, -r);
  ctx.lineWidth = 1.5;
  ctx.shadowColor = 'rgba(0,0,0,0.3)';
  ctx.shadowOffsetY = 1;
  ctx.shadowBlur = 2;
  ctx.stroke();
  ctx.restore();

  ctx.beginPath();
  ctx.arc(pivot.x, pivot.y - h * 0.005, w * 0.020, 0, Math.PI * 2);
  ctx.fillStyle = '#1c1c1c';
  ctx.fill();

  ctx.font = `bold ${w * 0.035}px 'Roboto Mono'`;
  ctx.fillStyle = '#444';
  ctx.fillText(`${vuState.value.toFixed(1)} dB`, w / 2, h * 0.75);

  if (vuState.value > 0) {
    const peakLightX = pivot.x;
    const peakLightY = pivot.y - r * 0.6;
    const peakLightRadius = w * 0.014;

    ctx.beginPath();
    ctx.arc(peakLightX, peakLightY, peakLightRadius, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 0, 0, 0.9)';
    ctx.shadowColor = 'rgba(255, 0, 0, 0.8)';
    ctx.shadowBlur = 8;
    ctx.fill();
    ctx.shadowBlur = 0;

    ctx.font = `bold ${w * 0.018}px 'Roboto Mono', monospace`;
    ctx.fillStyle = textColor;
    ctx.fillText('PEAK', peakLightX, peakLightY + h * 0.045);
  }

  requestAnimationFrame(drawMeter);
}
