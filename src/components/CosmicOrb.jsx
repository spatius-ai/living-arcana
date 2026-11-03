import { useEffect, useRef } from "react";
import { fragmentShader, glassFragmentShader, vertexShader } from "./cosmicOrbShader.js";

const DEFAULT_PALETTE = { anchor: "#6a3cff", colorA: "#3ce0ff", colorB: "#a24bff", colorC: "#ff5ea8" };

function rgb(hex) {
  let value = hex.replace(/^#/, "");
  if (value.length === 3) value = [...value].map((channel) => channel + channel).join("");
  return [0, 2, 4].map((offset) => parseInt(value.slice(offset, offset + 2), 16) / 255);
}

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.warn("[Living Arcana] Crystal orb shader compilation failed:", gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

export default function CosmicOrb({
  size = 50, palette = DEFAULT_PALETTE, background = "#05050f",
  speed = 50, spin = 50, lens = true, lensAmount = 45, style, className,
}) {
  const canvasRef = useRef(null);
  const anchor = palette.anchor || DEFAULT_PALETTE.anchor;
  const colorA = palette.colorA || DEFAULT_PALETTE.colorA;
  const colorB = palette.colorB || DEFAULT_PALETTE.colorB;
  const colorC = palette.colorC || DEFAULT_PALETTE.colorC;

  useEffect(() => {
    const canvas = canvasRef.current;
    const gl = canvas.getContext("webgl", { alpha: true, antialias: false, depth: false, premultipliedAlpha: false });
    if (!gl) return undefined;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let frame = 0;
    let previousTime = 0;
    let elapsed = 0;
    let visible = true;
    let lost = false;
    let ready = false;
    let scenePass;
    let glassPass;
    let texture;
    let framebuffer;
    let textureSize = 0;
    let buffer;
    let shaders = [];

    const resize = () => {
      const bounds = canvas.getBoundingClientRect();
      const resolution = Math.max(1, Math.min(512, Math.round(Math.max(bounds.width, bounds.height) * Math.min(window.devicePixelRatio || 1, 2))));
      if (canvas.width !== resolution || canvas.height !== resolution) {
        canvas.width = resolution;
        canvas.height = resolution;
      }
      if (texture && textureSize !== resolution) {
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, resolution, resolution, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        textureSize = resolution;
      }
    };
    const paint = (now) => {
      frame = 0;
      if (lost || !ready) return;
      if (previousTime && !motion.matches) elapsed += Math.min((now - previousTime) / 1000, 0.05);
      previousTime = now;
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.useProgram(scenePass.program);
      gl.uniform1f(scenePass.uniforms.uTime, elapsed);
      gl.uniform1f(scenePass.uniforms.uResolution, canvas.width);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.useProgram(glassPass.program);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.uniform1f(glassPass.uniforms.uTime, elapsed);
      gl.uniform1f(glassPass.uniforms.uResolution, canvas.width);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      if (canvas.style.opacity !== "1") canvas.style.opacity = "1";
      if (!motion.matches && (speed > 0 || spin > 0) && visible && !document.hidden) frame = requestAnimationFrame(paint);
    };
    const resume = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      previousTime = 0;
      if (!lost && ready && visible && !document.hidden) frame = requestAnimationFrame(paint);
    };
    const initialize = () => {
      ready = false;
      const vertex = compile(gl, gl.VERTEX_SHADER, vertexShader);
      shaders = [vertex].filter(Boolean);
      if (!vertex) return;
      const createPass = (source) => {
        const fragment = compile(gl, gl.FRAGMENT_SHADER, source);
        if (!fragment) return null;
        shaders.push(fragment);
        const program = gl.createProgram();
        gl.attachShader(program, vertex);
        gl.attachShader(program, fragment);
        gl.bindAttribLocation(program, 0, "aPosition");
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
          console.warn("[Living Arcana] Crystal orb program linking failed:", gl.getProgramInfoLog(program));
          gl.deleteProgram(program);
          return null;
        }
        gl.useProgram(program);
        const uniforms = Object.fromEntries(["uTime", "uResolution", "uBackground", "uAnchor", "uColorA", "uColorB", "uColorC", "uSpeed", "uSpin", "uLens", "uScene"].map((name) => [name, gl.getUniformLocation(program, name)]));
        for (const [name, color] of Object.entries({ uBackground: background, uAnchor: anchor, uColorA: colorA, uColorB: colorB, uColorC: colorC })) gl.uniform3fv(uniforms[name], rgb(color));
        gl.uniform1f(uniforms.uSpeed, Math.max(0, speed) / 50);
        gl.uniform1f(uniforms.uSpin, Math.max(0, spin) / 50);
        gl.uniform1f(uniforms.uLens, lens ? Math.min(1, Math.max(0, lensAmount) / 100) : 0);
        gl.uniform1i(uniforms.uScene, 0);
        return { program, uniforms };
      };
      scenePass = createPass(fragmentShader);
      glassPass = createPass(glassFragmentShader);
      if (!scenePass || !glassPass) return;
      buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      framebuffer = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
      textureSize = 0;
      resize();
      const complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      if (!complete) {
        console.warn("[Living Arcana] Crystal orb render texture is unavailable.");
        return;
      }
      ready = true;
      resume();
    };
    const onLost = (event) => {
      event.preventDefault();
      lost = true;
      ready = false;
      cancelAnimationFrame(frame);
      canvas.style.opacity = "0";
    };
    const onRestored = () => {
      lost = false;
      initialize();
    };
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      resume();
    });
    const resizeObserver = new ResizeObserver(() => {
      resize();
      resume();
    });
    canvas.addEventListener("webglcontextlost", onLost);
    canvas.addEventListener("webglcontextrestored", onRestored);
    document.addEventListener("visibilitychange", resume);
    motion.addEventListener("change", resume);
    observer.observe(canvas);
    resizeObserver.observe(canvas);
    initialize();

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      resizeObserver.disconnect();
      document.removeEventListener("visibilitychange", resume);
      motion.removeEventListener("change", resume);
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
      shaders.forEach((shader) => gl.deleteShader(shader));
      if (buffer) gl.deleteBuffer(buffer);
      if (scenePass) gl.deleteProgram(scenePass.program);
      if (glassPass) gl.deleteProgram(glassPass.program);
      if (texture) gl.deleteTexture(texture);
      if (framebuffer) gl.deleteFramebuffer(framebuffer);
    };
  }, [size, background, anchor, colorA, colorB, colorC, speed, spin, lens, lensAmount]);

  return (
    <span aria-hidden="true" className={className} style={{
      display: "block", position: "relative", width: size, height: size,
      overflow: "hidden", borderRadius: "50%",
      background: `radial-gradient(ellipse at 75% 75%, ${colorB}55, transparent 55%), radial-gradient(ellipse at 25% 20%, ${anchor}44, ${background} 75%)`,
      ...style,
    }}>
      <canvas ref={canvasRef} style={{ display: "block", width: "100%", height: "100%", opacity: 0 }} />
    </span>
  );
}
