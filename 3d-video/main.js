// NABA — storyboard concept film. Everything is a pure function of time t,
// so render.mjs can step through frames deterministically.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const W = innerWidth, H = innerHeight, TAU = Math.PI * 2;
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const V = (x, y, z) => new THREE.Vector3(x, y, z);
const C = (r, g, b) => new THREE.Color(r, g, b);
function rng(seed) {
  return () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// ---------- renderer ----------
const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.setSize(W, H);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.prepend(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(40, W / H, 1, 30000);
scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
scene.fog = new THREE.FogExp2(0xffffff, 0.00025);

const sun = new THREE.DirectionalLight(0xffffff, 3);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -460, right: 460, top: 460, bottom: -460, near: 10, far: 2600 });
sun.shadow.bias = -0.0006; sun.shadow.normalBias = 1.2;
scene.add(sun, sun.target);
const hemi = new THREE.HemisphereLight(0xffffff, 0x445566, 1);
scene.add(hemi);

// ---------- sky + ocean (shared uniforms) ----------
const U = {
  top: { value: C(0.1, 0.3, 0.8) }, hor: { value: C(0.8, 0.9, 1) }, deep: { value: C(0.01, 0.08, 0.16) },
  sunDir: { value: V(0, 1, 0) }, sunCol: { value: C(1, 0.9, 0.7) }, time: { value: 0 },
};
const SKY_FN = `
  uniform vec3 top, hor, sunDir, sunCol;
  vec3 skyCol(vec3 d, float sharp) {
    vec3 c = mix(hor, top, pow(max(d.y, 0.0), 0.45));
    float s = max(dot(d, sunDir), 0.0);
    return c + sunCol * (pow(s, sharp) * 5.0 + pow(s, 18.0) * 0.16);
  }`;
const sky = new THREE.Mesh(new THREE.SphereGeometry(12000, 48, 24), new THREE.ShaderMaterial({
  uniforms: U, side: THREE.BackSide, depthWrite: false, fog: false,
  vertexShader: `varying vec3 vDir; void main(){ vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `varying vec3 vDir; ${SKY_FN} void main(){ gl_FragColor = vec4(skyCol(normalize(vDir), 700.0), 1.0); }`,
}));
sky.frustumCulled = false;
scene.add(sky);

const ocean = new THREE.Mesh(new THREE.PlaneGeometry(40000, 40000).rotateX(-Math.PI / 2), new THREE.ShaderMaterial({
  uniforms: U, fog: false,
  vertexShader: `varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
  fragmentShader: `
    varying vec3 vW; uniform vec3 deep; uniform float time; ${SKY_FN}
    vec2 wave(vec2 p, vec2 d, float f, float a, float s) { return d * f * a * cos(dot(p, d) * f + time * s); }
    void main() {
      vec3 toCam = cameraPosition - vW; float dist = length(toCam); vec3 Vd = toCam / dist;
      vec2 p = vW.xz; vec2 g = vec2(0.0);
      g += wave(p, vec2(0.80, 0.60), 0.030, 1.6, 0.9);
      g += wave(p, vec2(-0.45, 0.89), 0.055, 0.9, 1.2);
      g += wave(p, vec2(0.95, -0.31), 0.110, 0.45, 1.7);
      g += wave(p, vec2(0.20, 0.98), 0.230, 0.22, 2.3);
      g += wave(p, vec2(-0.70, -0.71), 0.470, 0.10, 3.1);
      g += wave(p, vec2(0.60, -0.80), 0.900, 0.05, 4.0);
      vec3 N = normalize(vec3(-g.x, 1.0, -g.y));
      N = normalize(mix(vec3(0.0, 1.0, 0.0), N, 1.0 / (1.0 + dist * 0.0022)));
      float fr = 0.03 + 0.97 * pow(1.0 - max(dot(N, Vd), 0.0), 5.0);
      vec3 R = reflect(-Vd, N); R.y = abs(R.y);
      vec3 c = mix(deep, skyCol(R, 220.0), fr);
      c = mix(c, hor, 1.0 - exp(-dist * 0.00028));
      gl_FragColor = vec4(c, 1.0);
    }`,
}));
scene.add(ocean);

