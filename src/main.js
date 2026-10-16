/* ============================================================
 *  植物细胞 · 交互式 3D 课件 —— 主程序
 *  功能：3D 场景 / 拾取高亮 / 相机聚焦 / 知识点面板 /
 *        剖面 / 隔离 / 标注 / 一键导览 / 考点自测 / 截图 / 导出 GLB
 * ============================================================ */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { buildPlantCell } from './cellFactory.js';
import { ORGANELLES, CELL_TYPES, QUIZ } from './knowledge.js';

const $ = (sel) => document.querySelector(sel);
const byId = (id) => ORGANELLES.find((o) => o.id === id);

/* ============================================================
 *  1. 渲染器 / 场景 / 相机
 * ============================================================ */
const host = $('#canvas-host');
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(host.clientWidth, host.clientHeight);
renderer.toneMapping = THREE.NeutralToneMapping !== undefined ? THREE.NeutralToneMapping : THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.06;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
host.appendChild(renderer.domElement);

const labelRenderer = new CSS2DRenderer();
labelRenderer.setSize(host.clientWidth, host.clientHeight);
labelRenderer.domElement.className = 'label-layer';
host.appendChild(labelRenderer.domElement);

const scene = new THREE.Scene();

/* 背景：柔和的米色渐变（用 canvas 生成，不依赖图片） */
(function setBackground() {
  const cv = document.createElement('canvas');
  cv.width = 8; cv.height = 512;
  const ctx = cv.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, 512);
  g.addColorStop(0, '#f8f4ea');
  g.addColorStop(0.55, '#ece2d1');
  g.addColorStop(1, '#d5c8b2');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 8, 512);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  scene.background = tex;
})();

const camera = new THREE.PerspectiveCamera(38, host.clientWidth / host.clientHeight, 0.1, 200);
const HOME = { pos: new THREE.Vector3(4.15, 2.5, 5.3), target: new THREE.Vector3(0, 0, 0) };
camera.position.copy(HOME.pos);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.075;
controls.minDistance = 1.4;
controls.maxDistance = 18;
controls.rotateSpeed = 0.85;
controls.zoomSpeed = 0.8;
controls.panSpeed = 0.7;
controls.target.copy(HOME.target);
controls.update();

/* ============================================================
 *  2. 光照与环境
 * ============================================================ */
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.62;

const key = new THREE.DirectionalLight(0xfff4e2, 2.35);
key.position.set(4.5, 6.5, 5.0);
key.castShadow = true;
key.shadow.mapSize.set(1024, 1024);
key.shadow.camera.near = 1;
key.shadow.camera.far = 24;
key.shadow.camera.left = -5; key.shadow.camera.right = 5;
key.shadow.camera.top = 5;   key.shadow.camera.bottom = -5;
key.shadow.bias = -0.0006;
key.shadow.radius = 3;
scene.add(key);

const fill = new THREE.DirectionalLight(0xbcd4ff, 0.55);
fill.position.set(-6, 1.5, -3.5);
scene.add(fill);

const rim = new THREE.DirectionalLight(0xffdca8, 0.95);
rim.position.set(-2.5, -4.5, 3.5);
scene.add(rim);

scene.add(new THREE.HemisphereLight(0xffffff,0xcbbda6,0.34));

/* ============================================================
 *  3. 模型
 * ============================================================ */
const { root: cellRoot, parts } = buildPlantCell();
scene.add(cellRoot);

/* 拾取分层：solid（实体结构）优先，shell（半透明外壳）兜底 */
const RANK = { soft: 1, haze: 2, membrane: 3, wall: 4 };
const solidPick = [];
const softPick = [];
const GEOM = { meshes: 0, tris: 0 };
cellRoot.traverse((o) => {
  if (!o.isMesh) return;
  GEOM.meshes++;
  const g = o.geometry;
  if (g) {
    const n = g.index ? g.index.count : (g.attributes.position ? g.attributes.position.count : 0);
    GEOM.tris += (n / 3) * (o.isInstancedMesh ? o.count : 1);
  }
  const k = o.userData.pick;
  if (k && k !== 'solid') softPick.push(o);
  else solidPick.push(o);
});

