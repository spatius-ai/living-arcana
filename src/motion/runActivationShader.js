export const ACTIVATION_SHADER_DURATION = 900;

function createShaderProgram(gl, vertexSource, fragmentSource) {
  function compile(type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader;
    gl.deleteShader(shader);
    return null;
  }

  const vertex = compile(gl.VERTEX_SHADER, vertexSource);
  const fragment = compile(gl.FRAGMENT_SHADER, fragmentSource);
  if (!vertex || !fragment) {
    if (vertex) gl.deleteShader(vertex);
    if (fragment) gl.deleteShader(fragment);
    return null;
  }

  const program = gl.createProgram();
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  if (gl.getProgramParameter(program, gl.LINK_STATUS)) return { program, vertex, fragment };

  gl.deleteProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  return null;
}

/**
 * Shared static-artwork -> digital-human activation sweep.
 *
 * The returned cleanup makes the one-shot safe to use from React effects;
 * the Today flow intentionally lets the animation clean itself up on finish.
 */
// The program is compiled once per canvas and kept: a reading runs this
// effect up to three times on the same canvas (summon, return, reopen), and
// recompiling the fbm shader each time stalled the first frame of each run.
const activationResources = new WeakMap();

function getActivationResources(canvas) {
  const cached = activationResources.get(canvas);
  if (cached && !cached.gl.isContextLost()) return cached;

  const gl = canvas.getContext("webgl", { alpha: true, premultipliedAlpha: false });
  if (!gl || gl.isContextLost()) return null;

  const vertexSource = `
    attribute vec2 a_position;
    varying vec2 v_uv;
    void main() {
      v_uv = a_position * 0.5 + 0.5;
      gl_Position = vec4(a_position, 0.0, 1.0);
    }
  `;
  const fragmentSource = `
    precision highp float;
    varying vec2 v_uv;
    uniform float u_progress;
    uniform float u_mode;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
    float noise(vec2 p) {
      vec2 i = floor(p); vec2 f = fract(p);
      f = f * f * (3.0 - 2.0 * f);
      return mix(mix(hash(i), hash(i + vec2(1.,0.)), f.x), mix(hash(i + vec2(0.,1.)), hash(i + vec2(1.,1.)), f.x), f.y);
    }
    float fbm(vec2 p) {
      float v = 0.0; float a = 0.5;
      for (int i = 0; i < 4; i++) { v += a * noise(p); p *= 2.03; a *= 0.5; }
      return v;
    }
    void main() {
      vec2 uv = v_uv;
      float n = fbm(uv * 7.0 + vec2(u_progress * 1.8, -u_progress));
      float field = uv.x;
      if (u_mode > 0.5 && u_mode < 1.5) field = 1.0 - distance(uv, vec2(0.5));
      if (u_mode > 1.5) field = (uv.x + (1.0 - uv.y)) * 0.5;
      field += (n - 0.5) * (u_mode > 0.5 ? 0.34 : 0.16);
      float edge = 1.0 - smoothstep(0.0, 0.075, abs(field - u_progress));
      float veil = smoothstep(u_progress - 0.16, u_progress + 0.02, field) * 0.26;
      vec3 violet = vec3(0.58, 0.42, 1.0);
      vec3 pearl = vec3(0.84, 0.95, 0.91);
      vec3 color = mix(violet, pearl, clamp(n * 1.2, 0.0, 1.0));
      float alpha = edge * 0.88 + veil * (1.0 - u_progress);
      gl_FragColor = vec4(color, alpha);
    }
  `;
  const shaders = createShaderProgram(gl, vertexSource, fragmentSource);
  if (!shaders) return null;

  const { program } = shaders;
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
  gl.useProgram(program);
  const position = gl.getAttribLocation(program, "a_position");
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

  const resources = {
    gl,
    progress: gl.getUniformLocation(program, "u_progress"),
    modeUniform: gl.getUniformLocation(program, "u_mode"),
  };
  activationResources.set(canvas, resources);
  return resources;
}

export function runActivationShader(
  canvas,
  mode = 0,
  duration = ACTIVATION_SHADER_DURATION,
  options = {},
) {
  const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  if (!canvas || reducedMotion) return () => {};

  const resources = getActivationResources(canvas);
  if (!resources) return () => {};
  const { gl, progress, modeUniform } = resources;

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.floor(rect.width * dpr));
  canvas.height = Math.max(1, Math.floor(rect.height * dpr));

  gl.uniform1f(modeUniform, Number.isFinite(mode) ? mode : 0);
  gl.viewport(0, 0, canvas.width, canvas.height);

  const started = performance.now();
  const loop = options.loop === true;
  const hoverStrength = Number.isFinite(options.strength) ? options.strength : 1;
  const active = typeof options.active === "function" ? options.active : () => true;
  const safeDuration = Math.max(1, duration);
  let frameRequest = 0;
  let disposed = false;

  const clear = () => {
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    canvas.style.removeProperty("opacity");
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (frameRequest) window.cancelAnimationFrame(frameRequest);
    clear();
  };
  const frame = (now) => {
    frameRequest = 0;
    if (disposed) return;
    if (!active()) {
      dispose();
      return;
    }
    const elapsed = (now - started) / safeDuration;
    const t = loop ? elapsed % 1 : Math.min(1, elapsed);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform1f(progress, t);
    canvas.style.opacity = String(hoverStrength);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    if (loop || t < 1) frameRequest = window.requestAnimationFrame(frame);
    else dispose();
  };

  frameRequest = window.requestAnimationFrame(frame);
  return dispose;
}