// ---------- materials ----------
const M = {
  white: new THREE.MeshStandardMaterial({ color: 0xe4e8ec, roughness: 0.42, metalness: 0.05 }),
  grey: new THREE.MeshStandardMaterial({ color: 0x9aa4ae, roughness: 0.5, metalness: 0.3 }),
  glass: new THREE.MeshStandardMaterial({ color: 0xa6dcf0, roughness: 0.05, metalness: 0.25, transparent: true, opacity: 0.34, depthWrite: false }),
  panel: new THREE.MeshStandardMaterial({ color: 0x0b2a5c, roughness: 0.18, metalness: 0.75 }),
  green: new THREE.MeshStandardMaterial({ color: 0x3f8f3a, roughness: 0.95 }),
  green2: new THREE.MeshStandardMaterial({ color: 0x2c6b2c, roughness: 0.95 }),
  sand: new THREE.MeshStandardMaterial({ color: 0xc9a06a, roughness: 1 }),
  glow: new THREE.MeshBasicMaterial({ color: C(0.2, 1.2, 2.1) }),
  band: new THREE.MeshBasicMaterial({ color: C(0.2, 0.8, 1.2) }),
};
const shadowed = (m, cast = true) => { m.castShadow = cast; m.receiveShadow = true; return m; };
const mesh = (g, m, cast) => shadowed(new THREE.Mesh(g, m), cast);

const dot = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const x = c.getContext('2d'), g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.35, 'rgba(255,255,255,.55)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g; x.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
})();
function points(n, size, color) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  const p = new THREE.Points(g, new THREE.PointsMaterial({
    size, color, map: dot, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
  }));
  p.frustumCulled = false;
  return p;
}

