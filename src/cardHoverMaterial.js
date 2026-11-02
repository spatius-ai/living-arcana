import { CARD_HOLOGRAPHIC_STRENGTH_EVENT } from "./cardArtworkTuning.js";
import { MOTION_POSE_EVENT } from "./motion/deviceMotion.js";

const NOOP_CONTROLLER = Object.freeze({
  destroy() {},
  measure() {},
  refresh() {},
  reset() {},
  setActive() {},
  setIdle() {},
  setPose() {},
});

const VERTEX_SHADER = `
  attribute vec2 a_position;
  varying vec2 v_uv;

  void main() {
    v_uv = a_position * 0.5 + 0.5;
    gl_Position = vec4(a_position, 0.0, 1.0);
  }
`;

const FRAGMENT_SHADER = `
  precision highp float;

  varying vec2 v_uv;
  uniform sampler2D u_card;
  uniform vec2 u_rotation;
  uniform float u_strength;

  const float PI = 3.141592653589793;

  float saturate(float value) {
    return clamp(value, 0.0, 1.0);
  }

  mat3 rotationXY(vec2 rotation) {
    float sx = sin(rotation.x);
    float cx = cos(rotation.x);
    float sy = sin(rotation.y);
    float cy = cos(rotation.y);
    mat3 rx = mat3(
      1.0, 0.0, 0.0,
      0.0, cx, sx,
      0.0, -sx, cx
    );
    mat3 ry = mat3(
      cy, 0.0, -sy,
      0.0, 1.0, 0.0,
      sy, 0.0, cy
    );
    return ry * rx;
  }

  float fresnelSchlick(float NoV, float f0) {
    return f0 + (1.0 - f0) * pow(1.0 - saturate(NoV), 5.0);
  }

  vec3 diffractionSpectrum(float path) {
    vec3 wavelengths = vec3(0.650, 0.510, 0.475);
    vec3 phase = (2.0 * PI * path) / wavelengths;
    return pow(0.5 + 0.5 * cos(phase), vec3(3.2));
  }

  float anisotropicHighlight(
    vec3 N,
    vec3 H,
    vec3 T,
    vec3 B,
    float tangentWidth,
    float bitangentWidth
  ) {
    float NoH = max(dot(N, H), 0.0);
    float ToH = dot(T, H) / max(tangentWidth, 0.001);
    float BoH = dot(B, H) / max(bitangentWidth, 0.001);
    return exp(-(ToH * ToH + BoH * BoH)) * pow(NoH, 7.0);
  }

  float grooveHeight(vec2 uv) {
    float direction = uv.x * 0.82 + uv.y * 1.64;
    return sin(direction * 220.0 + sin(uv.y * 8.0) * 2.4);
  }

  vec3 grooveNormal(vec2 uv) {
    float epsilon = 0.0025;
    float center = grooveHeight(uv);
    vec2 gradient = vec2(
      grooveHeight(uv + vec2(epsilon, 0.0)) - center,
      grooveHeight(uv + vec2(0.0, epsilon)) - center
    ) / epsilon;
    return normalize(vec3(-gradient * 0.00145, 1.0));
  }

  float foilCoverage(vec2 uv, vec3 base) {
    vec2 edgeDistance = abs(uv - 0.5) * 2.0;
    float frame = smoothstep(0.66, 0.94, max(edgeDistance.x, edgeDistance.y));
    float luminance = dot(base, vec3(0.2126, 0.7152, 0.0722));
    float materialResponse = smoothstep(0.08, 0.72, luminance);
    vec2 portraitUv = (uv - vec2(0.5, 0.47)) * vec2(1.0, 0.82);
    float portraitProtection = smoothstep(0.16, 0.38, length(portraitUv));
    return saturate((0.42 + frame * 0.4 + materialResponse * 0.18) * mix(0.76, 1.0, portraitProtection));
  }

  void main() {
    vec2 uv = v_uv;
    vec3 base = pow(texture2D(u_card, uv).rgb, vec3(2.2));
    mat3 cardRotation = rotationXY(u_rotation);
    vec2 cardPoint = (uv - 0.5) * vec2(0.625, 1.0);
    vec3 worldPosition = cardRotation * vec3(cardPoint, 0.0);
    vec3 V = normalize(vec3(0.0, 0.0, 2.35) - worldPosition);
    vec3 L = normalize(vec3(-0.48, 0.68, 1.15));
    vec3 H = normalize(V + L);

    vec3 N = normalize(cardRotation * grooveNormal(uv));
    float tangentAngle = -0.72 + sin(uv.y * 6.5) * 0.31 + sin(uv.x * 11.0) * 0.09;
    vec3 localTangent = normalize(vec3(cos(tangentAngle), sin(tangentAngle), 0.0));
    vec3 T = normalize(cardRotation * localTangent);
    vec3 B = normalize(cross(N, T));
    T = normalize(cross(B, N));

    float NoV = max(dot(N, V), 0.0);
    float NoL = max(dot(N, L), 0.0);
    float NoH = max(dot(N, H), 0.0);
    float tangentProjection = dot(H, T);
    float stableField = sin(uv.y * 13.0) * 0.19 + sin(uv.x * 21.0 + uv.y * 4.0) * 0.08;
    vec3 diffraction = diffractionSpectrum(tangentProjection * 5.8 + stableField);
    float anisotropic = anisotropicHighlight(N, H, T, B, 0.52, 0.095);
    float fresnel = fresnelSchlick(NoV, 0.08);
    float whiteOrder = exp(-pow(dot(H, T) / 0.075, 2.0)) * pow(NoH, 6.0);
    float spectralEnergy = max(max(diffraction.r, diffraction.g), diffraction.b);
    float orderEnvelope = 0.48 + 0.52 * pow(1.0 - abs(dot(H, B)), 2.0);
    vec3 color = diffraction * (0.42 + 0.58 * NoL) * (1.28 + anisotropic * 1.8) * orderEnvelope
      + vec3(1.0, 0.97, 0.88) * whiteOrder * 1.4
      + vec3(0.72, 0.82, 0.9) * fresnel * 0.16;
    float alpha = 0.3 + spectralEnergy * 0.24 + anisotropic * 0.42
      + whiteOrder * 0.32 + fresnel * 0.16;
    alpha = saturate(alpha * foilCoverage(uv, base) * u_strength);

    vec3 displayColor = pow(max(color, vec3(0.0)), vec3(1.0 / 2.2));
    gl_FragColor = vec4(displayColor, alpha);
  }
`;

