// The overlay's glass, running on a static image instead of a live screen
// capture. The shader is copied verbatim from the app's index.html: it takes
// the backdrop as a plain sampler2D plus a crop rect and has no idea where the
// pixels came from, which is the whole reason this port is possible.

const VS_SOURCE = `
      attribute vec2 aPos;
      varying vec2 vUv;
      void main() {
        vUv = vec2(aPos.x * 0.5 + 0.5, 1.0 - (aPos.y * 0.5 + 0.5));
        gl_Position = vec4(aPos, 0.0, 1.0);
      }
    `;

const FS_SOURCE = `
      precision mediump float;
      varying vec2 vUv;
      uniform sampler2D uVideo;
      uniform vec2 uCropOrigin;
      uniform vec2 uCropSize;
      uniform vec2 uSizePx;
      uniform float uRadiusPx;
      uniform float uBevelPx;
      uniform float uBulge;
      uniform float uAberration;
      uniform float uBlurPx;
      uniform float uTint;
      uniform float uBloom;
      uniform vec2 uCursorUv;      // pointer position in video-texture space
      uniform vec2 uCursorRadUv;   // dodge radius per axis; 0 = pointer not over the bar

      float sdRoundBox(vec2 p, vec2 b, float r) {
        vec2 q = abs(p) - b + r;
        return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
      }

      // The screen capture has the mouse pointer composited into it, and the
      // 13-tap blur below resamples it once per tap — so a single dark arrow
      // became a cluster of ghost arrows crawling around inside the glass,
      // obvious against light grey. Samples landing on the pointer are pushed
      // out to the rim of a small disc around it, so it never enters the
      // material. The real pointer is drawn by the OS on top of the window and
      // is unaffected.
      vec2 dodgeCursor(vec2 uv) {
        if (uCursorRadUv.x <= 0.0) return uv;
        vec2 q = (uv - uCursorUv) / uCursorRadUv;
        float r = length(q);
        if (r >= 1.0) return uv;
        return uCursorUv + (q / max(r, 1e-4)) * uCursorRadUv;
      }

      // 13-tap disc blur (centre + two hex rings) — the frosted part of the glass.
      vec3 frost(vec2 uv, vec2 texel, float rad) {
        vec3 sum = texture2D(uVideo, dodgeCursor(uv)).rgb * 1.5;
        float total = 1.5;
        for (int i = 0; i < 6; i++) {
          float a = float(i) * 1.0471975512;               // 2pi / 6
          vec2 outer = vec2(cos(a), sin(a));
          vec2 inner = vec2(cos(a + 0.5235987756), sin(a + 0.5235987756));
          sum += texture2D(uVideo, dodgeCursor(uv + outer * rad * texel)).rgb;
          sum += texture2D(uVideo, dodgeCursor(uv + inner * rad * 0.5 * texel)).rgb;
          total += 2.0;
        }
        return sum / total;
      }

      void main() {
        vec2 p = (vUv - 0.5) * uSizePx;
        vec2 halfSize = uSizePx * 0.5;
        // CSS caps border-radius at half the shorter side; match that or the
        // masked edge drifts away from the border-radius the shadow is cast from.
        float rad = min(uRadiusPx, min(halfSize.x, halfSize.y));
        float d = sdRoundBox(p, halfSize, rad);
        if (d > 0.5) discard;
        float edgeAA = smoothstep(0.5, -1.5, d);

        vec2 texel = uCropSize / uSizePx;
        vec2 uvBase = uCropOrigin + vUv * uCropSize;

        // A flat pane with a bevelled rim, not a dome. The interior is
        // optically flat — the scene passes straight through, only frosted —
        // and every bit of refraction lives in the last few pixels before the
        // edge. Modelling the bevel as a quarter-round gives surface slope
        // t / sqrt(1 - t^2), which is ~0 across the pane then climbs steeply
        // into the rim, so no bulge leaks toward the middle.
        float t = 1.0 - clamp(-d / uBevelPx, 0.0, 1.0);   // 1 at rim → 0 at bevel base
        float slope = t / sqrt(max(1.0 - t * t, 0.015));
        // Capped fairly low: the bar sits ~12px below the top of the screen, so
        // an outward sample much larger than this runs off the captured display
        // at the top rim and smears the clamped edge row.
        float mag = min(slope, 3.0) * uBulge;

        // Outward surface normal from the SDF gradient: vertical along the long
        // top/bottom edges, radial around the rounded caps — so each edge bends
        // light across itself the way real glass does.
        float e = 1.0;
        vec2 nrm = normalize(vec2(
          sdRoundBox(p + vec2(e, 0.0), halfSize, rad) - sdRoundBox(p - vec2(e, 0.0), halfSize, rad),
          sdRoundBox(p + vec2(0.0, e), halfSize, rad) - sdRoundBox(p - vec2(0.0, e), halfSize, rad)
        ) + vec2(1e-6));

        vec2 off = nrm * mag * texel;
        float blur = uBlurPx * (1.0 - 0.45 * t);          // rim stays crisper than the pane

        vec3 col = vec3(
          frost(uvBase + off * (1.0 + uAberration), texel, blur).r,
          frost(uvBase + off, texel, blur).g,
          frost(uvBase + off * (1.0 - uAberration), texel, blur).b
        );

        vec3 wide = frost(uvBase + off, texel, uBlurPx * 5.0);
        float wideLuma = dot(wide, vec3(0.299, 0.587, 0.114));

        // Every term below this line is additive, so over a bright backdrop they
        // stacked past 1.0 and clipped: the bar turned into a solid white glowing
        // blob with no edge and no readable text. This fades them out as the
        // backdrop approaches white. Taken from the wide blur, not the local
        // colour, so dark text passing under the glass doesn't punch holes in it;
        // zero below ~0.58 luma, so dark and mid scenes render exactly as before.
        float hot = smoothstep(0.58, 0.92, wideLuma);

        // Light bleed: bright things behind the glass bloom out into it, which
        // is what produces the soft white flares in the reference bar. A
        // uniformly white backdrop has nothing to flare against, only headroom
        // to lose, so the bleed is gated off there.
        float bright = max(wideLuma - 0.55, 0.0);
        col += wide * bright * uBloom * (1.0 - hot);

        col = mix(col, vec3(1.0), uTint);
        col *= mix(1.04, 0.94, hot);

        // Rim light: bright inner line along the top edge, softer along the bottom.
        float rimFade = t * t;
        float rimGain = 1.0 - 0.8 * hot;
        col += rimFade * clamp(-nrm.y, 0.0, 1.0) * 0.30 * rimGain;
        col += rimFade * clamp(nrm.y, 0.0, 1.0) * 0.13 * rimGain;
        // A white rim is invisible against white, which is what left the pill
        // with no outline. Fade in a dark one to take over.
        col -= rimFade * hot * 0.16;

        float sheen = pow(clamp(1.0 - abs(vUv.y - 0.16) * 3.0, 0.0, 1.0), 3.0) * 0.15;
        col += sheen * (1.0 - 0.75 * hot);

        // Legibility scrim: the widget's text is white, so over a white backdrop
        // the material itself has to smoke down or nothing on the bar can be
        // read. Same idea as a system material darkening over light content.
        col = mix(col, col * 0.70, hot);

        gl_FragColor = vec4(clamp(col, 0.0, 1.0), edgeAA);
      }
    `;

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    console.error(gl.getShaderInfoLog(sh));
    return null;
  }
  return sh;
}