// ---------- the city ----------
const city = new THREE.Group(); scene.add(city);
const towerR = y => 14 + 26 * Math.pow(1 - y / 260, 1.6) + 6 * Math.exp(-(((y - 205) / 14) ** 2));
{
  const pts = [];
  for (let i = 0; i <= 52; i++) { const y = i / 52 * 260; pts.push(new THREE.Vector2(towerR(y), y)); }
  pts.push(new THREE.Vector2(3, 268), new THREE.Vector2(1, 315), new THREE.Vector2(0, 316));
  city.add(mesh(new THREE.LatheGeometry(pts, 72), M.white));
  for (const y of [38, 76, 114, 152, 236]) {
    const b = new THREE.Mesh(new THREE.TorusGeometry(towerR(y) + 0.5, 1.1, 8, 72), M.glow);
    b.rotation.x = Math.PI / 2; b.position.y = y; city.add(b);
  }
  const obs = mesh(new THREE.TorusGeometry(33, 4.5, 14, 72), M.glass); obs.rotation.x = Math.PI / 2; obs.position.y = 205; city.add(obs);
  const obs2 = mesh(new THREE.CylinderGeometry(37, 31, 2.5, 72), M.white); obs2.position.y = 199.5; city.add(obs2);
  const base = mesh(new THREE.CylinderGeometry(52, 60, 14, 72), M.white); base.position.y = 5; city.add(base);

  const ring = (ri, ro, y0, y1) => mesh(new THREE.LatheGeometry(
    [[ri, y0], [ro, y0], [ro, y1], [ri, y1], [ri, y0]].map(p => new THREE.Vector2(p[0], p[1])), 128), M.white);
  city.add(ring(106, 134, -4, 9), ring(190, 230, -4, 9), ring(282, 318, -4, 9));
  for (const [r, w] of [[134, 0.6], [230, 0.6], [318, 0.7]]) {      // glowing deck edges
    const e = new THREE.Mesh(new THREE.TorusGeometry(r + 0.3, w, 6, 160), M.band); e.rotation.x = Math.PI / 2; e.position.y = 8.6; city.add(e);
  }
  for (let k = 0; k < 6; k++) {                                     // bridges
    const a = k * TAU / 6, b = mesh(new THREE.BoxGeometry(262, 3, 11), M.white);
    b.position.set(Math.cos(a) * 175, 7, Math.sin(a) * 175); b.rotation.y = -a; city.add(b);
  }
  // buildings + light bands
  const r = rng(7), N = 190, box = new THREE.BoxGeometry(1, 1, 1);
  const bld = new THREE.InstancedMesh(box, M.white, N), bands = new THREE.InstancedMesh(box, M.band, N * 2);
  const o = new THREE.Object3D();
  for (let i = 0; i < N; i++) {
    const inner = i < 70, a = r() * TAU, rad = inner ? lerp(111, 129, r()) : lerp(288, 312, r());
    const w = lerp(6, 13, r()), d = lerp(6, 12, r()), h = inner ? lerp(14, 58, r() * r()) + 6 : lerp(7, 30, r());
    o.position.set(Math.cos(a) * rad, 9 + h / 2, Math.sin(a) * rad); o.rotation.set(0, -a, 0); o.scale.set(d, h, w); o.updateMatrix();
    bld.setMatrixAt(i, o.matrix);
    for (let j = 0; j < 2; j++) {
      o.position.y = 9 + h * (j ? 0.45 : 0.82); o.scale.set(d + 0.3, 0.7, w + 0.3); o.updateMatrix(); bands.setMatrixAt(i * 2 + j, o.matrix);
    }
  }
  city.add(shadowed(bld), bands);
  // garden domes
  for (let k = 0; k < 6; k++) {
    const a = (45 + k * 60) * Math.PI / 180, g = new THREE.Group();
    g.position.set(Math.cos(a) * 210, 9, Math.sin(a) * 210);
    const garden = mesh(new THREE.SphereGeometry(1, 24, 12), M.green); garden.scale.set(21, 9, 21);
    const dome = new THREE.Mesh(new THREE.SphereGeometry(27, 40, 18, 0, TAU, 0, Math.PI / 2), M.glass);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(27, 0.8, 6, 64), M.band); rim.rotation.x = Math.PI / 2; rim.position.y = 0.6;
    g.add(garden, dome, rim); city.add(g);
  }
  // rooftop solar on the outer ring + floating solar petals
  const sp = new THREE.InstancedMesh(box, M.panel, 150);
  for (let i = 0; i < 150; i++) {
    const a = i / 150 * TAU; o.position.set(Math.cos(a) * 300, 10.2, Math.sin(a) * 300);
    o.rotation.set(0, -a, 0.22); o.scale.set(9, 0.4, 9.5); o.updateMatrix(); sp.setMatrixAt(i, o.matrix);
  }
  city.add(sp);
  for (let k = 1; k < 12; k++) {
    const a = k * TAU / 12, g = new THREE.Group(); g.position.set(Math.cos(a) * 392, 0, Math.sin(a) * 392); g.rotation.y = -a;
    const float = mesh(new THREE.CylinderGeometry(38, 38, 4, 6), M.white); float.position.y = 0.5;
    const pan = mesh(new THREE.CylinderGeometry(34, 34, 1, 6), M.panel); pan.position.y = 3.2;
    const walk = mesh(new THREE.BoxGeometry(40, 1.5, 5), M.white); walk.position.set(-55, 3, 0);
    g.add(float, pan, walk); city.add(g);
  }
}
// intake arms
const arms = [];
for (let k = 0; k < 6; k++) {
  const a = (15 + k * 60) * Math.PI / 180;
  const curve = new THREE.CatmullRomCurve3([[36, 32], [120, 56], [235, 52], [318, 30], [352, -14]]
    .map(([r, y]) => V(Math.cos(a) * r, y, Math.sin(a) * r)));
  arms.push({ a, curve });
  city.add(mesh(new THREE.TubeGeometry(curve, 80, 5, 14), M.glass));
  for (const u of [0.02, 0.33, 0.66, 0.9]) {                         // collars
    const p = curve.getPoint(u), tg = curve.getTangent(u), c = mesh(new THREE.CylinderGeometry(5.8, 5.8, 3, 20), M.white);
    c.position.copy(p); c.quaternion.setFromUnitVectors(V(0, 1, 0), tg); city.add(c);
  }
}
const ARM_N = 170, armPts = points(arms.length * ARM_N, 5, C(0.25, 1.1, 1.9)); city.add(armPts);
const armSeed = (() => { const r = rng(3); return Array.from({ length: arms.length * ARM_N }, () => [r(), r() - 0.5, r() - 0.5, r() - 0.5]); })();