function ownerId(obj) {
  let cur = obj;
  while (cur) {
    if (cur.userData && cur.userData.organelle) return cur.userData.organelle;
    cur = cur.parent;
  }
  return null;
}
function visibleUp(obj) {
  let cur = obj;
  while (cur) {
    if (cur.visible === false) return false;
    cur = cur.parent;
  }
  return true;
}

/* ============================================================
 *  4. 标注（CSS2D）
 * ============================================================ */
const labels = new Map();
function focusInfo(id) {
  const group = parts[id];
  if (!group) return { center: new THREE.Vector3(), radius: 1 };
  /* 多实例细胞器：聚焦离相机最近的那一个实例 */
  let target = group;
  const kids = group.children.filter((c) => c.userData && c.userData.pick === undefined && c.children.length);
  if (kids.length > 1) {
    let best = null, bestD = Infinity;
    for (const k of kids) {
      const c = new THREE.Box3().setFromObject(k).getCenter(new THREE.Vector3());
      const d = c.distanceTo(camera.position);
      if (d < bestD) { bestD = d; best = k; }
    }
    if (best) target = best;
  }
  const box = new THREE.Box3().setFromObject(target);
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const radius = THREE.MathUtils.clamp(sphere.radius, 0.22, 3.2);
  return { center: sphere.center.clone(), radius };
}
function buildLabels() {
  ORGANELLES.forEach((o) => {
    const el = document.createElement('button');
    el.className = 'tag-label';
    el.type = 'button';
    el.innerHTML = '<i style="background:' + o.color + '"></i>' + o.name;
    el.addEventListener('click', (e) => { e.stopPropagation(); select(o.id); });
    const obj = new CSS2DObject(el);
    const info = focusInfo(o.id);
    obj.position.copy(info.center.clone().add(new THREE.Vector3(0, info.radius * 0.85 + 0.06, 0)));
    obj.userData.organelle = o.id;
    cellRoot.add(obj);
    labels.set(o.id, obj);
  });
}

/* ============================================================
 *  5. 选择 / 高亮
 * ============================================================ */
let selected = null;
let isolate = false;
let labelsOn = true;
const HIGHLIGHT = new THREE.Color('#ffd66b');