const clamp01 = (value) => Math.min(1, Math.max(0, value));
const degreesToRadians = (value) => value * Math.PI / 180;

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) || "Unknown shader compilation error";
    gl.deleteShader(shader);
    throw new Error(message);
  }
  return shader;
}

function createProgram(gl) {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
  const program = gl.createProgram();
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program) || "Unknown shader link error";
    gl.deleteProgram(program);
    throw new Error(message);
  }
  return program;
}

// --home-holographic-strength only ever changes together with
// CARD_HOLOGRAPHIC_STRENGTH_EVENT, so the computed-style read (a forced style
// recalculation when it runs inside a frame) is cached until that event.
function createStrengthReader(getStrength) {
  let value = null;
  const invalidate = () => { value = null; };
  globalThis.window?.addEventListener(CARD_HOLOGRAPHIC_STRENGTH_EVENT, invalidate);
  return {
    read() {
      if (value === null) value = clamp01(Number(getStrength()) || 0);
      return value;
    },
    dispose() {
      globalThis.window?.removeEventListener(CARD_HOLOGRAPHIC_STRENGTH_EVENT, invalidate);
    },
  };
}

function createDiffractionRenderer(canvas, getArtworkUrl, { observeResize = true } = {}) {
  const gl = canvas.getContext("webgl", {
    alpha: true,
    antialias: true,
    premultipliedAlpha: false,
    powerPreference: "high-performance",
  });
  if (!gl) return null;

  const program = createProgram(gl);
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
    gl.STATIC_DRAW,
  );
  gl.useProgram(program);
  const position = gl.getAttribLocation(program, "a_position");
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

  const rotationUniform = gl.getUniformLocation(program, "u_rotation");
  const strengthUniform = gl.getUniformLocation(program, "u_strength");
  const cardUniform = gl.getUniformLocation(program, "u_card");
  const texture = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA,
    1,
    1,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    new Uint8Array([90, 96, 92, 255]),
  );
  gl.uniform1i(cardUniform, 0);
  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.CULL_FACE);

  let destroyed = false;
  let artworkUrl = "";
  let artworkToken = 0;
  let lastRotation = { x: 0, y: 0 };
  let lastStrength = 0;

  let measuredRect = null;

  // Callers that are about to write styles (tilt/scale variables) measure
  // first: read here, the box comes from the already-clean layout, whereas the
  // same read after those writes forces a synchronous style + layout pass on
  // every hover frame. A draw without a prior measure() still measures itself.
  const measure = () => {
    if (destroyed) return;
    measuredRect = canvas.getBoundingClientRect();
  };

  const resize = () => {
    const rect = measuredRect || canvas.getBoundingClientRect();
    measuredRect = null;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(rect.width * dpr));
    const height = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    gl.viewport(0, 0, canvas.width, canvas.height);
  };

  const draw = (rotation = lastRotation, strength = lastStrength) => {
    if (destroyed || document.hidden) return;
    lastRotation = rotation;
    lastStrength = strength;
    resize();
    gl.useProgram(program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform2f(rotationUniform, rotation.x, rotation.y);
    gl.uniform1f(strengthUniform, strength);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  };

  const loadArtwork = () => {
    const nextUrl = getArtworkUrl?.() || "";
    if (!nextUrl || nextUrl === artworkUrl) return;
    artworkUrl = nextUrl;
    const token = ++artworkToken;
    const image = new Image();
    image.decoding = "async";
    image.addEventListener("load", () => {
      if (destroyed || token !== artworkToken) return;
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
      draw();
    }, { once: true });
    image.src = nextUrl;
  };

  const observer = observeResize ? new ResizeObserver(() => draw()) : null;
  observer?.observe(canvas);
  loadArtwork();
  draw();

  return {
    draw,
    measure,
    loadArtwork,
    destroy() {
      destroyed = true;
      artworkToken += 1;
      observer?.disconnect();
      gl.deleteTexture(texture);
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
      // No WEBGL_lose_context here: callers re-create a material on the same
      // canvas (e.g. when the artwork changes) and would get the lost context.
    },
  };
}

