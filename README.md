# In‑Browser B/W Video Coloriser (V2, Fixed)

**What changed vs V1**
- Correct OpenCV.js init (`cv.onRuntimeInitialized = ...`)
- Smoother frame timing via `requestVideoFrameCallback` when available
- Better Safari/iOS handling for recording (graceful disable)
- Clearer status + error messages

## Use
1. Open `index.html` from GitHub Pages.
2. Upload a B/W video → Click **Start**.
3. Tweak sliders; **Record** if supported → **Download** WebM.

## Deploy to GitHub Pages
- Put files in repo root or `/docs`, then Settings → Pages → Deploy from branch.

## Convert WebM → MP4
```bash
ffmpeg -i colorised.webm -c:v libx264 -crf 18 -preset slow -c:a aac colorised.mp4
```