function setHighlight(group, on) {
  group.traverse((o) => {
    if (!o.isMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    mats.forEach((m) => {
      if (!m || !m.emissive) return;
      if (m.userData._e === undefined) {
        m.userData._e = m.emissive.getHex();
        m.userData._i = m.emissiveIntensity !== undefined ? m.emissiveIntensity : 1;
      }
      if (on) {
        m.emissive.setHex(HIGHLIGHT.getHex());
        m.emissiveIntensity = 0.46;
      } else {
        m.emissive.setHex(m.userData._e);
        m.emissiveIntensity = m.userData._i;
      }
    });
  });
}

function applyIsolation() {
  if (present.on) return;
  ORGANELLES.forEach((o) => {
    const g = parts[o.id];
    if (!g) return;
    g.visible = !isolate || !selected || o.id === selected;
  });
}

let fly = null;

/* ============================================================
 *  结构放大观察（点击细胞器 → 脱离细胞、居中放大 → 展示知识点）
 * ============================================================ */
const present = { on: false, id: null, obj: null, home: null };
const tweens = [];

function tweenTo(obj, toPos, toScale, dur) {
  tweens.push({
    obj, t: 0, dur,
    p0: obj.position.clone(), p1: toPos.clone(),
    s0: obj.scale.clone(), s1: toScale.clone(),
  });
}
function updateTweens(dt) {
  for (let i = tweens.length - 1; i >= 0; i--) {
    const w = tweens[i];
    w.t += dt;
    const k = Math.min(1, w.t / w.dur);
    const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
    w.obj.position.lerpVectors(w.p0, w.p1, e);
    w.obj.scale.lerpVectors(w.s0, w.s1, e);
    if (k >= 1) tweens.splice(i, 1);
  }
}

/* 多实例细胞器（叶绿体×9 等）只放大离你最近的那一个；核糖体群不放大，改用相机贴近 */
function pickPresentTarget(id) {
  const group = parts[id];
  if (!group) return null;
  const kids = group.children.filter((c) => c.children && c.children.length > 0 && c.userData.pick === undefined);
  if (kids.length > 1) {
    let best = kids[0], bd = Infinity;
    for (const k of kids) {
      const c = new THREE.Box3().setFromObject(k).getCenter(new THREE.Vector3());
      const d = c.distanceTo(camera.position);
      if (d < bd) { bd = d; best = k; }
    }
    return best;
  }
  if (group.children.some((c) => c.isInstancedMesh)) return null;
  return group;
}

/* 放大观察时把"外壳"调透，露出内部结构 */
function setShellFade(obj, on) {
  obj.traverse((o) => {
    if (!o.isMesh) return;
    if (o.userData.pick === 'wall' || o.userData.pick === 'membrane' || o.userData.pick === 'haze') return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    mats.forEach((mm) => {
      if (!mm || mm.transparent !== true) return;
      if (mm.userData._op === undefined) mm.userData._op = mm.opacity;
      mm.opacity = on ? mm.userData._op * 0.42 : mm.userData._op;
    });
  });
}

function enterPresent(id) {
  if (present.on && present.id === id) return;
  if (present.on) exitPresent(true);

  const obj = pickPresentTarget(id);
  updateStageHeader(id);
  if (!obj) { flyTo(id, false); return; }          /* 核糖体等：相机贴近代替 */

  present.on = true;
  present.id = id;
  present.obj = obj;
  present.home = { pos: obj.position.clone(), scale: obj.scale.clone() };

  const box = new THREE.Box3().setFromObject(obj);
  const r = Math.max(box.getBoundingSphere(new THREE.Sphere()).radius, 0.04);
  const k = THREE.MathUtils.clamp(1.95 / r, 1.1, 12);

  ORGANELLES.forEach((o) => { const g = parts[o.id]; if (g) g.visible = o.id === id; });
  const parent = obj.parent;
  if (parent && parent !== cellRoot) {
    parent.visible = true;
    parent.children.forEach((c) => { if (c !== obj) c.visible = false; });
  }
  obj.visible = true;

  setShellFade(obj, true);
  tweenTo(obj, new THREE.Vector3(0, 0, 0), new THREE.Vector3(k, k, k), 0.85);
  fly = { cam: new THREE.Vector3(2.35, 1.75, 3.15), target: new THREE.Vector3(0, 0, 0) };
  document.body.classList.add('presenting');
  $('#present-name').textContent = byId(id).name;
  $('#present-en').textContent = byId(id).en;
}

function exitPresent(instant) {
  if (!present.on) return;
  const obj = present.obj, home = present.home, pid = present.id;
  present.on = false;
  document.body.classList.remove('presenting');
  if (obj && home) {
    setShellFade(obj, false);
    if (instant) { obj.position.copy(home.pos); obj.scale.copy(home.scale); }
    else tweenTo(obj, home.pos, home.scale, 0.7);
  }
  if (pid && parts[pid]) parts[pid].children.forEach((c) => { c.visible = true; });
  present.obj = null; present.id = null; present.home = null;
  applyIsolation();
  updateStageHeader(selected);
  fly = { cam: HOME.pos.clone(), target: HOME.target.clone() };
}

function updateStageHeader(id) {
  const o = byId(id);
  if (!o) return;
  $('#stage-title').textContent = o.name + ' ' + o.en;
  $('#stage-sub').textContent = present.on
    ? '已放大观察 · ' + o.role + ' · 点「返回细胞视图」回到整体'
    : '选择结构 → 放大聚焦 → 阅读知识点 → 剖面观察 → 考点自测';
}

function flyTo(id, instant) {
  const { center, radius } = focusInfo(id);
  const dir = camera.position.clone().sub(controls.target);
  if (dir.lengthSq() < 1e-6) dir.set(1, 0.6, 1);
  dir.normalize();
  const dist = THREE.MathUtils.clamp(radius * 4.0 + 1.6, 2.6, 13);
  const camGoal = center.clone().add(dir.multiplyScalar(dist));
  if (instant) {
    camera.position.copy(camGoal);
    controls.target.copy(center);
    fly = null;
  } else {
    fly = { cam: camGoal, target: center.clone() };
  }
}

function select(id, opts = {}) {
  const data = byId(id);
  if (!data || !parts[id]) return;
  if (selected && parts[selected]) setHighlight(parts[selected], false);
  selected = id;
  setHighlight(parts[id], true);
  applyIsolation();
  renderDetails(data);
  renderList();
  labels.forEach((obj, key) => {
    obj.element.classList.toggle('on', labelsOn || key === id);
    obj.element.classList.toggle('active', key === id);
  });
  if (!opts.noPresent) enterPresent(id);
  else updateStageHeader(id);
  if (quiz.on && !opts.silent) checkAnswer(id);
}

/* ============================================================
 *  6. 右侧知识点面板
 * ============================================================ */
function renderDetails(o) {
  const infoRows = o.info.map((r) =>
    '<div class="row' + (r.warn ? ' warn' : '') + '"><dt>' + r.k + '</dt><dd>' + r.v + (r.warn ? '<span class="warn-dot">易错</span>' : '') + '</dd></div>'
  ).join('');
  const points = o.points.map((p) => '<li>' + p + '</li>').join('');
  const exams = o.exam.map((p) => '<li>' + p + '</li>').join('');

  $('#details').innerHTML =
    '<div class="card">' +
      '<div class="card-head"><span>知识点详情</span><span class="favorite">' + '★' + '</span></div>' +
      '<div class="detail-title">' +
        '<div class="orb" style="--c:' + o.color + '"></div>' +
        '<div><h3>' + o.name + '</h3><p class="latin">' + o.en + '</p></div>' +
      '</div>' +
      '<p class="alias">「' + o.alias + '」</p>' +
      '<p class="role">' + o.role + '</p>' +
      '<dl class="info">' + infoRows + '</dl>' +
    '</div>' +
    '<div class="card">' +
      '<div class="card-head"><span>功能</span></div>' +
      '<p class="body-text">' + o.func + '</p>' +
      '<h4>要点</h4><ul class="points">' + points + '</ul>' +
    '</div>' +
    '<div class="card exam-card">' +
      '<div class="card-head"><span>考点提示</span></div>' +
      '<ul class="exam">' + exams + '</ul>' +
    '</div>' +
    '<div class="card note-card">' +
      '<div class="card-head"><span>生物笔记</span></div>' +
      '<p class="body-text">' + o.note + '</p>' +
    '</div>';
}

/* ============================================================
 *  7. 左侧列表
 * ============================================================ */
function renderCellTypes() {
  $('#cell-types').innerHTML = CELL_TYPES.map((t) =>
    '<button class="cell-type' + (t.ready ? ' active' : ' disabled') + '" data-id="' + t.id + '">' +
      '<span class="ct-dot"></span>' +
      '<span class="ct-text"><b>' + t.name + '</b><i>' + t.sub + '</i></span>' +
      '<span class="ct-en">' + t.en + '</span>' +
    '</button>'
  ).join('');
  $('#cell-types').querySelectorAll('.cell-type').forEach((b) => {
    b.addEventListener('click', () => {
      if (b.classList.contains('disabled')) { toast('其它细胞类型正在制作中，当前版本聚焦植物细胞'); return; }
    });
  });
}

function renderList() {
  $('#organelle-list').innerHTML = ORGANELLES.map((o) =>
    '<button class="org-item' + (o.id === selected ? ' active' : '') + '" data-id="' + o.id + '">' +
      '<i style="background:' + o.color + '"></i><span>' + o.name + '</span>' +
      '<em>' + o.en.split(' ')[0] + '</em>' +
    '</button>'
  ).join('');
  $('#organelle-list').querySelectorAll('.org-item').forEach((b) => {
    b.addEventListener('click', () => select(b.dataset.id));
  });
}

/* ============================================================
 *  8. 拾取交互
 * ============================================================ */
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2(-10, -10);
let hovered = null;

function pick(ev) {
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.set(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);

  const solidHits = raycaster.intersectObjects(solidPick.filter(visibleUp), false);
  if (solidHits.length) {
    const id = ownerId(solidHits[0].object);
    if (id) return id;
  }
  const softHits = raycaster.intersectObjects(softPick.filter(visibleUp), false);
  let best = null;
  for (const h of softHits) {
    const r = RANK[h.object.userData.pick] || 9;
    if (!best || r < best.r) best = { r, h };
  }
  return best ? ownerId(best.h.object) : null;
}

let down = null;
renderer.domElement.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, t: performance.now() }; });
renderer.domElement.addEventListener('pointerup', (e) => {
  if (!down) return;
  const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
  const dt = performance.now() - down.t;
  down = null;
  if (moved > 6 || dt > 600) return;            /* 拖拽/长按不算点击 */
  const id = pick(e);
  if (id) select(id);
});
renderer.domElement.addEventListener('pointermove', (e) => {
  const id = pick(e);
  hovered = id;
  renderer.domElement.style.cursor = id ? 'pointer' : 'grab';
  const hint = $('#hint');
  if (id) {
    const o = byId(id);
    hint.innerHTML = '<b>' + o.name + '</b><span>' + o.en + '</span><em>点击查看知识点</em>';
    hint.classList.add('on');
  } else {
    hint.classList.remove('on');
  }
});