// Each material owns a WebGL context, and browsers evict the oldest once ~16
// are alive (the archive, ripple, orb and digital human need theirs too). The
// context is therefore created the first time the material has something to
// show — an unvisited view never allocates one — and an untouched canvas is
// transparent, exactly what the shader outputs at zero strength.
function createLazyRenderer(canvas, getArtworkUrl, options) {
  let renderer = null;
  let failed = false;
  return {
    get: () => renderer,
    ensure() {
      if (renderer || failed) return renderer;
      try {
        renderer = createDiffractionRenderer(canvas, getArtworkUrl, options);
      } catch (error) {
        console.error("[Living Arcana] Diffraction material failed to initialize.", error);
      }
      if (!renderer) failed = true;
      return renderer;
    },
    destroy() {
      renderer?.destroy();
      renderer = null;
      failed = true;
    },
  };
}

export function createCardDiffractionShader(canvas, {
  getArtworkUrl = () => "",
  getStrength = () => 0.68,
  observeResize = true,
  reducedMotion = false,
} = {}) {
  if (!canvas || reducedMotion) return NOOP_CONTROLLER;

  // Created by the first setActive(true) — when its view opens — so the
  // artwork texture is still ready before any hover, as it was when eager.
  const lazy = createLazyRenderer(canvas, getArtworkUrl, { observeResize });

  let active = false;
  let pose = { x: 0, y: 0, intensity: 0 };
  const strength = createStrengthReader(getStrength);

  const draw = () => {
    const renderer = lazy.get();
    if (!renderer) return;
    const configuredStrength = strength.read();
    renderer.draw(
      { x: degreesToRadians(pose.x), y: degreesToRadians(pose.y) },
      active ? clamp01(pose.intensity) * configuredStrength : 0,
    );
  };

  return {
    setActive(next) {
      active = Boolean(next);
      canvas.toggleAttribute("data-active", active);
      if (active) lazy.ensure()?.loadArtwork();
      draw();
    },
    setPose(rotationX = 0, rotationY = 0, intensity = 1) {
      pose = { x: rotationX, y: rotationY, intensity };
      draw();
    },
    setIdle() {
      pose = { x: 0, y: 0, intensity: 0 };
      draw();
    },
    refresh() {
      lazy.get()?.loadArtwork();
      draw();
    },
    measure() {
      lazy.get()?.measure();
    },
    destroy() {
      canvas.removeAttribute("data-active");
      strength.dispose();
      lazy.destroy();
    },
  };
}

