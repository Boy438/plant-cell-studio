/* ============================================================
 *  植物细胞 3D 模型工厂（纯程序化几何，无需任何外部模型文件）
 *  —— 每个细胞器都是独立 Group，可单独拾取 / 高亮 / 隔离
 *  —— 半透明外壳（膜）不参与"实体拾取"，保证点击能穿到内部结构
 *  想换成 Tripo / 混元3D 生成的真实 GLB 模型时，只需替换对应的
 *  buildXxx() 函数并把 GLB 塞进一个 Group 即可（见 README）
 * ============================================================ */
import * as THREE from 'three';

const TAU = Math.PI * 2;

/* ---------- 固定种子的随机数：保证每次打开模型完全一致 ---------- */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------- 超椭球：植物细胞那种"圆角长方盒"形状 ---------- */
export function superEllipsoid(a, b, c, e = 0.42, segU = 88, segV = 60) {
  const geo = new THREE.SphereGeometry(1, segU, segV);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    pos.setXYZ(
      i,
      Math.sign(x) * Math.pow(Math.abs(x), e) * a,
      Math.sign(y) * Math.pow(Math.abs(y), e) * b,
      Math.sign(z) * Math.pow(Math.abs(z), e) * c
    );
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

/* ---------- 材质 ---------- */
function solid(color, o = {}) {
  return new THREE.MeshPhysicalMaterial(
    Object.assign(
      {
        color: new THREE.Color(color),
        roughness: 0.42,
        metalness: 0.0,
        clearcoat: 0.5,
        clearcoatRoughness: 0.35,
        emissive: new THREE.Color(color).multiplyScalar(0.05),
        emissiveIntensity: 1.0,
        sheen: 0.35,
        sheenRoughness: 0.65,
        sheenColor: new THREE.Color(color).lerp(new THREE.Color('#ffffff'), 0.55),
      },
      o
    )
  );
}
function shell(color, opacity, o = {}) {
  return new THREE.MeshPhysicalMaterial(
    Object.assign(
      {
        color: new THREE.Color(color),
        roughness: 0.14,
        metalness: 0.0,
        transparent: true,
        opacity,
        side: THREE.DoubleSide,
        depthWrite: false,
        clearcoat: 1.0,
        clearcoatRoughness: 0.1,
        emissive: new THREE.Color(color).multiplyScalar(0.03),
        emissiveIntensity: 1.0,
      },
      o
    )
  );
}


/* ---------- Procedural textures (no external image assets) ---------- */
export function fiberTexture() {
  const s = 512;
  const cv = document.createElement('canvas');
  cv.width = cv.height = s;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, s, s);
  const rnd = mulberry32(99123);
  for (let i = 0; i < 1100; i++) {
    const y = rnd() * s, x = rnd() * s, len = 40 + rnd() * 170;
    ctx.strokeStyle = 'rgba(118,150,84,' + (0.06 + rnd() * 0.18).toFixed(3) + ')';
    ctx.lineWidth = 0.6 + rnd() * 2.4;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.quadraticCurveTo(x + len * 0.5, y + (rnd() - 0.5) * 18, x + len, y + (rnd() - 0.5) * 12);
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(5, 5);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

export function proteinTexture() {
  const s = 512;
  const cv = document.createElement('canvas');
  cv.width = cv.height = s;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, s, s);
  const rnd = mulberry32(55117);
  for (let i = 0; i < 1500; i++) {
    const x = rnd() * s, y = rnd() * s, r = 2 + rnd() * 7;
    const g = Math.round(150 + rnd() * 55);
    ctx.fillStyle = 'rgba(' + g + ',' + Math.round(g * 0.78) + ',' + Math.round(g * 0.86) + ',' + (0.22 + rnd() * 0.5).toFixed(3) + ')';
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(3, 3);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/* ---------- Layout ---------- */
/* ---------- 布局参数（单位：细胞长约 4.7） ---------- */
export const CELL = {
  wall:     { a: 2.34, b: 1.76, c: 1.76, e: 0.42 },
  membrane: { a: 2.20, b: 1.62, c: 1.62, e: 0.42 },
  cytosol:  { a: 2.13, b: 1.55, c: 1.55, e: 0.44 },
  vacuole:  { pos: new THREE.Vector3(0.18, 0, 0), a: 1.28, b: 0.94, c: 0.94, e: 0.5 },
  nucleus:  { pos: new THREE.Vector3(-1.58, 0.1, 0.34), r: 0.45 },
};

/* 超椭球径向量：把方向向量映射到超椭球表面 */
function radialScale(d, a, b, c, n) {
  const v =
    Math.pow(Math.abs(d.x / a), n) +
    Math.pow(Math.abs(d.y / b), n) +
    Math.pow(Math.abs(d.z / c), n);
  return Math.pow(v, -1 / n);
}

/* 在"细胞质外壳"里均匀撒点：inset 越小越靠内 */
function distribute(count, rnd, opts) {
  const { a, b, c, e = 0.42, inset = 0.86, minDist = 0, reject = null, maxTries = 4000 } = opts;
  const n = 1 / e;
  const out = [];
  let tries = 0;
  while (out.length < count && tries < maxTries) {
    tries++;
    const u = rnd() * 2 - 1;
    const phi = rnd() * TAU;
    const r = Math.sqrt(Math.max(0, 1 - u * u));
    const d = new THREE.Vector3(r * Math.cos(phi), u, r * Math.sin(phi));
    const p = d.multiplyScalar(radialScale(d, a, b, c, n) * inset);
    if (reject && reject(p)) continue;
    if (minDist > 0 && out.some((q) => q.distanceTo(p) < minDist)) continue;
    out.push(p);
  }
  return out;
}

/* 判断点是否落在液泡 / 细胞核里（用椭球近似） */
function inVacuole(p, k = 1.0) {
  const v = CELL.vacuole;
  const dx = (p.x - v.pos.x) / (v.a * k);
  const dy = p.y / (v.b * k);
  const dz = p.z / (v.c * k);
  return dx * dx + dy * dy + dz * dz < 1;
}
function inNucleus(p, k = 1.0) {
  return p.distanceTo(CELL.nucleus.pos) < CELL.nucleus.r * k;
}

/* ============================================================
 *  各细胞器建模
 * ============================================================ */

/* 叶绿体：双层膜外壳 + 基粒（类囊体堆叠）+ 淀粉粒 */
function buildChloroplast(rnd) {
  const g = new THREE.Group();
  const s = 0.33 + rnd() * 0.10;

  const envelope = new THREE.Mesh(new THREE.SphereGeometry(1, 44, 30), shell('#3f9b3a', 0.56));
  envelope.scale.set(s * 1.45, s * 0.78, s * 1.00);
  envelope.renderOrder = 4;
  envelope.userData.pick = 'soft';
  g.add(envelope);

  const granaMat = solid('#14601f', { roughness: 0.38, clearcoat: 0.25 });
  const discGeo = new THREE.CylinderGeometry(0.078, 0.078, 0.011, 18);
  const granaCount = 5 + Math.floor(rnd() * 2);
  for (let i = 0; i < granaCount; i++) {
    const stack = new THREE.Group();
    const layers = 4 + Math.floor(rnd() * 4);
    for (let j = 0; j < layers; j++) {
      const d = new THREE.Mesh(discGeo, granaMat);
      d.position.y = j * 0.016;
      d.scale.setScalar(0.85 + rnd() * 0.3);
      stack.add(d);
    }
    stack.position.set(
      (rnd() - 0.5) * s * 1.1,
      (rnd() - 0.5) * s * 0.5,
      (rnd() - 0.5) * s * 0.7
    );
    stack.rotation.set((rnd() - 0.5) * 0.7, rnd() * TAU, (rnd() - 0.5) * 0.7);
    g.add(stack);
  }

  const stromaMat = solid('#a9e08c', { roughness: 0.5 });
  for (let i = 0; i < 14; i++) {
    const st = new THREE.Mesh(new THREE.SphereGeometry(0.016 + rnd() * 0.014, 10, 8), stromaMat);
    st.position.set((rnd() - 0.5) * s * 2.4, (rnd() - 0.5) * s * 1.2, (rnd() - 0.5) * s * 1.6);
    g.add(st);
  }
  const starchMat = solid('#f2ead2', { roughness: 0.55, clearcoat: 0.4 });
  for (let i = 0; i < 2; i++) {
    const st = new THREE.Mesh(new THREE.SphereGeometry(0.032 + rnd() * 0.016, 14, 10), starchMat);
    st.position.set((rnd() - 0.5) * s * 1.2, (rnd() - 0.5) * s * 0.5, (rnd() - 0.5) * s * 0.7);
    g.add(st);
  }
  return g;
}

/* 线粒体：外膜 + 内膜 + 折叠成嵴的管状结构 */
function buildMitochondrion(rnd) {
  const g = new THREE.Group();
  const R = 0.115 + rnd() * 0.05;
  const L = 0.30 + rnd() * 0.2;

  const outer = new THREE.Mesh(new THREE.CapsuleGeometry(R, L, 12, 28), shell('#e0762a', 0.52));
  outer.renderOrder = 4;
  outer.userData.pick = 'soft';
  g.add(outer);

  const inner = new THREE.Mesh(new THREE.CapsuleGeometry(R * 0.74, L * 0.94, 10, 22), shell('#f5a95f', 0.26));
  inner.renderOrder = 3;
  inner.userData.pick = 'soft';
  g.add(inner);

  /* 嵴：沿轴线来回折叠的管 */
  const pts = [];
  const N = 30;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const y = -L / 2 - R * 0.15 + t * (L + R * 0.3);
    const ang = t * Math.PI * 6.5;
    const rad = R * (0.5 + 0.16 * Math.sin(t * Math.PI));
    pts.push(new THREE.Vector3(Math.cos(ang) * rad, y, Math.sin(ang) * rad));
  }
  const cristae = new THREE.Mesh(
    new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 260, R * 0.18, 10, false),
    solid('#e05a1c', { roughness: 0.34 })
  );
  g.add(cristae);
  return g;
}

/* 细胞核：核膜 + 核孔 + 染色质 + 核仁 */
function buildNucleus(rnd) {
  const g = new THREE.Group();
  const R = CELL.nucleus.r;

  const envelope = new THREE.Mesh(new THREE.SphereGeometry(R, 56, 40), shell('#6a48d8', 0.5));
  envelope.renderOrder = 4;
  envelope.userData.pick = 'shell';
  g.add(envelope);

  const innerEnv = new THREE.Mesh(new THREE.SphereGeometry(R * 0.94, 48, 34), shell('#8b6ff0', 0.16));
  innerEnv.renderOrder = 3;
  innerEnv.userData.pick = 'shell';
  g.add(innerEnv);

  /* 染色质：几条缠绕的粗线 */
  const chromatinMat = solid('#462a9c', { roughness: 0.4 });
  for (let i = 0; i < 9; i++) {
    const pts = [];
    const k = 6 + Math.floor(rnd() * 4);
    const base = new THREE.Vector3(
      (rnd() - 0.5) * R * 0.9,
      (rnd() - 0.5) * R * 0.9,
      (rnd() - 0.5) * R * 0.9
    );
    for (let j = 0; j < k; j++) {
      pts.push(
        base
          .clone()
          .add(
            new THREE.Vector3(
              (rnd() - 0.5) * R * 0.85,
              (rnd() - 0.5) * R * 0.85,
              (rnd() - 0.5) * R * 0.85
            )
          )
      );
    }
    const tube = new THREE.Mesh(
      new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 90, R * 0.07, 8, false),
      chromatinMat
    );
    g.add(tube);
  }

  /* 核仁 */
  const nucleolus = new THREE.Mesh(new THREE.SphereGeometry(R * 0.3, 32, 24), solid('#331c6b', { roughness: 0.5 }));
  nucleolus.position.set(R * 0.28, R * 0.16, R * 0.1);
  g.add(nucleolus);

  /* 核孔：贴在核膜上的小环 */
  const poreMat = solid('#c9b6ff', { roughness: 0.3 });
  const poreGeo = new THREE.TorusGeometry(R * 0.085, R * 0.028, 8, 16);
  const up = new THREE.Vector3(0, 0, 1);
  for (let i = 0; i < 22; i++) {
    const u = (i + 0.5) / 22 * 2 - 1;
    const phi = i * 2.399963;
    const r = Math.sqrt(Math.max(0, 1 - u * u));
    const dir = new THREE.Vector3(r * Math.cos(phi), u, r * Math.sin(phi));
    const pore = new THREE.Mesh(poreGeo, poreMat);
    pore.position.copy(dir).multiplyScalar(R * 1.005);
    pore.quaternion.setFromUnitVectors(up, dir);
    g.add(pore);
  }
  return g;
}

