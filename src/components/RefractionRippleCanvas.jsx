import { useEffect, useRef } from "react";

const VERTEX_SHADER = `#version 300 es
precision highp float;

out vec2 v_uv;

void main() {
  vec2 position = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  v_uv = position;
  gl_Position = vec4(position * 2.0 - 1.0, 0.0, 1.0);
}
`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;

uniform sampler2D u_videoA;
uniform sampler2D u_videoB;
uniform vec2 u_viewport;
uniform vec2 u_videoSizeA;
uniform vec2 u_videoSizeB;
uniform float u_videoMix;
uniform vec3 u_videoGrade;
uniform float u_blurRadius;
uniform vec4 u_buttonRect;
uniform vec2 u_origin;
uniform float u_progress;
uniform float u_strength;
uniform float u_dispersion;

in vec2 v_uv;
out vec4 fragColor;

vec2 coverUv(vec2 screenPx, vec2 videoSize) {
  float coverScale = max(u_viewport.x / videoSize.x, u_viewport.y / videoSize.y);
  vec2 renderedSize = videoSize * coverScale;
  vec2 crop = (renderedSize - u_viewport) * 0.5;
  vec2 topLeftUv = (screenPx + crop) / renderedSize;
  return vec2(topLeftUv.x, 1.0 - topLeftUv.y);
}

vec3 gradeVideo(vec3 color) {
  float luminance = dot(color, vec3(0.2126, 0.7152, 0.0722));
  color = mix(vec3(luminance), color, u_videoGrade.x);
  color = (color - 0.5) * u_videoGrade.y + 0.5;
  color *= u_videoGrade.z;
  return max(color, 0.0);
}

vec3 sampleVideoLayerAt(vec2 screenPx) {
  vec3 videoA = texture(u_videoA, coverUv(screenPx, u_videoSizeA)).rgb;
  if (u_videoMix <= 0.001) return videoA;
  vec3 videoB = texture(u_videoB, coverUv(screenPx, u_videoSizeB)).rgb;
  if (u_videoMix >= 0.999) return videoB;
  return mix(videoA, videoB, u_videoMix);
}

vec3 sampleVideoAt(vec2 screenPx) {
  float radius = u_blurRadius;
  vec2 axisX = vec2(radius, 0.0);
  vec2 axisY = vec2(0.0, radius);
  vec2 diagonalA = vec2(radius * 0.82, radius * 0.82);
  vec2 diagonalB = vec2(radius * 0.82, -radius * 0.82);

  vec3 color = sampleVideoLayerAt(screenPx) * 0.2;
  color += sampleVideoLayerAt(screenPx + axisX) * 0.12;
  color += sampleVideoLayerAt(screenPx - axisX) * 0.12;
  color += sampleVideoLayerAt(screenPx + axisY) * 0.12;
  color += sampleVideoLayerAt(screenPx - axisY) * 0.12;
  color += sampleVideoLayerAt(screenPx + diagonalA) * 0.08;
  color += sampleVideoLayerAt(screenPx - diagonalA) * 0.08;
  color += sampleVideoLayerAt(screenPx + diagonalB) * 0.08;
  color += sampleVideoLayerAt(screenPx - diagonalB) * 0.08;

  return gradeVideo(color);
}

