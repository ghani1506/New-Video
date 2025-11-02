// V2: Robust OpenCV init + smoother frame loop + better errors
let cvReady = false;
let processing = false;
let rec = null;
let recordedChunks = [];
let rafId = null;
let frameHandle = null;

const vid = document.getElementById('vid');
const canvasOut = document.getElementById('out');
const ctxOut = canvasOut.getContext('2d', { willReadFrequently: true });
const fileInput = document.getElementById('fileInput');
const statusEl = document.getElementById('status');

const scaleSel = document.getElementById('scale');
const satRange = document.getElementById('sat');
const sharpRange = document.getElementById('sharp');
const denoiseRange = document.getElementById('denoise');
const warmRange = document.getElementById('warm');

const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const recBtn = document.getElementById('recBtn');
const dlBtn = document.getElementById('dlBtn');

// Correct init for @techstark/opencv-js
if (typeof cv === 'undefined') {
  status('OpenCV script not loaded yet…');
} else {
  cv.onRuntimeInitialized = () => {
    cvReady = true;
    status('OpenCV.js loaded. Choose a video.');
  };
}

// Helper
function status(t){ statusEl.textContent = t; }

fileInput.addEventListener('change', e => {
  const f = e.target.files?.[0];
  if(!f){ return; }
  const url = URL.createObjectURL(f);
  vid.src = url;
  vid.onloadedmetadata = () => {
    startBtn.disabled = false;
    recBtn.disabled = !(window.MediaRecorder && (MediaRecorder.isTypeSupported('video/webm;codecs=vp9') || MediaRecorder.isTypeSupported('video/webm;codecs=vp8')));
    if (!recBtn.disabled) recBtn.title = 'Record processed output (WebM)';
    else recBtn.title = 'Recording not supported in this browser';
    status('Ready. Click Start to preview colorised video.');
  };
});

startBtn.addEventListener('click', () => {
  if (!cvReady){ status('Still loading OpenCV.js…'); return; }
  if (!vid.videoWidth){ status('Load a video first.'); return; }
  processing = true;
  stopBtn.disabled = false;
  startBtn.disabled = true;
  run();
});

stopBtn.addEventListener('click', () => {
  stopProcessingLoop();
  startBtn.disabled = false;
  stopBtn.disabled = true;
});

recBtn.addEventListener('click', () => {
  if (rec && rec.state === 'recording') {
    rec.stop();
    recBtn.textContent = '● Record';
    return;
  }
  if (!window.MediaRecorder) { alert('MediaRecorder not supported here.'); return; }
  const stream = canvasOut.captureStream(30);
  const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ?
    'video/webm;codecs=vp9' : (MediaRecorder.isTypeSupported('video/webm;codecs=vp8') ? 'video/webm;codecs=vp8' : 'video/webm');
  try{
    rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 4_000_000 });
  }catch(err){
    alert('Recording not supported: ' + err.message);
    return;
  }
  recordedChunks = [];
  rec.ondataavailable = (e) => { if(e.data && e.data.size) recordedChunks.push(e.data); };
  rec.onstop = () => {
    const blob = new Blob(recordedChunks, { type: rec.mimeType });
    dlBtn.href = URL.createObjectURL(blob);
    dlBtn.setAttribute('aria-disabled', 'false');
  };
  rec.start();
  recBtn.textContent = '■ Stop Rec';
});

function stopProcessingLoop(){
  processing = false;
  if (rafId) cancelAnimationFrame(rafId);
  if (frameHandle && vid.cancelVideoFrameCallback) vid.cancelVideoFrameCallback(frameHandle);
  frameHandle = null;
}

function isGrayscale(mat){
  // Check saturation in HSV
  const rgb = new cv.Mat();
  cv.cvtColor(mat, rgb, cv.COLOR_RGBA2RGB);
  const hsv = new cv.Mat();
  cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
  const chans = new cv.MatVector();
  cv.split(hsv, chans);
  const S = chans.get(1);
  const mean = cv.mean(S)[0];
  S.delete(); chans.delete(); hsv.delete(); rgb.delete();
  return mean < 12;
}

