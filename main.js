// =======================================================
// 基本パラメータ
// =======================================================
const matrixSize = 7;
const maxPartitionValue = 4;

const balance = {
  p_self: 0.22,
  maxDrop: 2,
  downarrow: 3,
  weightFn: (k, maxDrop) => (maxDrop + 1 - k)
};

const levelGapY = 4;
const island = { radius: 0.9, height: 1.8 };
const eyeLift = 0.25;

const cam = {
  fov: 60, near: 0.1, far: 1000,
  pitchMin: -Math.PI * 0.75,
  pitchMax:  Math.PI * 0.75
};

const FX_DURATION_MS = 300;  // すべての遷移でブラー使用

const shuffleDisplay = true;

const BASE_SYMBOLS = ['◆','▲','●','■','★','♣','♠','♦','▼','▶','⬟','⬢','⬡','✶','✷','✦','✧','✪','✱','✳'];
const symbols = (() => {
  const arr = BASE_SYMBOLS.slice(0, matrixSize);
  while (arr.length < matrixSize) arr.push(String(arr.length));
  return arr;
})();

// =======================================================
// メモリリーク対策: クリーンアップ管理
// =======================================================
const cleanup = [];
const disposables = [];

function addManagedListener(target, event, handler, options) {
  target.addEventListener(event, handler, options);
  cleanup.push(() => target.removeEventListener(event, handler, options));
}

function addDisposable(object) {
  disposables.push(object);
  return object;
}

// =======================================================
// 記号⇔列ランダム写像（固定）
// =======================================================
const symbolToCol = {}, colToSymbol = new Array(matrixSize);
{
  const perm = Array.from({ length: matrixSize }, (_, i) => i);
  for (let i = perm.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [perm[i], perm[j]] = [perm[j], perm[i]];
  }
  for (let i = 0; i < matrixSize; i++) {
    const sym = symbols[i], col = perm[i];
    symbolToCol[sym] = col;
    colToSymbol[col] = sym;
  }
}

// =======================================================
// 隣接行列（直進保証＋停滞/下降バランス）
// =======================================================
function generateAdjacencyWithBalance(size, { p_self, maxDrop, downarrow, weightFn }) {
  const A = [];
  for (let i = 0; i < size; i++) {
    const row = new Array(size).fill(0);

    if (i < size - 1) row[i + 1] = 1; // 前進保証
    const selfLoop = (i < size - 1 && Math.random() < p_self) ? 1 : 0;
    if (selfLoop) row[i] = 1;

    const K = Math.min(maxDrop, i), candidates = [];
    for (let k = 1; k <= K; k++) {
      const j = i - k, w = Math.max(0, weightFn(k, maxDrop));
      if (w > 0 && j >= 0) candidates.push({ j, w });
    }
    let slots = Math.max(0, downarrow - selfLoop);
    slots = Math.min(slots, candidates.length);
    const chosen = weightedSampleWithoutReplacement(candidates, slots);
    for (const { j } of chosen) row[j] = 1;

    A.push(row);
  }
  return A;
}
function weightedSampleWithoutReplacement(pool, m) {
  const out = [], list = pool.slice();
  for (let t = 0; t < m && list.length > 0; t++) {
    const total = list.reduce((s, it) => s + it.w, 0);
    let r = Math.random() * total, idx = 0;
    while (idx < list.length) { r -= list[idx].w; if (r <= 0) break; idx++; }
    out.push(list[idx]); list.splice(idx, 1);
  }
  return out;
}

// ===== 整数分割 → EvPartition（各ノードのレイヤ番号：1-based） =====
function integerPartitionEnumerateWithMax(n, max) {
  const partitions = [];
  (function h(rem, cur) {
    if (rem === 0) { partitions.push(cur.slice()); return; }
    for (let x = Math.min(rem, max); x >= 1; x--) {
      if (cur.length === 0 || x <= cur[cur.length - 1]) {
        cur.push(x); h(rem - x, cur); cur.pop();
      }
    }
  })(n, []);
  return partitions;
}
function getProductOfArrayElements(a){ return a.reduce((p,v)=>p*v,1); }
function buildEvPartition(size, maxPart) {
  const targetNumber = size - 2;
  const parts = integerPartitionEnumerateWithMax(targetNumber, maxPart);
  let best = [], bestProd = -1;
  for (const p of parts) {
    const prod = getProductOfArrayElements(p);
    if (prod > bestProd) { bestProd = prod; best = p; }
  }
  best.unshift(1); best.push(1);
  const ev = [];
  best.forEach((count, idx) => { for (let i = 0; i < count; i++) ev.push(idx + 1); });
  return ev;
}