/* ============================================================
 *  9. 工具栏：剖面 / 隔离 / 标注 / 导览 / 自测 / 截图 / 导出
 * ============================================================ */
const clipPlane = new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0.34);
let clipOn = true;

/* 剖面模式：把细胞壁/膜变实，形成"切开的教学插画"观感 */
function setCutaway(on) {
  cellRoot.traverse((o) => {
    if (!o.isMesh) return;
    const tag = o.userData.pick;
    if (tag !== 'wall' && tag !== 'membrane' && tag !== 'haze') return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    mats.forEach((mm) => {
      if (!mm) return;
      if (mm.userData._op2 === undefined) { mm.userData._op2 = mm.opacity; mm.userData._dw = mm.depthWrite; }
      if (on) { mm.opacity = tag === 'wall' ? 0.88 : (tag === 'membrane' ? 0.40 : 0.16); mm.depthWrite = tag === 'wall'; }
      else { mm.opacity = mm.userData._op2; mm.depthWrite = mm.userData._dw; }
      mm.needsUpdate = true;
    });
  });
}

function setClip(on) {
  clipOn = on;
  renderer.clippingPlanes = on ? [clipPlane] : [];
  $('#clip-track').classList.toggle('on', on);
  setCutaway(on);
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(toast._h);
  toast._h = setTimeout(() => t.classList.remove('on'), 2200);
}

