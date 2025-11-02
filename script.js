// Turbo build: GPU WebGL shader pipeline, no OpenCV, no MediaRecorder.
// Very fast preview with optional frame skipping and resolution cap.
let gl, program, tex, posBuf, uvBuf;
let processing = false, rafId = null, frameHandle = null;
const vid = document.getElementById('vid');
const canvas = document.getElementById('glcanvas');
const fileInput = document.getElementById('fileInput');
const statusEl = document.getElementById('status');

const modeSel = document.getElementById('mode');
const warmRange = document.getElementById('warm');
const satRange = document.getElementById('sat');
const sharpRange = document.getElementById('sharp');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');

function status(t){ statusEl.textContent = t; }

fileInput.addEventListener('change', e => {
  const f = e.target.files?.[0];
  if(!f) return;
  const url = URL.createObjectURL(f);
  vid.src = url;
  vid.onloadedmetadata = () => {
    initGL();
    startBtn.disabled = false;
    status('Ready. Click Start.');
  };
});

startBtn.addEventListener('click', async () => {
  if (!vid.videoWidth) return;
  processing = true; stopBtn.disabled = false; startBtn.disabled = true;
  try { await vid.play(); } catch { status('Press Play on left video, then Start.'); return; }
  loop(true);
});

stopBtn.addEventListener('click', () => {
  processing = false; startBtn.disabled = false; stopBtn.disabled = true;
  if (rafId) cancelAnimationFrame(rafId);
  if (frameHandle && vid.cancelVideoFrameCallback) vid.cancelVideoFrameCallback(frameHandle);
  frameHandle = null;
});

function initGL(){
  if (gl) return;
  gl = canvas.getContext('webgl', { preserveDrawingBuffer: false, powerPreference: 'high-performance' });
  if (!gl) { status('WebGL not available. Try another browser/device.'); return; }

  const vsSrc = `
    attribute vec2 a_pos;
    attribute vec2 a_uv;
    varying vec2 v_uv;
    void main() {
      v_uv = a_uv;
      gl_Position = vec4(a_pos, 0.0, 1.0);
    }
  `;

  // Fragment shader:
  // 1) Read video texture
  // 2) Detect grayscale (low saturation proxy)
  // 3) If grayscale: assign hue by luminance gradient (cool -> warm), add saturation based on control
  // 4) Mild unsharp via 5-tap kernel
  // 5) Gamma correction
  const fsSrc = `
    precision mediump float;
    varying vec2 v_uv;
    uniform sampler2D u_tex;
    uniform vec2 u_texSize;
    uniform float u_warm;   // 0..1
    uniform float u_sat;    // 0..1
    uniform float u_sharp;  // 0..1

    vec3 rgb2hsl(vec3 c){
      float maxc = max(max(c.r,c.g),c.b);
      float minc = min(min(c.r,c.g),c.b);
      float L = (maxc+minc)*0.5;
      float S = 0.0;
      float H = 0.0;
      if (maxc != minc) {
        float d = maxc - minc;
        S = L > 0.5 ? d/(2.0 - maxc - minc) : d/(maxc + minc);
        if (maxc == c.r) H = (c.g - c.b) / d + (c.g < c.b ? 6.0 : 0.0);
        else if (maxc == c.g) H = (c.b - c.r) / d + 2.0;
        else H = (c.r - c.g) / d + 4.0;
        H /= 6.0;
      }
      return vec3(H,S,L);
    }
    float hue2rgb(float p, float q, float t){
      if (t < 0.0) t += 1.0;
      if (t > 1.0) t -= 1.0;
      if (t < 1.0/6.0) return p + (q - p) * 6.0 * t;
      if (t < 1.0/2.0) return q;
      if (t < 2.0/3.0) return p + (q - p) * (2.0/3.0 - t) * 6.0;
      return p;
    }
    vec3 hsl2rgb(vec3 hsl){
      float H=hsl.x, S=hsl.y, L=hsl.z;
      float r,g,b;
      if (S==0.0){ r=g=b=L; }
      else{
        float q = L < 0.5 ? L * (1.0 + S) : L + S - L * S;
        float p = 2.0 * L - q;
        r = hue2rgb(p, q, H + 1.0/3.0);
        g = hue2rgb(p, q, H);
        b = hue2rgb(p, q, H - 1.0/3.0);
      }
      return vec3(r,g,b);
    }

    vec3 recolor(vec3 rgb){
      // Convert to HSL
      vec3 hsl = rgb2hsl(rgb);
      float sat = hsl.y;
      // Treat low-sat as grayscale
      float isBW = step(sat, 0.12); // 1 if grayscale-ish
      // Hue map by luminance: dark -> cool, bright -> warm
      float hueCool = 0.58; // ~210°
      float hueWarm = 0.06; // ~22°
      float L = pow(hsl.z, 1.05);
      float hue = mix(hueCool, hueWarm, clamp(L + u_warm*0.3, 0.0, 1.0));
      // Base saturation proportional to luminance (avoid color in deep shadows)
      float baseS = smoothstep(0.05, 0.85, L) * (0.35 + 0.5*u_sat);
      vec3 hslNew = vec3(hue, baseS, hsl.z);
      vec3 colored = hsl2rgb(hslNew);
      // Blend only where grayscale-ish
      vec3 outc = mix(rgb, colored, isBW);
      // Global saturation boost
      vec3 ohsl = rgb2hsl(outc);
      ohsl.y = clamp(ohsl.y * (1.0 + 0.8*u_sat), 0.0, 1.0);
      outc = hsl2rgb(ohsl);
      return outc;
    }

    void main(){
      vec2 texel = 1.0 / u_texSize;
      vec3 c = texture2D(u_tex, v_uv).rgb;

      // Mild unsharp (5-tap cross)
      float k = u_sharp * 0.6;
      vec3 up    = texture2D(u_tex, v_uv + vec2(0.0, -texel.y)).rgb;
      vec3 down  = texture2D(u_tex, v_uv + vec2(0.0,  texel.y)).rgb;
      vec3 left  = texture2D(u_tex, v_uv + vec2(-texel.x, 0.0)).rgb;
      vec3 right = texture2D(u_tex, v_uv + vec2( texel.x, 0.0)).rgb;
      vec3 blur = (up + down + left + right + c) / 5.0;
      vec3 sharp = mix(c, c + (c - blur), k);

      // Recolour
      vec3 col = recolor(sharp);

      // Simple gamma
      col = pow(col, vec3(1.0/1.1));
      gl_FragColor = vec4(col, 1.0);
    }
  `;

  function compile(type, src){
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(s));
    }
    return s;
  }

  const vs = compile(gl.VERTEX_SHADER, vsSrc);
  const fs = compile(gl.FRAGMENT_SHADER, fsSrc);
  program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program));
  }
  gl.useProgram(program);

  // Buffers
  posBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
    -1,-1,  1,-1,  -1,1,   -1,1,  1,-1,  1,1
  ]), gl.STATIC_DRAW);

  uvBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
    0,1,  1,1,  0,0,  0,0,  1,1,  1,0
  ]), gl.STATIC_DRAW);

  // Attributes
  const a_pos = gl.getAttribLocation(program, 'a_pos');
  gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
  gl.enableVertexAttribArray(a_pos);
  gl.vertexAttribPointer(a_pos, 2, gl.FLOAT, false, 0, 0);

  const a_uv = gl.getAttribLocation(program, 'a_uv');
  gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf);
  gl.enableVertexAttribArray(a_uv);
  gl.vertexAttribPointer(a_uv, 2, gl.FLOAT, false, 0, 0);

  // Texture
  tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
}