// =======================================================
// three.js 初期化（ライト不要）
// =======================================================
const shell = document.getElementById('appShell');
const canvas = document.getElementById('scene');
const controlBar = document.getElementById('controlBar');

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NoToneMapping;

const scene = new THREE.Scene();
scene.background = new THREE.Color('#a9a9a9');

const camera = new THREE.PerspectiveCamera(cam.fov, 1, cam.near, cam.far);

function resize() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
addManagedListener(window, 'resize', resize);

// =======================================================
// エンジン生成
// =======================================================
const A = generateAdjacencyWithBalance(matrixSize, balance);
const EvPartition = buildEvPartition(matrixSize, maxPartitionValue);
const levelCount = Math.max(...EvPartition);
const levelToIndices = Array.from({ length: levelCount }, () => []);
for (let i = 0; i < EvPartition.length; i++) levelToIndices[EvPartition[i]-1].push(i);

// =======================================================
// 配置（円周＋レイヤ毎ランダム回転 + ジッター + リラックス）
// =======================================================
const layout = {
  r0: 8.0,
  band: 0.0,
  jitterTheta: 0.18,
  jitterR: 0.0,
  minAngleFloor: 0.28,
  minAngleBuffer: 1.00,
  relaxIters: 4
};
function urand(a,b){ return a + Math.random()*(b-a); }
function modTau(x){ const t=2*Math.PI; x%=t; return x<0?x+t:x; }
function computeRingRadius(){ return layout.r0; }

// レイヤごとのランダム回転（セッション毎に変わる）
const layerRot = Array.from({ length: levelCount }, () => Math.random() * Math.PI * 2);

function generateLayerAngles(L, count, rL){
  if (count<=0) return [];
  const rot = layerRot[L-1] || 0;

  if (count===1) {
    return [ modTau(rot + urand(-layout.jitterTheta, layout.jitterTheta)) ];
  }

  const base=[];
  for (let k=0;k<count;k++){
    base.push(modTau(2*Math.PI*(k/count) + rot + urand(-layout.jitterTheta,layout.jitterTheta)));
  }
  base.sort((a,b)=>a-b);

  const R = island.radius, thetaMinReq = Math.max(layout.minAngleFloor, (2*R/rL)*layout.minAngleBuffer);
  for (let it=0; it<layout.relaxIters; it++){
    for (let i=0;i<count;i++){
      const j=(i+1)%count, a=base[i], b=base[j];
      const gap = (j===0) ? (b+2*Math.PI-a) : (b-a);
      if (gap < thetaMinReq){
        const d=(thetaMinReq-gap)*0.5; base[i]=modTau(a-d); base[j]=modTau(b+d);
      }
    }
    base.sort((a,b)=>a-b);
  }
  return base;
}

// =======================================================
// 島（側面：openCone / 底面：片面三角）+ アウトライン
// =======================================================
const baseSideColor = new THREE.Color('#808000'); // olive
const baseCapColor  = new THREE.Color('#32cd32'); // limegreen
const bgColor       = new THREE.Color('#a9a9a9');

const sideGeo = addDisposable(new THREE.ConeGeometry(island.radius, island.height, 3, 1, true));
sideGeo.rotateX(Math.PI);