/* 内质网：网状管道（粗面额外挂核糖体小颗粒） */
function buildER(rnd, center, rough) {
  const g = new THREE.Group();
  const mat = solid('#c173d8', { roughness: 0.45, clearcoat: 0.4, transparent: true, opacity: 0.96 });
  const riboMat = solid('#8a6f3f', { roughness: 0.5 });
  const spread = 0.34;

  const sheets = 2 + Math.floor(rnd() * 2);
  for (let s = 0; s < sheets; s++) {
    const pts = [];
    const base = new THREE.Vector3(
      (rnd() - 0.5) * spread,
      (rnd() - 0.5) * spread,
      (rnd() - 0.5) * spread
    );
    for (let j = 0; j < 7; j++) {
      pts.push(
        base
          .clone()
          .add(
            new THREE.Vector3(
              (rnd() - 0.5) * spread * 1.6,
              (rnd() - 0.5) * spread * 1.6,
              (rnd() - 0.5) * spread * 1.6
            )
          )
      );
    }
    const curve = new THREE.CatmullRomCurve3(pts);
    const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 160, 0.05, 12, false), mat);
    tube.scale.set(1, 0.42, 1);
    tube.userData.pick = 'solid';
    g.add(tube);

    if (rough) {
      const n = 26;
      for (let i = 0; i < n; i++) {
        const p = curve.getPointAt(i / (n - 1));
        const rib = new THREE.Mesh(new THREE.SphereGeometry(0.019, 8, 6), riboMat);
        rib.position.copy(p).add(
          new THREE.Vector3((rnd() - 0.5) * 0.06, (rnd() - 0.5) * 0.06, (rnd() - 0.5) * 0.06)
        );
        g.add(rib);
      }
    }
  }
  g.position.copy(center);
  return g;
}