export function createCardHoverMaterial({
  target,
  tilt,
  canvas,
  enabled = () => true,
  getArtworkUrl = () => "",
  getStrength = () => 0.68,
  hoverScale = 1.014,
  maxTilt = 4.25,
  reducedMotion = false,
  motionTarget = globalThis.window,
} = {}) {
  if (!target || !tilt || !canvas || reducedMotion) return NOOP_CONTROLLER;

  // Created by the first pointer/motion pose; intensity eases in from zero, so
  // the artwork (already decoded for the card itself) lands before it shows.
  const lazy = createLazyRenderer(canvas, getArtworkUrl);

  let destroyed = false;
  let frame = 0;
  let lastFrame = performance.now();
  let current = { x: 0.5, y: 0.5, intensity: 0 };
  let destination = { ...current };
  let motionActive = false;
  const strength = createStrengthReader(getStrength);

  const render = () => {
    const intensity = clamp01(current.intensity);
    const rotateX = (0.5 - current.y) * maxTilt * 2 * intensity;
    const rotateY = (current.x - 0.5) * maxTilt * 2 * intensity;
    const scale = 1 + (hoverScale - 1) * intensity;
    const configuredStrength = strength.read();

    const renderer = lazy.get();
    renderer?.measure();
    tilt.style.setProperty("--home-rx", `${rotateX.toFixed(3)}deg`);
    tilt.style.setProperty("--home-ry", `${rotateY.toFixed(3)}deg`);
    tilt.style.setProperty("--home-hover-scale", scale.toFixed(4));
    renderer?.draw(
      { x: degreesToRadians(rotateX), y: degreesToRadians(rotateY) },
      intensity * configuredStrength,
    );
  };

  const animate = (now) => {
    frame = 0;
    if (destroyed) return;

    const delta = Math.min(0.05, Math.max(0.001, (now - lastFrame) / 1000));
    lastFrame = now;
    const pointerBlend = 1 - Math.exp(-18 * delta);
    const intensityBlend = 1 - Math.exp(-(destination.intensity > current.intensity ? 15 : 12) * delta);

    current.x += (destination.x - current.x) * pointerBlend;
    current.y += (destination.y - current.y) * pointerBlend;
    current.intensity += (destination.intensity - current.intensity) * intensityBlend;
    render();

    const unsettled = Math.abs(destination.x - current.x)
      + Math.abs(destination.y - current.y)
      + Math.abs(destination.intensity - current.intensity) > 0.0015;
    if (unsettled) frame = requestAnimationFrame(animate);
  };

  const schedule = () => {
    if (frame || destroyed) return;
    lastFrame = performance.now();
    frame = requestAnimationFrame(animate);
  };

  const pointerPosition = (event) => {
    const rect = target.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    return {
      x: clamp01((event.clientX - rect.left) / rect.width),
      y: clamp01((event.clientY - rect.top) / rect.height),
    };
  };

  const setPointer = (event) => {
    const pointer = pointerPosition(event);
    if (!pointer) return;
    destination = { ...pointer, intensity: 1 };
    lazy.ensure()?.loadArtwork();
    schedule();
  };

  const onPointerEnter = (event) => {
    if (event.pointerType === "touch" || !enabled()) return;
    canvas.setAttribute("data-active", "");
    setPointer(event);
  };

  const onPointerMove = (event) => {
    if (event.pointerType === "touch" || !canvas.hasAttribute("data-active") || !enabled()) return;
    setPointer(event);
  };

  const reset = ({ immediate = false } = {}) => {
    motionActive = false;
    canvas.removeAttribute("data-active");
    destination = { x: 0.5, y: 0.5, intensity: 0 };
    if (immediate) {
      cancelAnimationFrame(frame);
      frame = 0;
      current = { ...destination };
      render();
      return;
    }
    schedule();
  };

  const onMotionPose = (event) => {
    const pose = event.detail;
    if (!pose?.active || !enabled()) {
      if (motionActive) reset();
      return;
    }
    motionActive = true;
    canvas.setAttribute("data-active", "");
    destination = {
      x: clamp01(0.5 + clamp01((pose.x + 1) / 2) * 0.72 - 0.36),
      y: clamp01(0.5 + clamp01((pose.y + 1) / 2) * 0.72 - 0.36),
      intensity: 0.78,
    };
    lazy.ensure()?.loadArtwork();
    schedule();
  };

  const onPointerLeave = () => reset();
  const onVisibilityChange = () => {
    if (document.hidden) reset({ immediate: true });
  };
  const onStrengthChange = () => render();

  const clearStyles = () => {
    tilt.style.removeProperty("--home-rx");
    tilt.style.removeProperty("--home-ry");
    tilt.style.removeProperty("--home-hover-scale");
  };

  target.addEventListener("pointerenter", onPointerEnter, { passive: true });
  target.addEventListener("pointermove", onPointerMove, { passive: true });
  target.addEventListener("pointerleave", onPointerLeave, { passive: true });
  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener(CARD_HOLOGRAPHIC_STRENGTH_EVENT, onStrengthChange);
  motionTarget?.addEventListener?.(MOTION_POSE_EVENT, onMotionPose);
  render();

  return {
    reset,
    destroy() {
      destroyed = true;
      cancelAnimationFrame(frame);
      target.removeEventListener("pointerenter", onPointerEnter);
      target.removeEventListener("pointermove", onPointerMove);
      target.removeEventListener("pointerleave", onPointerLeave);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener(CARD_HOLOGRAPHIC_STRENGTH_EVENT, onStrengthChange);
      motionTarget?.removeEventListener?.(MOTION_POSE_EVENT, onMotionPose);
      canvas.removeAttribute("data-active");
      strength.dispose();
      lazy.destroy();
      clearStyles();
    },
  };
}