// 底面（三角形）ジオメトリ
function makeCapGeometryFromSide(sideGeo, yTarget, yOffset=-0.001){
  const pos = sideGeo.attributes.position.array;
  const raw = [];
  for (let i=0;i<pos.length;i+=3){
    const x=pos[i], y=pos[i+1], z=pos[i+2];
    if (Math.abs(y - yTarget) < 1e-6) raw.push(new THREE.Vector3(x, y+yOffset, z));
  }
  const seen=new Set(), ring=[];
  for (const v of raw){
    const ang = Math.round(Math.atan2(v.z, v.x) * 1e5)/1e5;
    if (!seen.has(ang)){ seen.add(ang); ring.push({ang, v}); }
  }
  ring.sort((a,b)=>a.ang-b.ang);
  const verts = [ring[0].v, ring[1].v, ring[2].v];

  const g = new THREE.BufferGeometry();
  const arr = new Float32Array(9);
  for (let i=0;i<3;i++){ arr[3*i]=verts[i].x; arr[3*i+1]=verts[i].y; arr[3*i+2]=verts[i].z; }
  g.setAttribute('position', new THREE.BufferAttribute(arr,3));

  g.setIndex([0,1,2]);
  g.computeVertexNormals();
  const normals = g.getAttribute('normal');
  const n0 = new THREE.Vector3(normals.getX(0), normals.getY(0), normals.getZ(0));
  if (n0.y < 0) {
    g.setIndex([0,2,1]);
    g.computeVertexNormals();
  }
  return g;
}
const capGeo = addDisposable(makeCapGeometryFromSide(sideGeo, +island.height/2));

const edgesGeo = addDisposable(new THREE.EdgesGeometry(sideGeo, 40));
const edgeMat  = addDisposable(new THREE.LineBasicMaterial({ color: 0x000000, transparent:true, opacity: 0.25 }));

// ノード生成（レベル内割当シャッフル適用）
const nodes = new Array(matrixSize);
for (let L=1; L<=levelCount; L++){
  const idxs = levelToIndices[L-1];
  const count = idxs.length;
  const rL = computeRingRadius();
  const angles = generateLayerAngles(L, count, rL);

  // レベル内のノードID割当をシャッフル
  const idxsShuffled = shuffle(idxs.slice());

  for (let k=0;k<count;k++){
    const nodeIdx = idxsShuffled[k];
    const th = angles[k];
    const x = rL*Math.cos(th), z = rL*Math.sin(th), y = (L-1)*levelGapY;

    const g = new THREE.Group();
    const sideMesh = new THREE.Mesh(sideGeo, addDisposable(new THREE.MeshBasicMaterial({ color: baseSideColor })));
    const capMesh  = new THREE.Mesh(capGeo,  addDisposable(new THREE.MeshBasicMaterial({ color: baseCapColor, side: THREE.FrontSide })));
    const outline = new THREE.LineSegments(edgesGeo, edgeMat);
    outline.visible = false;

    g.add(sideMesh, capMesh, outline);
    g.position.set(x,y,z);

    g.userData = { level: L, sideMesh, capMesh, outline };
    nodes[nodeIdx] = g;
    scene.add(g);
  }
}

// =======================================================
// Δに応じた"霧"の適用（改善版：Map使用）
// =======================================================
const materialCache = new Map();
const fogParams = {
  0: { opacity: 1.00, lerp: 0.00, transparent: false, depthWrite: true  },
  1: { opacity: 0.72, lerp: 0.22, transparent: true,  depthWrite: false },
  2: { opacity: 0.50, lerp: 0.40, transparent: true,  depthWrite: false },
  3: { opacity: 0.32, lerp: 0.60, transparent: true,  depthWrite: false }
};

function getMaterialCacheKey(kind, delta) {
  return `${kind}_${Math.min(delta, 3)}`;
}

function materialFor(kind, delta){
  const key = getMaterialCacheKey(kind, delta);
  if (materialCache.has(key)) return materialCache.get(key);
  
  const d = Math.min(delta, 3);
  const baseCol = (kind === 'side') ? baseSideColor : baseCapColor;
  const color = baseCol.clone().lerp(bgColor, fogParams[d].lerp);
  const opts = {
    color,
    transparent: fogParams[d].transparent,
    opacity: fogParams[d].opacity,
    depthWrite: fogParams[d].depthWrite
  };
  if (kind === 'cap') opts.side = THREE.FrontSide;
  const mat = addDisposable(new THREE.MeshBasicMaterial(opts));
  materialCache.set(key, mat);
  return mat;
}

function applyLayerFog(currentLevel){
  for (const g of nodes){
    const L = g.userData.level;
    const delta = Math.abs(L - currentLevel);
    const d = Math.min(delta, 3);
    g.userData.sideMesh.material = materialFor('side', d);
    g.userData.capMesh.material  = materialFor('cap',  d);
    g.userData.outline.visible = (delta === 0);
  }
}