/* 高尔基体：扁平囊泡堆叠 + 分泌小泡 */
function buildGolgi(rnd, center) {
  const g = new THREE.Group();
  const mat = solid('#d24a80', { roughness: 0.4, clearcoat: 0.5 });
  const n = 5;
  for (let i = 0; i < n; i++) {
    const k = 1 - i * 0.12;
    const cis = new THREE.Mesh(new THREE.SphereGeometry(1, 44, 24, 0, Math.PI * 2, Math.PI * 0.34, Math.PI * 0.13), mat);
    cis.scale.set(0.30 * k, 0.34 * k, 0.23 * k);
    cis.position.set((rnd() - 0.5) * 0.05, i * 0.082, (rnd() - 0.5) * 0.04);
    cis.rotation.z = (rnd() - 0.5) * 0.22;
    cis.rotation.y = (rnd() - 0.5) * 0.5;
    g.add(cis);
  }
  const vesMat = solid('#f0a3bd', { roughness: 0.35 });
  for (let i = 0; i < 7; i++) {
    const v = new THREE.Mesh(new THREE.SphereGeometry(0.034 + rnd() * 0.022, 14, 10), vesMat);
    v.position.set((rnd() - 0.5) * 0.5, -0.08 + rnd() * 0.5, (rnd() - 0.5) * 0.42);
    g.add(v);
  }
  g.position.copy(center);
  return g;
}