function grayWorldWB(src){
  const rgb = new cv.Mat(); cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
  const chans = new cv.MatVector(); cv.split(rgb, chans);
  const r = chans.get(2), g = chans.get(1), b = chans.get(0);
  const rMean = cv.mean(r)[0], gMean = cv.mean(g)[0], bMean = cv.mean(b)[0];
  const gray = (rMean + gMean + bMean)/3;
  const rGain = gray / (rMean + 1e-6), gGain = gray / (gMean + 1e-6), bGain = gray / (bMean + 1e-6);
  cv.multiply(r, new cv.Mat(r.rows, r.cols, r.type(), rGain), r);
  cv.multiply(g, new cv.Mat(g.rows, g.cols, g.type(), gGain), g);
  cv.multiply(b, new cv.Mat(b.rows, b.cols, b.type(), bGain), b);
  chans.set(0,b); chans.set(1,g); chans.set(2,r);
  const merged = new cv.Mat(); cv.merge(chans, merged);
  const out = new cv.Mat(); cv.cvtColor(merged, out, cv.COLOR_RGB2RGBA);
  r.delete(); g.delete(); b.delete(); merged.delete(); chans.delete(); rgb.delete();
  return out;
}

function claheL(src){
  const lab = new cv.Mat(); cv.cvtColor(src, lab, cv.COLOR_RGBA2LAB);
  const v = new cv.MatVector(); cv.split(lab, v);
  const L = v.get(0);
  const clahe = new cv.CLAHE(3.0, new cv.Size(8,8));
  clahe.apply(L, L);
  v.set(0, L);
  cv.merge(v, lab);
  const out = new cv.Mat(); cv.cvtColor(lab, out, cv.COLOR_LAB2RGBA);
  L.delete(); v.delete(); clahe.delete(); lab.delete();
  return out;
}

function recolourLAB(src, warmth=8){
  const lab = new cv.Mat(); cv.cvtColor(src, lab, cv.COLOR_RGBA2LAB);
  const v = new cv.MatVector(); cv.split(lab, v);
  const A = v.get(1), B = v.get(2);
  const aBias = new cv.Mat(A.rows, A.cols, A.type(), Math.max(0, Number(warmth)));
  const bBias = new cv.Mat(B.rows, B.cols, B.type(), Math.max(0, Number(warmth)*1.8));
  cv.add(A, aBias, A);
  cv.add(B, bBias, B);
  v.set(1, A); v.set(2, B);
  cv.merge(v, lab);
  const out = new cv.Mat(); cv.cvtColor(lab, out, cv.COLOR_LAB2RGBA);
  A.delete(); B.delete(); aBias.delete(); bBias.delete(); v.delete(); lab.delete();
  return out;
}

function boostSaturation(src, amount){
  const hsv = new cv.Mat(); cv.cvtColor(src, hsv, cv.COLOR_RGBA2RGB); cv.cvtColor(hsv, hsv, cv.COLOR_RGB2HSV);
  const v = new cv.MatVector(); cv.split(hsv, v); const S = v.get(1);
  const scale = 1 + Number(amount)/100;
  cv.multiply(S, new cv.Mat(S.rows, S.cols, S.type(), scale), S);
  cv.min(S, new cv.Mat(S.rows, S.cols, S.type(), 255), S);
  v.set(1, S); cv.merge(v, hsv);
  const out = new cv.Mat(); cv.cvtColor(hsv, out, cv.COLOR_HSV2RGB); cv.cvtColor(out, out, cv.COLOR_RGB2RGBA);
  S.delete(); v.delete(); hsv.delete();
  return out;
}

function bilateral(src, strength){
  const s = Number(strength);
  if (s<=0) return src.clone();
  const rgb = new cv.Mat(); cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
  const out = new cv.Mat(); cv.bilateralFilter(rgb, out, 7, 25+s*2, 5+s*0.6);
  const dst = new cv.Mat(); cv.cvtColor(out, dst, cv.COLOR_RGB2RGBA);
  rgb.delete(); out.delete();
  return dst;
}