// =======================================================
// カメラ・入出力（パフォーマンス最適化版）
// =======================================================
let currentIndex = 0;
let yaw = 0, pitch = 0;
let needsCameraUpdate = false; // カメラ更新フラグ
const RAD = Math.PI / 180;
const ORI_SMOOTH = 0.08;

const TAU = Math.PI * 2;
function normAng(x){ return ((x + Math.PI) % TAU + TAU) % TAU - Math.PI; }

// カメラ位置
function islandEyePos(i){
  const p = nodes[i].position;
  return new THREE.Vector3(p.x, p.y + island.height/2 + eyeLift, p.z);
}
function snapCameraToIndex(i){ 
  camera.position.copy(islandEyePos(i));
  needsCameraUpdate = true;
}
snapCameraToIndex(currentIndex);

// 線形補間
function clamp(v, lo, hi){ return Math.max(lo, Math.min(hi, v)); }
function lerp(a,b,t){ return a + (b - a) * t; }

// 画面回転角の取得（deg）
function getOrientationAngle(){
  if (screen.orientation && typeof screen.orientation.angle === 'number') return screen.orientation.angle;
  if (typeof window.orientation === 'number') return window.orientation;
  return 0;
}

// α/β/γ + 画面回転 → クォータニオン
const zee = new THREE.Vector3(0,0,1);
const eulerTmp = new THREE.Euler();
const q0 = new THREE.Quaternion();
const q1 = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5));
function quaternionFromDevice(alphaRad, betaRad, gammaRad, orientRad){
  const q = new THREE.Quaternion();
  eulerTmp.set(betaRad, alphaRad, -gammaRad, 'YXZ');
  q.setFromEuler(eulerTmp);
  q.multiply(q1);
  q.multiply(q0.setFromAxisAngle(zee, -orientRad));
  return q;
}

// 連続ヨー（アンラップ）とゼロ点＋オフセット
let prevYawRaw = null;
let yawUnwrapped = 0;
let yawZeroUnwrapped = null;
let yawOffset = 0;

let pitchZero = null;
let zeroStart = null, zYawAcc = 0, zPitchAcc = 0, zN = 0;

let lastPitchRaw = 0;

const permissionOverlay = document.getElementById('permissionOverlay');
const enableBtn = document.getElementById('enableSensors');

// ワールド基準の yaw/pitch を算出
const eulerOut = new THREE.Euler();
function onDeviceOrientation(e){
  const a = (e.alpha ?? 0) * RAD;
  const b = (e.beta  ?? 0) * RAD;
  const g = (e.gamma ?? 0) * RAD;
  const orientDeg = getOrientationAngle();
  const q = quaternionFromDevice(a, b, g, orientDeg * RAD);

  eulerOut.setFromQuaternion(q, 'YXZ');
  const yawRaw   = eulerOut.y;
  const pitchRaw = eulerOut.x;

  // アンラップ
  if (prevYawRaw === null) prevYawRaw = yawRaw;
  const dYaw = normAng(yawRaw - prevYawRaw);
  yawUnwrapped += dYaw;
  prevYawRaw = yawRaw;

  lastPitchRaw = pitchRaw;

  // 起動キャリブ（平均）
  if (yawZeroUnwrapped === null || pitchZero === null){
    const t = performance.now();
    if (zeroStart === null) zeroStart = t;
    zYawAcc   += yawUnwrapped;
    zPitchAcc += pitchRaw;
    zN++;
    if (t - zeroStart >= 320){
      yawZeroUnwrapped = zYawAcc / zN;
      pitchZero        = zPitchAcc / zN;
      zeroStart = null; zYawAcc = 0; zPitchAcc = 0; zN = 0;
    }
    // キャリブ中は穏やかに 0 へ
    const prevYaw = yaw, prevPitch = pitch;
    yaw   = lerp(yaw, 0, ORI_SMOOTH);
    pitch = lerp(pitch, 0, ORI_SMOOTH);
    if (prevYaw !== yaw || prevPitch !== pitch) needsCameraUpdate = true;
    return;
  }

  // 絶対方位の維持（遷移とは独立）
  const yawTarget   = (yawUnwrapped - yawZeroUnwrapped) + yawOffset;
  const pitchTarget = clamp(pitchRaw - pitchZero, cam.pitchMin, cam.pitchMax);

  const prevYaw = yaw, prevPitch = pitch;
  yaw   = lerp(yaw,   yawTarget,   ORI_SMOOTH);
  pitch = lerp(pitch, pitchTarget, ORI_SMOOTH);
  if (prevYaw !== yaw || prevPitch !== pitch) needsCameraUpdate = true;
}

