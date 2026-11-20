// Miva Stars admin: camera QR scanner for the gate.
// Uses the browser's built-in BarcodeDetector when available (most Android
// phones), otherwise the bundled jsQR library (iPhone). Frames never leave
// the phone; only the token read from the QR is sent to the database.

const QR_PREFIX = 'MIVAFEST1:';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Turn raw QR text into a ticket token, or null if it isn't a Miva Stars ticket.
export function parseTicketQr(text) {
  if (typeof text !== 'string' || !text.startsWith(QR_PREFIX)) return null;
  const token = text.slice(QR_PREFIX.length).trim();
  return UUID.test(token) ? token.toLowerCase() : null;
}

export class Scanner {
  constructor(video, onText) {
    this.video = video;
    this.onText = onText;
    this.stream = null;
    this.running = false;
    this.paused = false;
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.detector = null;
    this.lastScan = 0;
  }

  async start() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('no_camera');
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' } }, audio: false
    });
    this.video.srcObject = this.stream;
    this.video.setAttribute('playsinline', '');
    this.video.muted = true;
    await this.video.play();
    if ('BarcodeDetector' in window) {
      try {
        const formats = await window.BarcodeDetector.getSupportedFormats();
        if (formats.includes('qr_code')) this.detector = new window.BarcodeDetector({ formats: ['qr_code'] });
      } catch { this.detector = null; }
    }
    this.running = true;
    this.paused = false;
    requestAnimationFrame((t) => this.tick(t));
  }

  stop() {
    this.running = false;
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
  }

  pause() { this.paused = true; }
  resume() { this.paused = false; }

  async tick(t) {
    if (!this.running) return;
    if (!this.paused && t - this.lastScan > 200 && this.video.readyState >= 2) {
      this.lastScan = t;
      const text = await this.readFrame();
      if (text && !this.paused && this.running) {
        this.paused = true;
        this.onText(text);
      }
    }
    requestAnimationFrame((n) => this.tick(n));
  }

  async readFrame() {
    const v = this.video;
    if (!v.videoWidth) return null;
    if (this.detector) {
      try {
        const codes = await this.detector.detect(v);
        return codes.length ? codes[0].rawValue : null;
      } catch { this.detector = null; }
    }
    if (typeof window.jsQR !== 'function') return null;
    const scale = Math.min(1, 640 / v.videoWidth);
    const w = Math.round(v.videoWidth * scale), h = Math.round(v.videoHeight * scale);
    this.canvas.width = w;
    this.canvas.height = h;
    this.ctx.drawImage(v, 0, 0, w, h);
    const img = this.ctx.getImageData(0, 0, w, h);
    const found = window.jsQR(img.data, w, h, { inversionAttempts: 'dontInvert' });
    return found ? found.data : null;
  }
}