/* 剖面滑块 */
(() => {
  const track = $('#clip-track');
  const knob = $('#clip-knob');
  let dragging = false;
  const setFromEvent = (e) => {
    const r = track.getBoundingClientRect();
    const x = THREE.MathUtils.clamp((e.clientX - r.left) / r.width, 0, 1);
    knob.style.left = (x * 100) + '%';
    clipPlane.constant = 2.45 - x * 4.9;
    setClip(true);
  };
  track.addEventListener('pointerdown', (e) => { dragging = true; track.setPointerCapture(e.pointerId); setFromEvent(e); });
  track.addEventListener('pointermove', (e) => { if (dragging) setFromEvent(e); });
  track.addEventListener('pointerup', () => { dragging = false; });
  track.addEventListener('dblclick', () => { knob.style.left = '100%'; clipPlane.constant = 2.45; setClip(false); });
})();

/* 一键导览 */
const tour = { on: false, t: 0, i: 0 };
function toggleTour(on) {
  tour.on = on;
  tour.t = 0;
  tour.i = 0;
  $('#btn-tour').classList.toggle('on', on);
  if (on) select(ORGANELLES[0].id);
}

/* 考点自测 */
const quiz = { on: false, order: [], i: 0, score: 0, answered: false };
function startQuiz() {
  quiz.on = true;
  quiz.order = QUIZ.map((_, i) => i).sort(() => Math.random() - 0.5).slice(0, 5);
  quiz.i = 0; quiz.score = 0; quiz.answered = false;
  $('#quiz').classList.add('on');
  renderQuiz();
}
function renderQuiz() {
  const q = QUIZ[quiz.order[quiz.i]];
  $('#quiz-q').textContent = q.q;
  $('#quiz-progress').textContent = '第 ' + (quiz.i + 1) + ' / ' + quiz.order.length + ' 题 · 得分 ' + quiz.score;
  $('#quiz-fb').textContent = '在 3D 模型或左侧列表里点出正确答案';
  $('#quiz-fb').className = 'quiz-fb';
  quiz.answered = false;
}
function checkAnswer(id) {
  if (quiz.answered) return;
  const q = QUIZ[quiz.order[quiz.i]];
  const fb = $('#quiz-fb');
  if (id === q.a) {
    quiz.answered = true;
    quiz.score++;
    fb.textContent = '✓ 正确！' + byId(q.a).name + ' —— ' + byId(q.a).role;
    fb.className = 'quiz-fb ok';
    setTimeout(() => {
      quiz.i++;
      if (quiz.i >= quiz.order.length) {
        $('#quiz-q').textContent = '本轮完成，得分 ' + quiz.score + ' / ' + quiz.order.length;
        $('#quiz-progress').textContent = quiz.score === quiz.order.length ? '满分，细胞结构全部掌握 🎉' : '错的地方再点开看看知识点吧';
        $('#quiz-fb').textContent = '';
      } else renderQuiz();
    }, 1500);
  } else {
    fb.textContent = '✗ 再想想：你点的是「' + byId(id).name + '」，' + byId(id).role;
    fb.className = 'quiz-fb no';
  }
}