void main() {
  vec2 localUv = vec2(v_uv.x, 1.0 - v_uv.y);
  vec2 localPx = localUv * u_buttonRect.zw;
  vec2 originPx = u_origin * u_buttonRect.zw;
  vec2 delta = localPx - originPx;
  float distanceFromOrigin = length(delta);
  vec2 direction = distanceFromOrigin > 0.0001 ? delta / distanceFromOrigin : vec2(1.0, 0.0);

  float angle = atan(delta.y, delta.x);
  float spatialWarp = 4.2 * sin(angle * 3.0 + distanceFromOrigin * 0.022)
    + 1.8 * sin(localUv.y * 9.0 - distanceFromOrigin * 0.015);
  float warpedDistance = distanceFromOrigin + spatialWarp;

  float travel = u_progress + 0.055 * sin(u_progress * 3.14159265);
  float farthestCorner = length(u_buttonRect.zw - originPx);
  float radius = mix(-8.0, farthestCorner + 38.0, travel);
  float phase = warpedDistance - radius;

  float primaryPhase = phase / 19.0;
  float primary = (1.0 - primaryPhase * primaryPhase) * exp(-0.5 * primaryPhase * primaryPhase);
  float echoPhase = (phase + 42.0) / 27.0;
  float echo = 0.2 * (1.0 - echoPhase * echoPhase) * exp(-0.5 * echoPhase * echoPhase);
  float wave = primary + echo;
  float rippleEnvelope = clamp(abs(primary) + 0.58 * abs(echo), 0.0, 1.0);
  float life = smoothstep(0.0, 0.055, u_progress) * (1.0 - smoothstep(0.7, 1.0, u_progress));

  float displacementPx = wave * u_strength * life;
  vec2 screenPx = u_buttonRect.xy + localPx;
  vec2 displacedPx = screenPx + direction * displacementPx;

  vec3 base = sampleVideoAt(screenPx);
  vec3 center = sampleVideoAt(displacedPx);

  float crest = smoothstep(0.06, 0.9, wave * life);
  float trough = smoothstep(0.04, 0.62, -wave * life);
  vec3 refractionDelta = center - base;
  float luminanceDelta = clamp(dot(refractionDelta, vec3(0.2126, 0.7152, 0.0722)) * 3.0, -0.18, 0.18);

  float edgeDistance = abs(primaryPhase) - 1.08;
  float spectralCore = exp(-0.5 * pow(edgeDistance / 0.13, 2.0));
  float spectralHalo = exp(-0.5 * pow(edgeDistance / 0.24, 2.0));
  float spectrumT = clamp(0.5 + edgeDistance / (0.34 + 0.02 * u_dispersion), 0.0, 1.0);
  float spectrumHue = mix(0.0, 0.82, spectrumT);
  vec3 rainbow = clamp(
    abs(mod(spectrumHue * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0,
    0.0,
    1.0
  );
  rainbow = rainbow * rainbow * (3.0 - 2.0 * rainbow);
  vec3 pearlColor = vec3(0.86, 0.85, 0.9);
  vec3 spectralColor = mix(pearlColor, mix(vec3(0.72), rainbow, 0.58), 0.3);
  float angularVariation = 0.86 + 0.14 * (0.5 + 0.5 * sin(angle * 2.0 + distanceFromOrigin * 0.032));
  float spectralAlpha = (0.052 * spectralCore + 0.012 * spectralHalo) * angularVariation * life;

  float highlight = crest * 0.32 + max(luminanceDelta, 0.0);
  float shadow = trough * 0.24 + max(-luminanceDelta, 0.0);
  float opticalEnergy = highlight + shadow;
  float highlightMix = highlight / max(highlight + shadow, 0.0001);

  vec3 shadowColor = vec3(0.015, 0.021, 0.028);
  vec3 highlightColor = vec3(0.68, 0.76, 0.86);
  vec3 overlayColor = mix(shadowColor, highlightColor, highlightMix);
  overlayColor = clamp(overlayColor, 0.0, 1.0);

  float opticalAlpha = clamp(opticalEnergy * rippleEnvelope * life, 0.0, 0.4);
  float alpha = clamp(opticalAlpha + spectralAlpha, 0.0, 0.46);
  vec3 premultipliedColor = overlayColor * opticalAlpha + spectralColor * spectralAlpha;
  fragColor = vec4(premultipliedColor, alpha);
}
`;

function createShader(gl, type, source) {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.warn("Refraction ripple shader failed to compile", gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function createProgram(gl) {
  const vertex = createShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const fragment = createShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
  if (!vertex || !fragment) return null;

  const program = gl.createProgram();
  if (!program) return null;
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.warn("Refraction ripple program failed to link", gl.getProgramInfoLog(program));
    gl.deleteProgram(program);
    return null;
  }
  return program;
}

export default function RefractionRippleCanvas({
  sourceVideoRef,
  sourceVideoRefs,
  triggerRef,
  saturation = 0.82,
  contrast = 1.04,
  brightness = 0.68,
  blurRadius = 11,
}) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const trigger = triggerRef.current;
    const collection = Array.isArray(sourceVideoRefs?.current)
      ? sourceVideoRefs.current
      : Array.isArray(sourceVideoRefs)
        ? sourceVideoRefs
        : [];
    const videos = [...new Set([...collection, sourceVideoRef?.current].filter(Boolean))].slice(0, 2);
    const canHover = window.matchMedia("(hover: hover) and (pointer: fine)");
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

    if (!canvas || !trigger || !videos.length || !canHover.matches || reduceMotion.matches) return undefined;

    const gl = canvas.getContext("webgl2", {
      alpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
      powerPreference: "high-performance",
    });
    if (!gl) return undefined;

    const program = createProgram(gl);
    if (!program) return undefined;

    const vao = gl.createVertexArray();
    const textures = [gl.createTexture(), gl.createTexture()];
    if (!vao || textures.some((texture) => !texture)) return undefined;

    const uniforms = Object.fromEntries([
      "u_videoA",
      "u_videoB",
      "u_viewport",
      "u_videoSizeA",
      "u_videoSizeB",
      "u_videoMix",
      "u_videoGrade",
      "u_blurRadius",
      "u_buttonRect",
      "u_origin",
      "u_progress",
      "u_strength",
      "u_dispersion",
    ].map((name) => [name, gl.getUniformLocation(program, name)]));

    gl.useProgram(program);
    gl.bindVertexArray(vao);
    textures.forEach((texture, index) => {
      gl.activeTexture(gl.TEXTURE0 + index);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    });
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.uniform1i(uniforms.u_videoA, 0);
    gl.uniform1i(uniforms.u_videoB, 1);
    gl.uniform3f(uniforms.u_videoGrade, saturation, contrast, brightness);
    gl.uniform1f(uniforms.u_blurRadius, blurRadius);
    gl.uniform2f(uniforms.u_origin, 25 / 228, 0.5);
    gl.uniform1f(uniforms.u_strength, 12.5);
    gl.uniform1f(uniforms.u_dispersion, 1.05);
    gl.clearColor(0, 0, 0, 0);

    let animationFrame = 0;
    let animationStart = 0;
    const textureSizes = [{ width: 0, height: 0 }, { width: 0, height: 0 }];
    let disposed = false;
    let rect = trigger.getBoundingClientRect();

    const clear = () => {
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clear(gl.COLOR_BUFFER_BIT);
    };

    const resize = () => {
      rect = trigger.getBoundingClientRect();
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 1.75);
      const width = Math.max(1, Math.round(rect.width * pixelRatio));
      const height = Math.max(1, Math.round(rect.height * pixelRatio));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      gl.viewport(0, 0, width, height);
      clear();
    };

    const uploadVideoFrame = (video, index) => {
      if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !video.videoWidth || !video.videoHeight) return false;
      gl.activeTexture(gl.TEXTURE0 + index);
      gl.bindTexture(gl.TEXTURE_2D, textures[index]);
      try {
        if (textureSizes[index].width !== video.videoWidth || textureSizes[index].height !== video.videoHeight) {
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
          textureSizes[index].width = video.videoWidth;
          textureSizes[index].height = video.videoHeight;
        } else {
          gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, video);
        }
        return true;
      } catch {
        return false;
      }
    };

    const readVideoBlend = (videoA, videoB) => {
      if (videoA === videoB) return 0;
      const opacityA = Number.parseFloat(getComputedStyle(videoA).opacity) || 0;
      const opacityB = Number.parseFloat(getComputedStyle(videoB).opacity) || 0;
      const aIsFront = videoA.hasAttribute("data-front");
      const bIsFront = videoB.hasAttribute("data-front");
      let weightA = opacityA;
      let weightB = opacityB;

      if (aIsFront && !bIsFront) weightB *= 1 - opacityA;
      else if (bIsFront && !aIsFront) weightA *= 1 - opacityB;

      const total = weightA + weightB;
      return total > 0.0001 ? weightB / total : 0;
    };

    const render = (now) => {
      if (disposed) return;
      const progress = Math.min(1, (now - animationStart) / 920);
      const videoA = videos[0];
      const videoB = videos[1]?.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA ? videos[1] : videoA;
      if (!uploadVideoFrame(videoA, 0) || !uploadVideoFrame(videoB, 1)) {
        clear();
        return;
      }

      gl.useProgram(program);
      gl.bindVertexArray(vao);
      gl.uniform2f(uniforms.u_viewport, window.innerWidth, window.innerHeight);
      gl.uniform2f(uniforms.u_videoSizeA, videoA.videoWidth, videoA.videoHeight);
      gl.uniform2f(uniforms.u_videoSizeB, videoB.videoWidth, videoB.videoHeight);
      gl.uniform1f(uniforms.u_videoMix, readVideoBlend(videoA, videoB));
      gl.uniform4f(uniforms.u_buttonRect, rect.left, rect.top, rect.width, rect.height);
      gl.uniform1f(uniforms.u_progress, progress);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      if (progress < 1) animationFrame = requestAnimationFrame(render);
      else {
        animationFrame = 0;
        clear();
      }
    };

    const play = () => {
      if (document.hidden || !videos.some((video) => video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA)) return;
      if (animationFrame) return;
      resize();
      animationStart = performance.now();
      animationFrame = requestAnimationFrame(render);
    };

    const playWhenReady = () => {
      if (trigger.matches(":hover")) play();
    };

    const stop = () => {
      cancelAnimationFrame(animationFrame);
      animationFrame = 0;
      clear();
    };

    const handleVisibility = () => {
      if (document.hidden) stop();
    };

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(trigger);
    trigger.addEventListener("pointerenter", play);
    trigger.addEventListener("pointerleave", stop);
    videos.forEach((video) => video.addEventListener("loadeddata", playWhenReady));
    window.addEventListener("resize", resize);
    document.addEventListener("visibilitychange", handleVisibility);
    resize();
    canvas.dataset.refractionReady = "";

    return () => {
      disposed = true;
      stop();
      resizeObserver.disconnect();
      trigger.removeEventListener("pointerenter", play);
      trigger.removeEventListener("pointerleave", stop);
      videos.forEach((video) => video.removeEventListener("loadeddata", playWhenReady));
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", handleVisibility);
      textures.forEach((texture) => gl.deleteTexture(texture));
      gl.deleteVertexArray(vao);
      gl.deleteProgram(program);
      delete canvas.dataset.refractionReady;
    };
  }, [blurRadius, brightness, contrast, saturation, sourceVideoRef, sourceVideoRefs, triggerRef]);

  return <canvas ref={canvasRef} className="seal-refraction-canvas" aria-hidden="true" />;
}