// 入力セットアップ
async function startDeviceOrientation(){
  if (shell.requestFullscreen) { 
    try { await shell.requestFullscreen(); } catch(_) {} 
  }
  addManagedListener(window, 'deviceorientation', onDeviceOrientation, true);
  permissionOverlay.hidden = true;
}

async function requestPermissionIfNeeded(){
  try {
    if (typeof DeviceOrientationEvent !== 'undefined' &&
        typeof DeviceOrientationEvent.requestPermission === 'function') {
      const state = await DeviceOrientationEvent.requestPermission();
      if (state !== 'granted') {
        alert('センサー許可が必要です。「許可」を選んでください。');
        permissionOverlay.hidden = false;
        return;
      }
    }
    await startDeviceOrientation();
  } catch {
    alert('このブラウザではセンサー許可が取得できませんでした。');
    permissionOverlay.hidden = false;
  }
}

const ua = navigator.userAgent;
const isiOS = /iP(hone|ad|od)/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isSafari = /^((?!chrome|android).)*safari/i.test(ua);

function setupInput(){
  const hasDO = ('DeviceOrientationEvent' in window);
  const needsUserGesture = hasDO && (typeof DeviceOrientationEvent.requestPermission === 'function');

  if (isiOS && isSafari && hasDO && needsUserGesture){
    permissionOverlay.hidden = false;
    enableBtn?.addEventListener('click', requestPermissionIfNeeded, { once:true });
  } else if (hasDO && !needsUserGesture){
    startDeviceOrientation();
  } else {
    setupPointerControls();
  }
}

// 端末の向きが変わったら全リセット
addManagedListener(window, 'orientationchange', () => {
  prevYawRaw = null;
  yawUnwrapped = 0;
  yawZeroUnwrapped = null;
  yawOffset = 0;
  pitchZero = null;
  zeroStart = null; zYawAcc = 0; zPitchAcc = 0; zN = 0;
});

// --- フォールバック：スワイプ操作 ---
let isDragging = false;
let lastX = 0, lastY = 0;
let pointerHandlers = null;

function setupPointerControls(){
  pointerHandlers = {
    down: (e) => {
      if (isTransitioning) return;
      isDragging = true; lastX = e.clientX; lastY = e.clientY;
      canvas.setPointerCapture(e.pointerId);
    },
    move: (e) => {
      if (!isDragging || isTransitioning) return;
      const dx = e.clientX - lastX, dy = e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      const s = 0.0045; 
      yaw -= dx * s; 
      pitch = clamp(pitch - dy * s, cam.pitchMin, cam.pitchMax);
      needsCameraUpdate = true;
    },
    up: (e) => { 
      isDragging = false; 
      canvas.releasePointerCapture(e.pointerId); 
    },
    cancel: () => { 
      isDragging = false; 
    }
  };
  
  addManagedListener(canvas, 'pointerdown', pointerHandlers.down);
  addManagedListener(canvas, 'pointermove', pointerHandlers.move);
  addManagedListener(canvas, 'pointerup', pointerHandlers.up);
  addManagedListener(canvas, 'pointercancel', pointerHandlers.cancel);
}

// =======================================================
// HUD（有効ボタン + RECENTER）
// =======================================================
function makeButton(sym){
  const b=document.createElement('button'); b.type='button';
  b.dataset.sym=sym; b.textContent=sym; b.setAttribute('aria-label',`記号 ${sym}`);
  return b;
}
function makeRecenterButton(){
  const b=document.createElement('button'); b.type='button';
  b.dataset.action='recenter'; b.textContent='RECENTER';
  b.classList.add('btn-recenter');
  b.setAttribute('aria-label','視点を現在位置で再センタリング');
  return b;
}
function renderButtonsFor(i){
  const row = A[i]; controlBar.innerHTML = ''; if (!row) return;
  const syms = [];
  for (let j=0;j<row.length;j++){ if (row[j] === 1){ const s = colToSymbol[j]; if (s !== undefined) syms.push(s); } }
  const shown = shuffleDisplay ? shuffle(syms) : syms;
  for (const s of shown) controlBar.appendChild(makeButton(s));

  // 右端に RECENTER を常設
  controlBar.appendChild(makeRecenterButton());
}