/* 截图 / 导出 */
let pendingShot = false;
function shot() { pendingShot = true; }
function exportGLB() {
  toast('正在导出 GLB…');
  new GLTFExporter().parse(
    cellRoot,
    (result) => {
      window.__lastExport = result.byteLength || 0;
      const blob = new Blob([result], { type: 'model/gltf-binary' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'plant-cell.glb';
      a.click();
      toast('已导出 plant-cell.glb');
    },
    (err) => { console.error(err); toast('导出失败，请查看控制台'); },
    { binary: true, onlyVisible: false }
  );
}

/* 工具按钮绑定 */
$('#btn-reset').addEventListener('click', () => {
  fly = null;
  camera.position.copy(HOME.pos);
  controls.target.copy(HOME.target);
  cellRoot.rotation.set(0, 0, 0);
  toast('视角已复位');
});
$('#btn-isolate').addEventListener('click', (e) => {
  if (!selected) { toast('先选择一个细胞器'); return; }
  isolate = !isolate;
  e.currentTarget.classList.toggle('on', isolate);
  applyIsolation();
  toast(isolate ? '已隔离显示：' + byId(selected).name : '已恢复显示全部结构');
});
$('#btn-labels').addEventListener('click', (e) => {
  labelsOn = !labelsOn;
  e.currentTarget.classList.toggle('on', labelsOn);
  labels.forEach((obj, key) => obj.element.classList.toggle('on', labelsOn || key === selected));
});
$('#btn-tour').addEventListener('click', () => toggleTour(!tour.on));
$('#btn-quiz').addEventListener('click', () => (quiz.on ? ($('#quiz').classList.remove('on'), (quiz.on = false)) : startQuiz()));
$('#quiz-close').addEventListener('click', () => { $('#quiz').classList.remove('on'); quiz.on = false; });
$('#btn-present').addEventListener('click', () => { if (!selected) { toast('先选一个细胞器'); return; } enterPresent(selected); });
$('#btn-back').addEventListener('click', () => exitPresent(false));
$('#btn-shot').addEventListener('click', shot);
$('#btn-gltf').addEventListener('click', exportGLB);
$('#btn-spin').addEventListener('click', (e) => {
  controls.autoRotate = !controls.autoRotate;
  controls.autoRotateSpeed = 0.9;
  e.currentTarget.classList.toggle('on', controls.autoRotate);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { $('#quiz').classList.remove('on'); quiz.on = false; }
  if (e.key === 'r' || e.key === 'R') $('#btn-reset').click();
  if (e.key === 'l' || e.key === 'L') $('#btn-labels').click();
  if (e.key === 's' || e.key === 'S') shot();
});

/* ============================================================
 *  10. 后期处理（轻微辉光，让高亮更有质感）
 * ============================================================ */
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(host.clientWidth, host.clientHeight), 0.34, 0.75, 0.92);
composer.addPass(bloom);
composer.addPass(new OutputPass());

/* ============================================================
 *  11. 主循环
 * ============================================================ */
const clock = new THREE.Clock();
let frames = 0, fpsT = 0, fps = 0;

function updateFly(dt) {
  if (!fly) return;
  const k = 1 - Math.exp(-5.5 * dt);
  camera.position.lerp(fly.cam, k);
  controls.target.lerp(fly.target, k);
  if (camera.position.distanceTo(fly.cam) < 0.02) {
    camera.position.copy(fly.cam);
    controls.target.copy(fly.target);
    fly = null;
  }
}

let labelT = 0;
function updateLabels(dt) {
  labelT += dt;
  if (labelT < 0.12) return;
  labelT = 0;
  const camPos = camera.position;
  labels.forEach((obj, id) => {
    const part = parts[id];
    const partVisible = part ? part.visible : true;
    obj.element.classList.toggle('on', (labelsOn && partVisible) || id === selected);
    if (!obj.element.classList.contains('on')) { obj.element.style.opacity = '0'; return; }
    const info = focusInfo(id);
    obj.position.copy(info.center.clone().add(new THREE.Vector3(0, info.radius * 0.85 + 0.06, 0)));
    const d = camPos.distanceTo(info.center);
    obj.element.style.transform = 'translate(-50%,-50%)';
    obj.element.style.opacity = THREE.MathUtils.clamp((11 - d) / 4.5, 0.25, 1);
  });
}

/* ============================================================
 *  AI 模型替换通道（Tripo / 混元3D / 本地 TripoSR 生成的 GLB）
 *  用法：把 GLB 放到 models/<细胞器id>.glb，然后把下面的开关改成 true
 * ============================================================ */
const USE_AI_MODELS = false;
const AI_MODEL_IDS = ['chloroplast', 'mitochondria', 'nucleus', 'vacuole', 'golgi', 'er'];

async function upgradeWithAIModels() {
  if (!USE_AI_MODELS) return;
  const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
  const loader = new GLTFLoader();
  for (const id of AI_MODEL_IDS) {
    if (!parts[id]) continue;
    let gltf;
    try { gltf = await loader.loadAsync('./models/' + id + '.glb'); } catch (e) { continue; }
    const g = parts[id];
    const node = gltf.scene;
    /* 统一到"最长边 1"再按原细胞器大小缩放 */
    const box = new THREE.Box3().setFromObject(node);
    const size = box.getSize(new THREE.Vector3());
    const scale = 1 / Math.max(size.x, size.y, size.z);
    node.scale.setScalar(scale);
    const box2 = new THREE.Box3().setFromObject(node);
    node.position.sub(box2.getCenter(new THREE.Vector3()));
    node.traverse((o) => {
      if (!o.isMesh) return;
      o.userData.pick = 'solid';
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      mats.forEach((mm) => {
        if (!mm) return;
        if (mm.vertexColors === undefined || o.geometry.attributes.color) mm.vertexColors = true;
        mm.roughness = 0.45;
        mm.metalness = 0.0;
        mm.side = THREE.DoubleSide;
        mm.emissive = new THREE.Color(byId(id).color);
        mm.emissiveIntensity = 0.05;
      });
    });
    while (g.children.length) g.remove(g.children[0]);
    g.add(node);
    console.log('[AI model] replaced', id);
  }
  rebuildPickLists();
}

function rebuildPickLists() {
  solidPick.length = 0; softPick.length = 0;
  cellRoot.traverse((o) => {
    if (!o.isMesh) return;
    const k = o.userData.pick;
    if (k && k !== 'solid') softPick.push(o); else solidPick.push(o);
  });
}

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);
  updateFly(dt);
  updateTweens(dt);

  if (tour.on) {
    tour.t += dt;
    if (tour.t > 5.0) {
      tour.t = 0;
      tour.i = (tour.i + 1) % ORGANELLES.length;
      select(ORGANELLES[tour.i].id);
    }
  }

  /* 选中体的呼吸感 */
  if (!present.on && selected && parts[selected]) {
    const s = 1 + Math.sin(performance.now() * 0.0025) * 0.012;
    parts[selected].scale.setScalar(s);
    const glow = 0.40 + Math.sin(performance.now() * 0.0035) * 0.12;
    parts[selected].traverse((o) => {
      if (o.isMesh) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        mats.forEach((m) => { if (m && m.emissive && m.userData._e !== undefined) m.emissiveIntensity = glow; });
      }
    });
  }

  updateLabels(dt);
  controls.update();
  composer.render();
  labelRenderer.render(scene, camera);

  if (pendingShot) {
    pendingShot = false;
    try {
      const url = renderer.domElement.toDataURL('image/png');
      const a = document.createElement('a');
      a.href = url;
      a.download = 'plant-cell-' + Date.now() + '.png';
      a.click();
      toast('已保存截图');
    } catch (err) { console.error(err); toast('截图失败'); }
  }

  frames++; fpsT += dt;
  if (fpsT >= 0.5) {
    fps = Math.round(frames / fpsT);
    frames = 0; fpsT = 0;
    $('#stats').innerHTML =
      '<span>' + fps + ' FPS</span>' +
      '<span>' + GEOM.meshes + ' 个结构</span>' +
      '<span>' + (GEOM.tris / 1000).toFixed(1) + 'k 三角面</span>';
  }
}

/* ============================================================
 *  12. 启动
 * ============================================================ */
function onResize() {
  const w = host.clientWidth, h = host.clientHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  composer.setSize(w, h);
  labelRenderer.setSize(w, h);
  bloom.setSize(w, h);
}
window.addEventListener('resize', onResize);

setClip(true);
$('#clip-knob').style.left = '43%';
upgradeWithAIModels();
buildLabels();
renderCellTypes();
renderList();
select('nucleus', { noPresent: true });
animate();
setTimeout(() => $('#loading').classList.remove('on'), 350);

window.__cell = { scene, camera, controls, parts, select, focusInfo, renderer, setClip, clipPlane, exportGLB, enterPresent, exitPresent, present, labels, quiz, startQuiz };