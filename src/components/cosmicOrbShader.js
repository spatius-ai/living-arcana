export const vertexShader = `
attribute vec2 aPosition;
varying vec2 vPosition;
void main() {
  vPosition = aPosition;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

export const fragmentShader = `
precision highp float;
varying vec2 vPosition;
uniform float uTime;
uniform float uResolution;
uniform vec3 uBackground;
uniform vec3 uAnchor;
uniform vec3 uColorA;
uniform vec3 uColorB;
uniform vec3 uColorC;
uniform float uSpeed;
uniform float uSpin;
uniform float uLens;

float hash(vec3 p) {
  p = fract(p * vec3(0.1031, 0.11369, 0.13787));
  p += dot(p, p.yzx + 19.19);
  return fract((p.x + p.y) * p.z);
}

float noise(vec3 p) {
  vec3 cell = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash(cell), hash(cell + vec3(1, 0, 0)), f.x),
        mix(hash(cell + vec3(0, 1, 0)), hash(cell + vec3(1, 1, 0)), f.x), f.y),
    mix(mix(hash(cell + vec3(0, 0, 1)), hash(cell + vec3(1, 0, 1)), f.x),
        mix(hash(cell + vec3(0, 1, 1)), hash(cell + vec3(1, 1, 1)), f.x), f.y), f.z);
}

float mist(vec3 p) {
  return noise(p) * 0.57 + noise(p * 2.03 + 7.1) * 0.28 + noise(p * 4.11 - 3.7) * 0.15;
}

mat2 rotate(float angle) {
  float c = cos(angle), s = sin(angle);
  return mat2(c, -s, s, c);
}

vec3 stars(vec2 p, float layer, float time) {
  vec2 grid = p * (13.0 + layer * 4.0);
  vec2 cell = floor(grid);
  float seed = hash(vec3(cell, layer * 11.0));
  vec2 center = vec2(hash(vec3(cell, 37.0 + layer)), hash(vec3(cell, 69.0 + layer))) * 0.74 + 0.13;
  vec2 delta = fract(grid) - center;
  float radius = mix(0.018, 0.065, seed * seed);
  float point = exp(-dot(delta, delta) / (radius * radius));
  float halo = exp(-length(delta) * 33.0) * 0.12;
  float shimmer = 0.82 + 0.18 * sin(time * 0.6 + seed * 80.0);
  vec3 tint = mix(vec3(0.63, 0.62, 0.84), vec3(1.0, 0.88, 0.6), seed);
  return tint * (point + halo) * smoothstep(0.84, 0.97, seed) * shimmer;
}

void main() {
  vec2 uv = vPosition;
  float radius2 = dot(uv, uv);
  float coverage = 1.0 - smoothstep(1.0 - 3.0 / uResolution, 1.0, radius2);
  if (radius2 >= 1.0) {
    gl_FragColor = vec4(0.0);
    return;
  }

  float z = sqrt(1.0 - radius2);
  vec3 normal = vec3(uv, z);
  float time = uTime * uSpeed;
  float turn = uTime * uSpin * 0.025;
  vec2 refracted = uv * (1.0 + uLens * (0.32 - z * 0.3));
  vec3 color = mix(uBackground, vec3(0.018, 0.009, 0.038), 0.75);
  vec3 cloud = vec3(0.0);

  // Integrate a shallow volume so clouds drift behind the curved glass.
  for (int i = 0; i < 10; i++) {
    float depth = (float(i) + 0.5) / 10.0;
    vec3 p = vec3(refracted, mix(-z, z, depth));
    p.xz = rotate(turn + 0.35) * p.xz;
    p.yz = rotate(-0.32) * p.yz;
    vec3 flow = p * 2.7 + vec3(0.0, time * 0.027, time * 0.012);
    float warp = mist(flow + vec3(2.0, -1.0, 4.0));
    float density = mist(flow + vec3(warp * 1.65, -warp * 0.8, warp));
    float ribbon = exp(-abs(p.y + 0.38 * sin(p.x * 2.6 + warp * 3.0) - warp * 0.55 + 0.2) * 7.0);
    float wisps = smoothstep(0.39, 0.77, density) * (0.24 + ribbon * 0.76);
    float shell = 1.0 - smoothstep(0.3, 1.0, length(p));
    vec3 purple = mix(uAnchor, uColorB, density);
    vec3 tint = mix(purple, vec3(0.72, 0.66, 0.84), smoothstep(0.55, 0.86, density) * 0.66);
    tint = mix(tint, uColorC, smoothstep(0.1, 0.9, p.x) * 0.09);
    cloud += tint * wisps * (0.35 + shell * 0.65) * 0.13;
  }
  color += cloud;

  vec2 starPosition = rotate(turn * 0.35) * refracted;
  color += stars(starPosition + vec2(time * 0.002, 0.0), 0.0, time) * 1.20;
  color += stars(starPosition * 0.83 + vec2(1.7, -0.9), 1.0, time) * 0.75;
  color += stars(starPosition * 0.66 + vec2(-2.3, 0.7), 2.0, time) * 0.40;

  float fresnel = pow(1.0 - z, 2.7);
  float rimLight = 0.48 + 0.52 * dot(normal.xy, normalize(vec2(0.75, 0.6)));
  color += mix(uColorB, vec3(0.67, 0.62, 0.81), 0.65) * fresnel * (0.12 + rimLight * 0.28);
  float highlight = pow(max(0.0, dot(normal, normalize(vec3(-0.58, 0.68, 0.65)))), 42.0);
  float reflection = pow(max(0.0, dot(normal, normalize(vec3(0.76, -0.3, 0.32)))), 26.0);
  color += vec3(0.75, 0.78, 0.95) * highlight * 0.33;
  color += mix(uColorA, vec3(0.77, 0.72, 0.9), 0.9) * reflection * 0.28;
  color *= 0.7 + 0.3 * z;
  gl_FragColor = vec4(color, coverage);
}
`;
