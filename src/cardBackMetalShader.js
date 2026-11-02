const NOOP_CONTROLLER = Object.freeze({
  destroy() {},
  measure() {},
  setActive() {},
  setIdle() {},
  setPointer() {},
});

export const CARD_BACK_IMAGE_URL = "/assets/cards/card-back.webp";
// 512×820 copy for the archive grid textures.
export const CARD_BACK_THUMBNAIL_URL = "/assets/cards/card-back-thumb.webp";

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
  uniform vec2 u_pointer;
  uniform float u_intensity;

  float hash(vec2 value) {
    return fract(sin(dot(value, vec2(127.1, 311.7))) * 43758.5453123);
  }

  void main() {
    vec3 source = texture2D(u_card, v_uv).rgb;
    float maximum = max(source.r, max(source.g, source.b));
    float minimum = min(source.r, min(source.g, source.b));
    float chroma = maximum - minimum;
    float luminance = dot(source, vec3(0.2126, 0.7152, 0.0722));

    // Pull a warm metallic channel directly from the registered card texture.
    float warm = smoothstep(0.025, 0.16, source.r - source.b)
      * smoothstep(-0.035, 0.095, source.r - source.g);
    float material = warm
      * smoothstep(0.035, 0.19, chroma)
      * smoothstep(0.16, 0.64, luminance);

    // Keep the treatment on the rectangular frame, away from the sky and clouds.
    vec2 edgeDistance = abs(v_uv - 0.5) * 2.0;
    float sideFrame = smoothstep(0.69, 0.84, edgeDistance.x);
    float horizontalFrame = smoothstep(0.80, 0.91, edgeDistance.y);
    float frameMask = max(sideFrame, horizontalFrame);
    float metalMask = material * frameMask;

    vec2 lightAxis = normalize(vec2(0.84, 0.54));
    float distanceToSweep = abs(dot(v_uv - u_pointer, lightAxis));
    float narrowSweep = 1.0 - smoothstep(0.018, 0.13, distanceToSweep);
    float broadReflection = 1.0 - smoothstep(0.08, 0.48, distance(v_uv, u_pointer));
    float grain = mix(0.82, 1.12, hash(floor(v_uv * vec2(760.0, 1216.0))));

    float reflection = metalMask
      * (0.025 + u_intensity * (narrowSweep * 0.72 + broadReflection * 0.1))
      * grain;
    vec3 warmGold = vec3(1.0, 0.66, 0.29);
    vec3 paleEdge = vec3(1.0, 0.92, 0.73);
    vec3 reflectionColor = mix(warmGold, paleEdge, smoothstep(0.38, 0.82, luminance));

    gl_FragColor = vec4(reflectionColor, clamp(reflection, 0.0, 0.7));
  }