// ---------- pipeline, coast, fields ----------
const PIPE_A = 318, PIPE_B = 1540, shore = new THREE.Group(); scene.add(shore);
const terrainH = (x, z) => {
  const xx = x + 45 * Math.sin(z * 0.004) + 20 * Math.sin(z * 0.011 + 2);
  return -9 + 17.3 * smooth(1330, 1470, xx)
    + smooth(2350, 3300, x) * (26 * Math.sin(x * 0.006 + 1.3) * Math.cos(z * 0.0045 + 0.5) + 12 * Math.sin(x * 0.015 + z * 0.012) + 28);
};
const fields = [];
{
  const L = PIPE_B - PIPE_A;
  const pipe = mesh(new THREE.CylinderGeometry(5, 5, L, 20), M.white); pipe.rotation.z = Math.PI / 2; pipe.position.set(PIPE_A + L / 2, 13, 0);
  const stripe = new THREE.Mesh(new THREE.BoxGeometry(L, 0.5, 1.3), M.glow); stripe.position.set(PIPE_A + L / 2, 18.1, 0);
  shore.add(pipe, stripe);
  const n = Math.floor(L / 62), py = new THREE.InstancedMesh(new THREE.CylinderGeometry(2.4, 3, 34, 10), M.white, n), o = new THREE.Object3D();
  for (let i = 0; i < n; i++) { o.position.set(PIPE_A + 40 + i * 62, -6, 0); o.updateMatrix(); py.setMatrixAt(i, o.matrix); }
  shore.add(shadowed(py));

  const tg = new THREE.PlaneGeometry(2700, 5000, 180, 200).rotateX(-Math.PI / 2).translate(1300 + 1350, 0, 0), p = tg.attributes.position;
  for (let i = 0; i < p.count; i++) p.setY(i, terrainH(p.getX(i), p.getZ(i)));
  tg.computeVertexNormals();
  shore.add(mesh(tg, M.sand, false));

  const term = mesh(new THREE.CylinderGeometry(30, 34, 16, 48), M.white); term.position.set(PIPE_B + 20, 16, 0);
  const tdome = mesh(new THREE.SphereGeometry(26, 40, 16, 0, TAU, 0, Math.PI / 2), M.glass); tdome.position.set(PIPE_B + 20, 24, 0);
  const tring = new THREE.Mesh(new THREE.TorusGeometry(31, 0.8, 6, 64), M.glow); tring.rotation.x = Math.PI / 2; tring.position.set(PIPE_B + 20, 24.4, 0);
  shore.add(term, tdome, tring);

  const r = rng(21), water = new THREE.MeshStandardMaterial({ color: 0x1b76b5, roughness: 0.08, metalness: 0.4 });
  let guard = 0;
  while (fields.length < 20 && guard++ < 4000) {
    const f = { x: lerp(1640, 2330, r()), z: lerp(-760, 760, r()), r: lerp(42, 92, r()), lake: false };
    if (Math.hypot(f.x - (PIPE_B + 20), f.z) < f.r + 70) continue;
    if (fields.some(g => Math.hypot(g.x - f.x, g.z - f.z) < g.r + f.r + 12)) continue;
    f.lake = fields.length % 6 === 2;
    const g = new THREE.Group(); g.position.set(f.x, 8.5, f.z);
    const disc = mesh(new THREE.CircleGeometry(f.r, 56).rotateX(-Math.PI / 2), f.lake ? water : M.green, false);
    g.add(disc);
    if (!f.lake) for (const q of [0.38, 0.7]) {
      const rr = mesh(new THREE.RingGeometry(f.r * q, f.r * (q + 0.12), 56).rotateX(-Math.PI / 2), M.green2, false); rr.position.y = 0.08; g.add(rr);
    }
    // feeder canal back to the terminal
    const dx = f.x - (PIPE_B + 20), dz = f.z, len = Math.hypot(dx, dz);
    const canal = new THREE.Mesh(new THREE.BoxGeometry(len, 0.3, 1.6), M.glow);
    canal.position.set(PIPE_B + 20 + dx / 2, 8.5, dz / 2); canal.rotation.y = -Math.atan2(dz, dx);
    shore.add(g, canal);
    Object.assign(f, { g, canal, len, t0: 34.2 + (len / 900) * 2.6, bushes: [] });
    if (!f.lake) for (let i = 0; i < 26; i++) { const a = r() * TAU, d = Math.sqrt(r()) * f.r * 0.92; f.bushes.push([Math.cos(a) * d, Math.sin(a) * d, lerp(2.2, 5.2, r())]); }
    fields.push(f);
  }
}
const bushN = fields.reduce((s, f) => s + f.bushes.length, 0);
const bushes = shadowed(new THREE.InstancedMesh(new THREE.SphereGeometry(1, 8, 6), M.green2, bushN)); bushes.frustumCulled = false; shore.add(bushes);
const pipePts = points(120, 7, C(0.3, 1.2, 2.0)); shore.add(pipePts);