function unsharp(src, amount){
  const a = Number(amount)/100;
  const sigma = 0.8 + a*2.0;
  const k = 0.6 + a*1.0;
  const blur = new cv.Mat();
  cv.GaussianBlur(src, blur, new cv.Size(0,0), sigma, sigma);
  const out = new cv.Mat();
  cv.addWeighted(src, 1+k, blur, -k, 0, out);
  blur.delete();
  return out;
}

function upscale(src, factor){
  const f = Number(factor||1);
  if (f===1) return src.clone();
  const dst = new cv.Mat();
  const dsize = new cv.Size(Math.round(src.cols*f), Math.round(src.rows*f));
  cv.resize(src, dst, dsize, 0, 0, cv.INTER_CUBIC);
  return dst;
}

let prevAB = null;
function chromaSmoothLAB(curr, alpha=0.65){
  const lab = new cv.Mat(); cv.cvtColor(curr, lab, cv.COLOR_RGBA2LAB);
  const v = new cv.MatVector(); cv.split(lab, v);
  const L = v.get(0), A = v.get(1), B = v.get(2);
  if (prevAB){
    const [pA, pB] = prevAB;
    cv.addWeighted(A, 1-alpha, pA, alpha, 0, A);
    cv.addWeighted(B, 1-alpha, pB, alpha, 0, B);
    pA.delete(); pB.delete();
  }
  prevAB = [A.clone(), B.clone()];
  v.set(0, L); v.set(1, A); v.set(2, B);
  cv.merge(v, lab);
  const out = new cv.Mat(); cv.cvtColor(lab, out, cv.COLOR_LAB2RGBA);
  L.delete(); A.delete(); B.delete(); v.delete(); lab.delete();
  return out;
}

function readFrameToMat(){
  const tw = vid.videoWidth, th = vid.videoHeight;
  if (!tw || !th) return null;
  const tmp = document.createElement('canvas');
  tmp.width = tw; tmp.height = th;
  const tctx = tmp.getContext('2d');
  tctx.drawImage(vid, 0, 0, tw, th);
  const img = tctx.getImageData(0,0,tw,th);
  return cv.matFromImageData(img);
}

function processFrame(srcImg){
  let step = claheL(srcImg);
  let wb = grayWorldWB(step); step.delete();
  let colored = wb;
  if (isGrayscale(wb)) {
    colored = recolourLAB(wb, warmRange.value);
    wb.delete();
  }
  let smooth = chromaSmoothLAB(colored, 0.65);
  colored.delete();
  let den = bilateral(smooth, denoiseRange.value); smooth.delete();
  let sh = unsharp(den, sharpRange.value); den.delete();
  let sat = boostSaturation(sh, satRange.value); sh.delete();
  let up = upscale(sat, scaleSel.value); sat.delete();
  return up;
}

function drawProcessedToCanvas(mat){
  const img = new ImageData(new Uint8ClampedArray(mat.data), mat.cols, mat.rows);
  canvasOut.width = mat.cols; canvasOut.height = mat.rows;
  ctxOut.putImageData(img, 0, 0);
}

function frameLoop(){
  if (!processing) return;
  const src = readFrameToMat();
  if (src){
    try{
      const out = processFrame(src);
      drawProcessedToCanvas(out);
      out.delete();
    }catch(err){
      console.error(err);
      status('Processing error: ' + err.message);
      stopProcessingLoop();
    } finally {
      src.delete();
    }
  }
  if ('requestVideoFrameCallback' in vid) {
    frameHandle = vid.requestVideoFrameCallback(() => frameLoop());
  } else {
    rafId = requestAnimationFrame(frameLoop);
  }
}

async function run(){
  try {
    await vid.play();
  } catch (e) {
    // Autoplay might require a user gesture; fallback: prompt user to play
    status('Press Play on the left video, then click Start again.');
    return;
  }
  frameLoop();
}