/* 核糖体：InstancedMesh 撒点（性能友好） */
function buildRibosomes(positions, rnd) {
  const g = new THREE.Group();
  const mat = solid('#b8903a', { roughness: 0.6, emissive: new THREE.Color('#a98c52').multiplyScalar(0.05) });
  const geo = new THREE.SphereGeometry(0.028, 10, 8);
  const inst = new THREE.InstancedMesh(geo, mat, positions.length);
  inst.userData.pick = 'solid';
  const m = new THREE.Matrix4();
  for (let i = 0; i < positions.length; i++) {
    m.makeTranslation(positions[i].x, positions[i].y, positions[i].z);
    inst.setMatrixAt(i, m);
  }
  inst.instanceMatrix.needsUpdate = true;
  g.add(inst);
  return g;
}

/* ============================================================
 *  总装
 * ============================================================ */
export function buildPlantCell() {
  const rnd = mulberry32(20261016);
  const root = new THREE.Group();
  const parts = {};

  const mkPart = (id) => {
    const g = new THREE.Group();
    g.name = id;
    g.userData.organelle = id;
    parts[id] = g;
    return g;
  };

  /* --- 细胞壁 --- */
  const wall = mkPart('wall');
  const wallTex = fiberTexture();
  const wallMesh = new THREE.Mesh(
    superEllipsoid(CELL.wall.a, CELL.wall.b, CELL.wall.c, CELL.wall.e),
    shell('#6b9c2f', 0.44, { roughness: 0.55, clearcoat: 0.3, map: wallTex })
  );
  wallMesh.userData.pick = 'wall';
  wallMesh.renderOrder = 8;
  wall.add(wallMesh);
  /* 内层：贴着细胞膜的薄膜，只留一层薄边提示“壁有厚度” */
  const wallRim = new THREE.Mesh(
    superEllipsoid(CELL.wall.a * 0.972, CELL.wall.b * 0.972, CELL.wall.c * 0.972, CELL.wall.e),
    shell('#9bc765', 0.20, { side: THREE.BackSide })
  );
  wallRim.userData.pick = 'wall';
  wallRim.renderOrder = 7;
  wall.add(wallRim);
  root.add(wall);

  /* --- 细胞膜 --- */
  const membrane = mkPart('membrane');
  const memTex = proteinTexture();
  const memMesh = new THREE.Mesh(
    superEllipsoid(CELL.membrane.a, CELL.membrane.b, CELL.membrane.c, CELL.membrane.e),
    shell('#e63c56', 0.34, { roughness: 0.1, map: memTex })
  );
  memMesh.userData.pick = 'membrane';
  memMesh.renderOrder = 6;
  membrane.add(memMesh);
  root.add(membrane);

  /* --- 细胞质基质（整体雾状体积） --- */
  const cytosol = mkPart('cytosol');
  const haze = new THREE.Mesh(superEllipsoid(CELL.cytosol.a, CELL.cytosol.b, CELL.cytosol.c, CELL.cytosol.e, 64, 44), shell('#bcdcee', 0.05));
  haze.userData.pick = 'haze';
  haze.renderOrder = 9;
  cytosol.add(haze);
  root.add(cytosol);

  /* --- 液泡 --- */
  const vacuole = mkPart('vacuole');
  const vacMesh = new THREE.Mesh(superEllipsoid(CELL.vacuole.a, CELL.vacuole.b, CELL.vacuole.c, CELL.vacuole.e, 72, 48), shell('#2fa6d8', 0.32, { roughness: 0.08 }));
  vacMesh.userData.pick = 'soft';
  vacMesh.renderOrder = 5;
  vacuole.add(vacMesh);
  const vacInner = new THREE.Mesh(superEllipsoid(CELL.vacuole.a * 0.9, CELL.vacuole.b * 0.9, CELL.vacuole.c * 0.9, CELL.vacuole.e, 56, 38), shell('#96dcf2', 0.09));
  vacInner.userData.pick = 'soft';
  vacInner.renderOrder = 4;
  vacuole.add(vacInner);
  vacuole.position.copy(CELL.vacuole.pos);
  root.add(vacuole);

  /* --- 细胞核 --- */
  const nucleus = mkPart('nucleus');
  nucleus.add(buildNucleus(rnd));
  nucleus.position.copy(CELL.nucleus.pos);
  root.add(nucleus);

  /* --- 叶绿体（8 个，分布在细胞质外壳里） --- */
  const chloroplast = mkPart('chloroplast');
  const cpPos = distribute(9, rnd, {
    a: CELL.membrane.a, b: CELL.membrane.b, c: CELL.membrane.c, e: CELL.membrane.e,
    inset: 0.83, minDist: 0.62,
    reject: (p) => inVacuole(p, 1.08) || inNucleus(p, 1.25),
  });
  cpPos.forEach((p) => {
    const cp = buildChloroplast(rnd);
    cp.position.copy(p);
    cp.lookAt(0, 0, 0);
    cp.rotateY(rnd() * TAU);
    chloroplast.add(cp);
  });
  root.add(chloroplast);

  /* --- 线粒体（6 个） --- */
  const mito = mkPart('mitochondria');
  const mtPos = distribute(6, rnd, {
    a: CELL.membrane.a, b: CELL.membrane.b, c: CELL.membrane.c, e: CELL.membrane.e,
    inset: 0.80, minDist: 0.72,
    reject: (p) => inVacuole(p, 1.06) || inNucleus(p, 1.2),
  });
  mtPos.forEach((p) => {
    const mt = buildMitochondrion(rnd);
    mt.position.copy(p);
    mt.lookAt(0, 0, 0);
    mt.rotateY(rnd() * TAU);
    mito.add(mt);
  });
  root.add(mito);

  /* --- 内质网（3 簇，其中 2 簇是粗面内质网） --- */
  const er = mkPart('er');
  const erPos = distribute(3, rnd, {
    a: CELL.membrane.a * 0.86, b: CELL.membrane.b * 0.86, c: CELL.membrane.c * 0.86,
    e: CELL.membrane.e, inset: 0.92, minDist: 0.9,
    reject: (p) => inVacuole(p, 1.02) || inNucleus(p, 1.35),
  });
  erPos.forEach((p, i) => er.add(buildER(rnd, p, i !== 2)));
  root.add(er);

  /* --- 高尔基体（2 组） --- */
  const golgi = mkPart('golgi');
  const gPos = distribute(2, rnd, {
    a: CELL.membrane.a * 0.84, b: CELL.membrane.b * 0.84, c: CELL.membrane.c * 0.84,
    e: CELL.membrane.e, inset: 0.94, minDist: 1.2,
    reject: (p) => inVacuole(p, 1.02) || inNucleus(p, 1.4),
  });
  gPos.forEach((p) => golgi.add(buildGolgi(rnd, p)));
  root.add(golgi);

  /* --- 核糖体（220 个，撒在细胞质里） --- */
  const ribosome = mkPart('ribosome');
  const ribPos = distribute(165, rnd, {
    a: CELL.cytosol.a, b: CELL.cytosol.b, c: CELL.cytosol.c, e: CELL.cytosol.e,
    inset: 0.94, maxTries: 8000,
    reject: (p) => inVacuole(p, 1.0) || inNucleus(p, 1.05),
  });
  ribosome.add(buildRibosomes(ribPos, rnd));
  root.add(ribosome);

  return { root, parts, cell: CELL };
}