// ---------- interior membrane hall ----------
const IY = -3000, hall = new THREE.Group(); hall.position.y = IY; scene.add(hall);
const cols = [];
{
  const floorM = new THREE.MeshStandardMaterial({ color: 0xb9c2cb, roughness: 0.12, metalness: 0.5 });
  const wallM = new THREE.MeshStandardMaterial({ color: 0xcfd5db, roughness: 0.6 });
  const lightM = new THREE.MeshBasicMaterial({ color: C(1.7, 1.8, 2.0) });
  const add = (g, m, x, y, z) => { const o = new THREE.Mesh(g, m); o.position.set(x, y, z); hall.add(o); return o; };
  add(new THREE.BoxGeometry(96, 1, 470), floorM, 0, -0.5, 0);
  add(new THREE.BoxGeometry(96, 1, 470), wallM, 0, 30.5, 0);
  add(new THREE.BoxGeometry(1, 32, 470), wallM, -48, 15, 0); add(new THREE.BoxGeometry(1, 32, 470), wallM, 48, 15, 0);
  add(new THREE.BoxGeometry(96, 32, 1), wallM, 0, 15, 235); add(new THREE.BoxGeometry(96, 32, 1), wallM, 0, 15, -235);
  for (const x of [-34, -20, -6, 6, 20, 34]) add(new THREE.BoxGeometry(1.4, 0.3, 460), lightM, x, 29.8, 0);
  for (const x of [-7, 7]) add(new THREE.BoxGeometry(0.5, 0.08, 460), M.glow, x, 0.05, 0);
  for (const [rr, w] of [[11, 0.7], [7, 0.35], [15, 0.25]]) add(new THREE.TorusGeometry(rr, w, 8, 80), M.glow, 0, 15, 234);
  for (const x of [-38, -26, -14, 14, 26, 38]) for (let z = -208; z <= 208; z += 16) cols.push([x, z]);
  const n = cols.length, o = new THREE.Object3D();
  const metal = new THREE.MeshStandardMaterial({ color: 0xe6eaee, roughness: 0.22, metalness: 0.8 });
  const parts = [
    [new THREE.CylinderGeometry(3.3, 3.3, 18, 24), M.glass, 11.5],
    [new THREE.CylinderGeometry(2.5, 2.5, 17.4, 20), new THREE.MeshBasicMaterial({ color: C(0.06, 0.42, 0.72), transparent: true, opacity: 0.8 }), 11.5],
    [new THREE.CylinderGeometry(4.2, 4.6, 2.5, 24), metal, 1.25],
    [new THREE.CylinderGeometry(4.2, 3.6, 1.8, 24), metal, 21.3],
    [new THREE.CylinderGeometry(0.6, 0.6, 8, 8), metal, 26],
    [new THREE.TorusGeometry(4.3, 0.22, 6, 32).rotateX(Math.PI / 2), M.glow, 2.6],
  ];
  parts.sort((a, b) => (a[1].transparent ? 1 : 0) - (b[1].transparent ? 1 : 0));
  for (const [g, m, y] of parts) {
    const im = new THREE.InstancedMesh(g, m, n);
    cols.forEach(([x, z], i) => { o.position.set(x, y, z); o.updateMatrix(); im.setMatrixAt(i, o.matrix); });
    im.frustumCulled = false; hall.add(im);
  }
}
const BUB = 9, bubPts = points(cols.length * BUB, 0.8, C(0.7, 1.5, 2.0)); hall.add(bubPts);
const bubSeed = (() => { const r = rng(11); return Array.from({ length: cols.length * BUB }, () => [r(), (r() - 0.5) * 3.6, (r() - 0.5) * 3.6, lerp(0.16, 0.34, r())]); })();
const hallLight = new THREE.PointLight(0xdff2ff, 0, 0, 0); scene.add(hallLight);