function capSize(w, h){
  const cap = modeSel.value === 'fast' ? 720 : 1080;
  if (h <= cap) return {w,h};
  const r = cap / h;
  return {w: Math.round(w*r), h: Math.round(h*r)};
}

function uploadVideoFrame(){
  const tw = vid.videoWidth, th = vid.videoHeight;
  if (!tw || !th) return;
  const {w,h} = capSize(tw, th);
  if (canvas.width !== w || canvas.height !== h){
    canvas.width = w; canvas.height = h;
    gl.viewport(0, 0, w, h);
  }
  // Upload frame to texture
  gl.bindTexture(gl.TEXTURE_2D, tex);
  // For best perf, many browsers support texImage2D(video) directly
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, vid);
  // Uniforms
  const u_tex = gl.getUniformLocation(program, 'u_tex');
  const u_texSize = gl.getUniformLocation(program, 'u_texSize');
  const u_warm = gl.getUniformLocation(program, 'u_warm');
  const u_sat = gl.getUniformLocation(program, 'u_sat');
  const u_sharp = gl.getUniformLocation(program, 'u_sharp');
  gl.uniform1i(u_tex, 0);
  gl.uniform2f(u_texSize, w, h);
  gl.uniform1f(u_warm, Number(warmRange.value)/100.0);
  gl.uniform1f(u_sat, Number(satRange.value)/100.0);
  gl.uniform1f(u_sharp, Number(sharpRange.value)/100.0);
  // Draw
  gl.drawArrays(gl.TRIANGLES, 0, 6);
}

let skip = false;
function loop(first=false){
  if (!processing) return;
  if (modeSel.value === 'fast' && !first){
    skip = !skip;
    if (skip){
      scheduleNext(); return;
    }
  }
  uploadVideoFrame();
  scheduleNext();
}
function scheduleNext(){
  if ('requestVideoFrameCallback' in vid){
    frameHandle = vid.requestVideoFrameCallback(()=>loop());
  } else {
    rafId = requestAnimationFrame(loop);
  }
}