// How `object-fit: cover` actually places the image inside its box. The element
// rect is not the image rect: cover scales by the larger of the two ratios and
// centres the overflow, so sampling that goes through the refraction lines up
// with nothing unless the overflow is accounted for.
function coverRect(imgW, imgH, boxW, boxH) {
  const scale = Math.max(boxW / imgW, boxH / imgH);
  const w = imgW * scale;
  const h = imgH * scale;
  return { x: (boxW - w) / 2, y: (boxH - h) / 2, w, h };
}

export function createGlass({ canvas, barEl, backdropEl }) {
  const gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: false });
  if (!gl) return null;

  const vs = compile(gl, gl.VERTEX_SHADER, VS_SOURCE);
  const fs = compile(gl, gl.FRAGMENT_SHADER, FS_SOURCE);
  if (!vs || !fs) return null;

  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    console.error(gl.getProgramInfoLog(prog));
    return null;
  }
  gl.useProgram(prog);

  const quad = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(prog, 'aPos');
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  const u = {};
  for (const name of [
    'uVideo', 'uCropOrigin', 'uCropSize', 'uSizePx', 'uRadiusPx', 'uBevelPx',
    'uBulge', 'uAberration', 'uBlurPx', 'uTint', 'uBloom', 'uCursorUv',
    'uCursorRadUv',
  ]) {
    u[name] = gl.getUniformLocation(prog, name);
  }

  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

  // The texture never changes, so it is uploaded once rather than per frame —
  // the app re-uploads every frame only because its source is live video.
  let uploaded = false;
  function uploadIfReady() {
    if (uploaded) return true;
    if (!backdropEl.complete || !backdropEl.naturalWidth) return false;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, backdropEl);
    uploaded = true;
    return true;
  }

  function render() {
    if (!uploadIfReady()) return;

    const dpr = window.devicePixelRatio || 1;
    const bar = barEl.getBoundingClientRect();
    const bd = backdropEl.getBoundingClientRect();
    if (!bar.width || !bar.height || !bd.width || !bd.height) return;

    const w = Math.round(bar.width * dpr);
    const h = Math.round(bar.height * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    gl.viewport(0, 0, canvas.width, canvas.height);

    // Map the bar's on-screen rectangle into the backdrop's own pixels. The
    // rect to measure against is the rendered `#backdrop` box, not `#hero`:
    // they differ as soon as the hero grows past the image, and `cover` then
    // shifts the visible part of the image again on top of that.
    const c = coverRect(backdropEl.naturalWidth, backdropEl.naturalHeight, bd.width, bd.height);
    const ox = ((bar.left - bd.left) - c.x) / c.w;
    const oy = ((bar.top - bd.top) - c.y) / c.h;
    const sw = bar.width / c.w;
    const sh = bar.height / c.h;

    gl.useProgram(prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(u.uVideo, 0);
    gl.uniform2f(u.uCropOrigin, ox, oy);
    gl.uniform2f(u.uCropSize, sw, sh);
    gl.uniform2f(u.uSizePx, canvas.width, canvas.height);
    // Shipped, hand-tuned values. The px ones are in device pixels, so they
    // scale with dpr exactly as they do in the app.
    gl.uniform1f(u.uRadiusPx, 20 * dpr);
    gl.uniform1f(u.uBevelPx, 11.0 * dpr);   // width of the refracting rim
    gl.uniform1f(u.uBulge, 8.0 * dpr);      // how hard that rim bends the scene
    gl.uniform1f(u.uAberration, 0.40);      // R/B split as a fraction of that bend
    gl.uniform1f(u.uBlurPx, 4.0 * dpr);
    gl.uniform1f(u.uTint, 0.32);
    gl.uniform1f(u.uBloom, 1.15);

    // No cursor dodge here: that exists because the app's capture has the OS
    // pointer composited into it. A static image has no pointer in it.
    gl.uniform2f(u.uCursorUv, 0.0, 0.0);
    gl.uniform2f(u.uCursorRadUv, 0.0, 0.0);

    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  return { render };
}