// ---------- post ----------
const rt = new THREE.WebGLRenderTarget(W, H, { type: THREE.HalfFloatType, samples: 4 });
const composer = new EffectComposer(renderer, rt);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(W, H), 0.4, 0.6, 1.5);
composer.addPass(bloom);
composer.addPass(new OutputPass());

// ---------- looks ----------
const LOOK = {
  dawn: { top: C(0.10, 0.17, 0.40), hor: C(0.86, 0.50, 0.32), sunCol: C(1.5, 0.85, 0.42), deep: C(0.015, 0.05, 0.11),
    sunDir: V(1, 0.075, -0.16), light: C(1, 0.78, 0.58), li: 2.4, hi: 0.5, band: C(1.9, 1.25, 0.5), exp: 0.9, fog: 0.00030 },
  day: { top: C(0.07, 0.26, 0.70), hor: C(0.60, 0.76, 0.92), sunCol: C(1.3, 1.2, 1.0), deep: C(0.008, 0.10, 0.19),
    sunDir: V(-0.45, 0.72, 0.5), light: C(1, 0.97, 0.92), li: 3.1, hi: 0.65, band: C(0.25, 1.0, 1.6), exp: 0.9, fog: 0.00020 },
  dusk: { top: C(0.08, 0.08, 0.27), hor: C(0.85, 0.36, 0.18), sunCol: C(1.6, 0.65, 0.25), deep: C(0.02, 0.035, 0.09),
    sunDir: V(0.82, 0.085, -0.57), light: C(1, 0.62, 0.4), li: 2.2, hi: 0.4, band: C(3.0, 1.8, 0.6), exp: 0.9, fog: 0.00028 },
  hall: { top: C(1, 1, 1), hor: C(1, 1, 1), sunCol: C(0, 0, 0), deep: C(0, 0, 0),
    sunDir: V(0.15, 1, 0.2), light: C(1, 1, 1), li: 0.5, hi: 0.75, band: C(0.2, 0.85, 1.3), exp: 0.85, fog: 0 },
};