function recenterNow(){
  yawZeroUnwrapped = yawUnwrapped;
  yawOffset = yaw;
  pitchZero = lastPitchRaw;
  needsCameraUpdate = true;
}

// =======================================================
// 遷移演出
// =======================================================
let isTransitioning = false;
let transitionTimeout = null;
let animationEndHandler = null;

function runBlurTransition(destIndex){
  if (isTransitioning) return; 
  isTransitioning = true;
  shell.classList.add('fx--busy');

  shell.classList.remove('fx--blur'); 
  void shell.offsetWidth;
  shell.classList.add('fx--blur');

  transitionTimeout = setTimeout(() => {
    currentIndex = destIndex;
    snapCameraToIndex(currentIndex);
    applyLayerFog(EvPartition[currentIndex]);
  }, FX_DURATION_MS/2);

  animationEndHandler = () => {
    shell.removeEventListener('animationend', animationEndHandler);
    if (transitionTimeout) {
      clearTimeout(transitionTimeout);
      transitionTimeout = null;
    }
    shell.classList.remove('fx--blur','fx--busy');
    if (EvPartition[currentIndex] === levelCount) alert("ゴールしました");
    renderButtonsFor(currentIndex);
    isTransitioning = false;
  };
  shell.addEventListener('animationend', animationEndHandler, { once:true });
}

// イベントリスナー管理
const controlBarHandler = (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;

  if (btn.dataset.action === 'recenter'){
    recenterNow();
    return;
  }

  if (isTransitioning) return;
  const sym = btn.dataset.sym;
  if (!sym) return;

  const j = symbolToCol[sym];
  runBlurTransition(j);
};
addManagedListener(controlBar, 'click', controlBarHandler);

// =======================================================
// ループ・初期化（最適化版）
// =======================================================
let animationId = null;

function updateCameraRotation(){
  if (!needsCameraUpdate) return;
  const yawForCam = normAng(yaw);
  camera.rotation.set(pitch, yawForCam, 0, 'YXZ');
  needsCameraUpdate = false;
}

function loop(){ 
  updateCameraRotation(); 
  renderer.render(scene, camera); 
  animationId = requestAnimationFrame(loop); 
}

// =======================================================
// クリーンアップ関数
// =======================================================
function dispose() {
  // アニメーションループ停止
  if (animationId) {
    cancelAnimationFrame(animationId);
    animationId = null;
  }

  // タイムアウトクリア
  if (transitionTimeout) {
    clearTimeout(transitionTimeout);
    transitionTimeout = null;
  }

  // アニメーション終了ハンドラー削除
  if (animationEndHandler) {
    shell.removeEventListener('animationend', animationEndHandler);
    animationEndHandler = null;
  }

  // イベントリスナーのクリーンアップ
  cleanup.forEach(fn => fn());
  cleanup.length = 0;

  // Three.jsリソースの解放
  nodes.forEach(node => {
    scene.remove(node);
    node.traverse(child => {
      if (child.geometry) child.geometry.dispose();
      if (child.material) {
        if (Array.isArray(child.material)) {
          child.material.forEach(m => m.dispose());
        } else {
          child.material.dispose();
        }
      }
    });
  });

  // 追加のディスポーザブル解放
  disposables.forEach(obj => {
    if (obj.dispose) obj.dispose();
  });
  disposables.length = 0;

  // マテリアルキャッシュクリア
  materialCache.clear();

  // レンダラー解放
  renderer.dispose();
}

// ページアンロード時のクリーンアップ
addManagedListener(window, 'beforeunload', dispose);

// =======================================================
// ユーティリティ
// =======================================================
function shuffleInPlace(arr){
  for (let i=arr.length-1;i>0;i--){
    const j=(Math.random()*(i+1))|0; [arr[i],arr[j]]=[arr[j],arr[i]];
  }
  return arr;
}
function shuffle(arr){ return shuffleInPlace(arr.slice()); }

// =======================================================
// 初期化実行
// =======================================================
resize();
snapCameraToIndex(currentIndex);
renderButtonsFor(currentIndex);
applyLayerFog(EvPartition[currentIndex]);
setupInput();
loop();
