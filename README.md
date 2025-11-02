# B/W → Colour (Turbo • WebGL)

Ultra‑fast, GPU‑accelerated preview using **WebGL shaders** (no OpenCV, no recording). Perfect for smooth, modernised color on black‑and‑white videos right in the browser.

## Why it's fast
- All processing runs in **one fragment shader** on the GPU.
- Resolution is capped (720p Fast, 1080p Quality).
- Optional frame skipping in Fast mode.
- No MediaRecorder/encoding overhead during preview.

## Use
1. Open the page → upload a video → **Start**.
2. Adjust **Warmth**, **Color Boost**, **Sharpness**.
3. If you need to export, screen‑record the preview or use the previous builds with recording.

## Deploy (GitHub Pages)
Put these files in a repo (root or `/docs`) → Settings → Pages → Deploy from branch.

## Notes
- Shader colorisation: detects low‑saturation regions (grayscale‑ish), assigns hue by luminance (cool → warm) plus user warmth; boosts saturation; mild unsharp; gamma.
- Works best on desktop Chromium browsers. iOS Safari supports WebGL but performance varies.