// ---------- shots ----------
const SHOTS = [
  { a: 0, b: 7, look: 'dawn', fov: 34, cam: k => ({ p: V(lerp(-1650, -1020, k), lerp(5, 13, k), lerp(330, 215, k)), l: V(0, lerp(95, 110, k), 0) }) },
  { a: 7, b: 15, look: 'day', fov: 40, cam: k => { const a = lerp(3.55, 5.0, k), r = lerp(820, 660, k); return { p: V(Math.cos(a) * r, lerp(330, 190, k), Math.sin(a) * r), l: V(0, 105, 0) }; } },
  { a: 15, b: 22, look: 'day', fov: 46, cam: k => {
    const a = arms[0].a, er = V(Math.cos(a), 0, Math.sin(a)), et = V(-Math.sin(a), 0, Math.cos(a));
    return { p: er.clone().multiplyScalar(lerp(455, 330, k)).addScaledVector(et, lerp(34, 62, k)).setY(lerp(7, 30, k)),
      l: er.clone().multiplyScalar(lerp(250, 60, k)).setY(lerp(45, 95, k)) };
  } },
  { a: 22, b: 30, look: 'hall', fov: 52, cam: k => ({ p: V(lerp(-1.5, 1.5, k), IY + lerp(6.5, 9.5, k), lerp(-205, -70, k)), l: V(0, IY + 11.5, lerp(-60, 120, k)) }) },
  { a: 30, b: 39, look: 'day', fov: 44, cam: k => {
    const x = lerp(250, 1560, Math.pow(k, 0.92)), up = smooth(0.42, 1, k);
    return { p: V(x, 30 + 205 * up, -46 - 150 * up), l: V(x + 470, 10, 30 * up), st: V(clamp(x + 250, 0, 1900), 0, 0) };
  } },
  { a: 39, b: 46, look: 'dusk', fov: 36, cam: k => ({ p: V(lerp(-560, -800, k), lerp(34, 70, k), lerp(390, 560, k)), l: V(0, lerp(228, 242, k), 0) }) },
];
const CAPS = [
  [0.9, 6.4, 'What if the sea could end water scarcity?'],
  [7.4, 14.5, 'NABA — a floating desalination city, 40 km offshore.'],
  [15.4, 21.5, 'Six intake arms draw seawater into the core, around the clock.'],
  [22.4, 29.5, 'Inside, 12,000 membrane columns turn it into fresh water —<br>powered entirely by the sun.'],
  [30.4, 34.2, 'One pipeline carries 2 million m³ ashore every day.'],
  [34.7, 38.5, 'Enough for 8 million people. And the desert begins to bloom.'],
];
const DURATION = SHOTS[SHOTS.length - 1].b;
const el = id => document.getElementById(id);
const tmpO = new THREE.Object3D();