`;

function createProgram(gl) {
  const compile = (type, source) => {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  };

  const vertex = compile(gl.VERTEX_SHADER, VERTEX_SHADER);
  const fragment = compile(gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
  if (!vertex || !fragment) return null;

  const program = gl.createProgram();
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  return gl.getProgramParameter(program, gl.LINK_STATUS) ? program : null;
}

// The WebGL context, program and card-back texture are created by the first
// setActive(true) — when a card actually shows its back — instead of at boot
// for every card on the page (see createLazyRenderer in cardHoverMaterial.js).
// Until then the untouched canvas is transparent, as the eager clear() was.
export function createCardBackMetalShader(canvas, options = {}) {
  if (!canvas || options.reducedMotion) return NOOP_CONTROLLER;

  let real = null;
  let destroyed = false;
  let pendingPointer = null;
  const ensure = () => {
    if (!real && !destroyed) {
      real = createEagerCardBackMetalShader(canvas, options);
      if (pendingPointer) real.setPointer(...pendingPointer);
      pendingPointer = null;
    }
    return real;
  };

  return {
    measure() { real?.measure(); },
    setActive(next) {
      if (!next && !real) return;
      ensure()?.setActive(next);
    },
    setPointer(...args) {
      if (real) real.setPointer(...args);
      else pendingPointer = args;
    },
    setIdle() {
      if (real) real.setIdle();
      else pendingPointer = null;
    },
    destroy() {
      destroyed = true;
      real?.destroy();
      real = null;
    },
  };
}

function createEagerCardBackMetalShader(canvas, {
  reducedMotion = false,
  source = CARD_BACK_IMAGE_URL,
} = {}) {
  if (!canvas || reducedMotion) return NOOP_CONTROLLER;

  const gl = canvas.getContext("webgl", { alpha: true, premultipliedAlpha: false });
  if (!gl) return NOOP_CONTROLLER;

  const program = createProgram(gl);
  if (!program) return NOOP_CONTROLLER;

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

  const pointerUniform = gl.getUniformLocation(program, "u_pointer");
  const intensityUniform = gl.getUniformLocation(program, "u_intensity");
  const textureUniform = gl.getUniformLocation(program, "u_card");
  const texture = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.uniform1i(textureUniform, 0);

  let active = false;
  let disposed = false;
  let ready = false;
  let animationFrame = 0;
  let lastFrame = performance.now();
  let pointer = { x: 0.5, y: 0.58 };
  let targetPointer = { ...pointer };
  let intensity = 0.12;
  let targetIntensity = intensity;

  let measuredRect = null;

  // See createDiffractionRenderer: measuring before the caller writes its
  // tilt/scale variables avoids a forced synchronous layout in the draw.
  const measure = () => {
    if (disposed) return;
    measuredRect = canvas.getBoundingClientRect();
  };

  const resize = () => {
    const rect = measuredRect || canvas.getBoundingClientRect();
    measuredRect = null;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.floor(rect.width * dpr));
    const height = Math.max(1, Math.floor(rect.height * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    gl.viewport(0, 0, canvas.width, canvas.height);
  };

  const clear = () => {
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  };

  const draw = () => {
    if (!active || !ready || disposed) {
      clear();
      return;
    }
    resize();
    gl.useProgram(program);
    gl.uniform2f(pointerUniform, pointer.x, pointer.y);
    gl.uniform1f(intensityUniform, intensity);
    clear();
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  };

  const animate = (now) => {
    animationFrame = 0;
    if (!active || disposed) return;
    const delta = Math.min(0.05, Math.max(0.001, (now - lastFrame) / 1000));
    lastFrame = now;
    const blend = 1 - Math.exp(-20 * delta);
    pointer.x += (targetPointer.x - pointer.x) * blend;
    pointer.y += (targetPointer.y - pointer.y) * blend;
    intensity += (targetIntensity - intensity) * blend;
    draw();

    const unsettled = Math.abs(targetPointer.x - pointer.x)
      + Math.abs(targetPointer.y - pointer.y)
      + Math.abs(targetIntensity - intensity) > 0.002;
    if (unsettled) animationFrame = requestAnimationFrame(animate);
  };

  const schedule = () => {
    if (!animationFrame && active && !disposed) {
      lastFrame = performance.now();
      animationFrame = requestAnimationFrame(animate);
    }
  };

  const image = new Image();
  image.decoding = "async";
  image.addEventListener("load", () => {
    if (disposed) return;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    ready = true;
    draw();
  }, { once: true });
  image.src = source;

  return {
    measure,
    setActive(next) {
      active = Boolean(next);
      if (active) schedule();
      else clear();
    },
    setPointer(x, y, nextIntensity = 0.76) {
      targetPointer = {
        x: Math.max(0, Math.min(1, x)),
        y: Math.max(0, Math.min(1, y)),
      };
      targetIntensity = nextIntensity;
      schedule();
    },
    setIdle() {
      targetPointer = { x: 0.5, y: 0.58 };
      targetIntensity = 0.12;
      schedule();
    },
    destroy() {
      disposed = true;
      active = false;
      cancelAnimationFrame(animationFrame);
      gl.deleteTexture(texture);
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
    },
  };
}