function renderAt(t) {
  t = clamp(t, 0, DURATION - 1e-4);
  const si = SHOTS.findIndex(s => t < s.b), s = SHOTS[si], k = (t - s.a) / (s.b - s.a), L = LOOK[s.look], inHall = s.look === 'hall';

  // look
  for (const n of ['top', 'hor', 'sunCol', 'deep']) U[n].value.copy(L[n]);
  U.sunDir.value.copy(L.sunDir).normalize(); U.time.value = t;
  sun.color.copy(L.light); sun.intensity = L.li; hemi.intensity = L.hi;
  hemi.color.copy(inHall ? C(1, 1, 1) : L.top).lerp(C(1, 1, 1), 0.55); hemi.groundColor.copy(inHall ? C(0.8, 0.85, 0.9) : L.hor).multiplyScalar(0.5);
  scene.fog.color.copy(L.hor); scene.fog.density = L.fog;
  M.band.color.copy(L.band); renderer.toneMappingExposure = L.exp;
  bloom.strength = inHall ? 0.3 : 0.42;
  city.visible = ocean.visible = sky.visible = shore.visible = !inHall; hall.visible = inHall;
  scene.environmentIntensity = inHall ? 0.55 : 0.22;

  // camera
  const c = s.cam(k);
  camera.position.copy(c.p); camera.fov = s.fov; camera.updateProjectionMatrix(); camera.lookAt(c.l);
  sky.position.copy(camera.position);
  const st = c.st || V(0, 0, 0);
  sun.target.position.copy(st); sun.position.copy(st).addScaledVector(U.sunDir.value, 1300);
  sun.castShadow = !inHall;
  hallLight.intensity = inHall ? 0.5 : 0; hallLight.position.set(0, IY + 22, c.p.z + 40);

  // particles
  if (!inHall) {
    const pa = armPts.geometry.attributes.position; let i = 0;
    for (const arm of arms) for (let j = 0; j < ARM_N; j++, i++) {
      const sd = armSeed[i], u = 1 - ((sd[0] + t * 0.11) % 1), p = arm.curve.getPoint(u);
      pa.setXYZ(i, p.x + sd[1] * 5.5, p.y + sd[2] * 5.5, p.z + sd[3] * 5.5);
    }
    pa.needsUpdate = true;
    const pp = pipePts.geometry.attributes.position;
    for (let j = 0; j < 120; j++) pp.setXYZ(j, PIPE_A + ((j / 120 + t * 0.07) % 1) * (PIPE_B - PIPE_A), 19.2, 0);
    pp.needsUpdate = true;
    let b = 0;
    for (const f of fields) {
      const g = clamp((t - f.t0) / 1.7), e = t < 30 ? 1 : 1 - Math.pow(1 - g, 3);   // fields only grow during the pipeline shot
      const cg = t < 30 ? 1 : clamp((t - (f.t0 - 1.5)) / 1.5);
      f.g.scale.setScalar(Math.max(e, 0.0001)); f.g.visible = e > 0;
      f.canal.visible = cg > 0; f.canal.scale.x = Math.max(cg, 0.001);
      for (const [bx, bz, br] of f.bushes) {
        tmpO.position.set(f.x + bx * e, 8.6 + br * 0.5 * e, f.z + bz * e); tmpO.scale.setScalar(Math.max(br * e, 0.0001)); tmpO.updateMatrix(); bushes.setMatrixAt(b++, tmpO.matrix);
      }
    }
    bushes.instanceMatrix.needsUpdate = true;
  } else {
    const pb = bubPts.geometry.attributes.position;
    for (let i = 0; i < bubSeed.length; i++) {
      const sd = bubSeed[i], col = cols[Math.floor(i / BUB)], y = 3 + ((sd[0] + t * sd[3]) % 1) * 17;
      pb.setXYZ(i, col[0] + sd[1] * 0.6 + Math.sin(t * 2 + i) * 0.25, y, col[1] + sd[2] * 0.6);
    }
    pb.needsUpdate = true;
  }

  // overlays
  let cap = 0, txt = '';
  for (const [a, b, s2] of CAPS) if (t >= a && t <= b) { cap = Math.min(smooth(a, a + 0.6, t), 1 - smooth(b - 0.5, b, t)); txt = s2; }
  const ce = el('cap'); if (ce.dataset.t !== txt) { ce.innerHTML = txt; ce.dataset.t = txt; } ce.style.opacity = cap; el('grad').style.opacity = cap;
  el('title').style.opacity = smooth(40.2, 41.6, t);
  el('tag').style.opacity = 0.7 * (1 - smooth(39, 40, t));
  let fade = Math.max(1 - smooth(0, 1.2, t), smooth(DURATION - 0.9, DURATION - 0.05, t));
  for (const sh of SHOTS.slice(1)) fade = Math.max(fade, 1 - clamp(Math.abs(t - sh.a) / 0.32));
  el('fade').style.opacity = fade;

  composer.render();
}

if (new URLSearchParams(location.search).get('clean')) document.body.classList.add('clean');   // no text, for image-to-video start frames
window.renderAt = renderAt;
window.DURATION = DURATION;
window.SHOTS = SHOTS.map(s => [s.a, s.b]);
renderAt(Number(new URLSearchParams(location.search).get('t') || 3));
window.READY = true;
