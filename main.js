// =======================================================
// 君の現在地 — 3D Maze Prototype（修正完全版）
// 修正内容: F-1 抽選有効化 / F-2 デスクトップフォールバック /
//           F-3 許可再試行 / F-4 RECENTER仕様確定 / F-6 各種堅牢化
// 仕様の詳細は README.md を参照
// =======================================================

// --- 依存ライブラリの読み込み確認（F-6: CDN障害時の無通知クラッシュ防止） ---
(function assertThreeLoaded(){
  if (typeof THREE !== 'undefined') return;
  const el = document.createElement('div');
  el.className = 'overlay';
  el.innerHTML =
    '<div class="overlay__inner">' +
    '<h1>読み込みエラー</h1>' +
    '<p>3Dライブラリ（three.js）の読み込みに失敗しました。<br>' +
    'ネットワーク接続を確認して、ページを再読み込みしてください。</p>' +
    '</div>';
  document.body.appendChild(el);
  throw new Error('THREE failed to load (CDN unreachable?)');
})();

// =======================================================
// 基本パラメータ
// =======================================================
const matrixSize = 7;
const maxPartitionValue = 4;

// F-1【採用仕様】下降エッジは「最大1本」を重み付き非復元抽選で選ぶ。
// 自己ループが立った場合はスロットを消費し、下降エッジなし（停滞が下降を代替）。
// weightFn: 1段下(k=1)の重み2, 2段下(k=2)の重み1 → 選択確率 2:1。
// これによりセッション毎にグラフ構造が変化する（旧 downarrow=3 では
// 候補≦2に対しスロット過剰で全選択となり、抽選が無効化されていた）。
const balance = {
  p_self: 0.22,
  maxDrop: 2,
  downarrow: 1,
  weightFn: (k, maxDrop) => (maxDrop + 1 - k)
};

const levelGapY = 4;
const island = { radius: 0.9, height: 1.8 };
const ISLAND_SEGMENTS = 3;   // 円錐の分割数（底面キャップ生成は任意のNに対応済み）
const eyeLift = 0.25;

// F-6-1: ピッチは天頂・天底で反転しないよう ±90° に制限（旧 ±135°）
const cam = {
  fov: 60, near: 0.1, far: 1000,
  pitchMin: -Math.PI / 2,
  pitchMax:  Math.PI / 2
};

const FX_DURATION_MS = 300;      // CSS の --fx-dur と同期させること
const SENSOR_PROBE_MS = 1000;    // F-2: 有効なセンサーデータを待つ猶予

// F-6-3: OSの「視差効果を減らす」設定を尊重（ブラー演出をスキップ）
const REDUCED_MOTION =
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

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
// 記号⇔列ランダム写像（セッション毎に固定）
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

    if (i < size - 1) row[i + 1] = 1; // 前進保証（ゴール到達性の担保）
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
    if (idx >= list.length) idx = list.length - 1; // F-6: 非整数重み時のFP誤差ガード
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
  // F-6-9: size<=1 の縮退ガード（現行運用は size=7 固定だが可変化に備える）
  if (size <= 1) return size === 1 ? [1] : [];
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
//  ※パラメータだけ版（上下層の角一致は保証はせず、確率を下げるのみ）
// =======================================================
const layout = {
  r0: 8.0,
  band: 0.0,            // computeRingRadius は r0 を返す（半径固定）
  jitterTheta: 0.18,    // 約10°の角度ジッター：上下層の角一致を起きにくく
  jitterR: 0.0,
  minAngleFloor: 0.28,  // 層内の最小角間隔を広げ、密集を抑制
  minAngleBuffer: 1.00, // 均し過ぎを防ぐ
  relaxIters: 4         // 近接回避の安定性UP
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
// 島の形状（側面：openCone / 底面：片面キャップ）+ アウトライン
// =======================================================
const baseSideColor = new THREE.Color('#808000'); // olive
const baseCapColor  = new THREE.Color('#32cd32'); // limegreen
const bgColor       = new THREE.Color('#a9a9a9');

const sideGeo = addDisposable(new THREE.ConeGeometry(island.radius, island.height, ISLAND_SEGMENTS, 1, true));
sideGeo.rotateX(Math.PI); // 頂点を下に（逆円錐）

// 底面キャップ：法線が上向きになるよう巻き方向を自動修正。
// F-6-8: 旧実装は3頂点固定だったが、任意の分割数Nに対応する扇形分割へ一般化。
function makeCapGeometryFromSide(srcGeo, yTarget, yOffset=-0.001){
  const pos = srcGeo.attributes.position.array;
  const raw = [];
  for (let i=0;i<pos.length;i+=3){
    const x=pos[i], y=pos[i+1], z=pos[i+2];
    if (Math.abs(y - yTarget) < 1e-6) raw.push(new THREE.Vector3(x, y+yOffset, z));
  }
  // シーム重複を角度で除去し、角度順に整列
  const seen=new Set(), ring=[];
  for (const v of raw){
    const ang = Math.round(Math.atan2(v.z, v.x) * 1e5)/1e5;
    if (!seen.has(ang)){ seen.add(ang); ring.push({ang, v}); }
  }
  ring.sort((a,b)=>a.ang-b.ang);
  const n = ring.length;
  if (n < 3) throw new Error('makeCapGeometryFromSide: リング頂点が3未満です');

  const g = new THREE.BufferGeometry();
  const arr = new Float32Array(n*3);
  ring.forEach((r,i)=>{ arr[3*i]=r.v.x; arr[3*i+1]=r.v.y; arr[3*i+2]=r.v.z; });
  g.setAttribute('position', new THREE.BufferAttribute(arr,3));

  const fan = (flip) => {
    const idx = [];
    for (let i=1;i<n-1;i++){
      if (flip) idx.push(0, i+1, i); else idx.push(0, i, i+1);
    }
    return idx;
  };
  // いったん張って法線を確認、下向きなら巻き方向を反転
  g.setIndex(fan(false));
  g.computeVertexNormals();
  const normals = g.getAttribute('normal');
  const n0 = new THREE.Vector3(normals.getX(0), normals.getY(0), normals.getZ(0));
  if (n0.y < 0) {
    g.setIndex(fan(true));
    g.computeVertexNormals();
  }
  return g;
}
const capGeo = addDisposable(makeCapGeometryFromSide(sideGeo, +island.height/2));

const edgesGeo = addDisposable(new THREE.EdgesGeometry(sideGeo, 40));
const edgeMat  = addDisposable(new THREE.LineBasicMaterial({ color: 0x000000, transparent:true, opacity: 0.25 }));

// =======================================================
// Δに応じた"霧"のマテリアル（Mapキャッシュ）
// ※ノード生成より先に定義し、生成時からキャッシュ品を使う（F-6-7: 孤児マテリアル排除）
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
  if (kind === 'cap') opts.side = THREE.FrontSide; // 裏面非表示
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
// ノード生成（レベル内割当シャッフル適用）
// =======================================================
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
    const sideMesh = new THREE.Mesh(sideGeo, materialFor('side', 0));
    const capMesh  = new THREE.Mesh(capGeo,  materialFor('cap',  0));
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
// カメラ・入出力
// （DeviceOrientation：正統変換 + 連続ヨー + RECENTER / F-2 実データ検知フォールバック）
// =======================================================
let currentIndex = 0;
let yaw = 0, pitch = 0;            // 適用中のカメラ角
let needsCameraUpdate = false;
const RAD = Math.PI / 180;
const ORI_SMOOTH = 0.08;

// F-2: 入力モード。'none' → 有効なジャイロデータ検知で 'gyro'、
// 猶予内に来なければ 'pointer'（デスクトップ等のフォールバック）。
let inputMode = 'none';
let sensorProbeTimer = null;

const TAU = Math.PI * 2;
function normAng(x){ return ((x + Math.PI) % TAU + TAU) % TAU - Math.PI; } // [-π,π)

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

// 画面回転角の取得（deg）※window.orientation は非推奨のためフォールバック扱い
function getOrientationAngle(){
  if (screen.orientation && typeof screen.orientation.angle === 'number') return screen.orientation.angle;
  if (typeof window.orientation === 'number') return window.orientation;
  return 0;
}

// α/β/γ + 画面回転 → クォータニオン
const zee = new THREE.Vector3(0,0,1);
const eulerTmp = new THREE.Euler();
const q0 = new THREE.Quaternion();
const q1 = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5)); // -PI/2 around X
function quaternionFromDevice(alphaRad, betaRad, gammaRad, orientRad){
  const q = new THREE.Quaternion();
  eulerTmp.set(betaRad, alphaRad, -gammaRad, 'YXZ'); // β, α, -γ
  q.setFromEuler(eulerTmp);
  q.multiply(q1); // device -> world
  q.multiply(q0.setFromAxisAngle(zee, -orientRad)); // screen orientation 補正
  return q;
}

// 連続ヨー（アンラップ）とゼロ点＋オフセット
let prevYawRaw = null;
let yawUnwrapped = 0;            // デバイスからの連続ヨー
let yawZeroUnwrapped = null;     // 起動キャリブのゼロ
let yawOffset = 0;               // 表示用オフセット（RECENTERで更新）

let pitchZero = null;
let zeroStart = null, zYawAcc = 0, zPitchAcc = 0, zN = 0;

let lastPitchRaw = 0;            // RECENTER用

const permissionOverlay = document.getElementById('permissionOverlay');
const permissionMsg = document.getElementById('permissionMsg');
const enableBtn = document.getElementById('enableSensors');
const goalOverlay = document.getElementById('goalOverlay');
const goalRestartBtn = document.getElementById('goalRestart');
const goalContinueBtn = document.getElementById('goalContinue');

function setPermissionMessage(text){
  if (permissionMsg) permissionMsg.textContent = text;
}

// ワールド基準の yaw/pitch を算出
const eulerOut = new THREE.Euler();
function onDeviceOrientation(e){
  if (inputMode === 'pointer') return; // フォールバック確定後は無視

  // F-2: センサー非搭載環境（デスクトップChrome等）は全nullの単発イベントを
  // 発火することがある。これを「有効データ」と誤認しない。
  if (e.alpha === null && e.beta === null && e.gamma === null) return;

  if (inputMode === 'none'){
    inputMode = 'gyro';
    if (sensorProbeTimer){ clearTimeout(sensorProbeTimer); sensorProbeTimer = null; }
  }

  const a = (e.alpha ?? 0) * RAD;
  const b = (e.beta  ?? 0) * RAD;
  const g = (e.gamma ?? 0) * RAD;
  const orientDeg = getOrientationAngle();
  const q = quaternionFromDevice(a, b, g, orientDeg * RAD);

  eulerOut.setFromQuaternion(q, 'YXZ');
  const yawRaw   = eulerOut.y;   // [-π,π] ラップ
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

  // F-2: 猶予内に有効データが来なければポインタ操作へフォールバック
  // （DeviceOrientationEvent は存在するがセンサーが無い環境 = デスクトップ等）
  sensorProbeTimer = setTimeout(() => {
    sensorProbeTimer = null;
    if (inputMode === 'none') activatePointerFallback();
  }, SENSOR_PROBE_MS);
}

async function requestPermissionIfNeeded(){
  try {
    if (typeof DeviceOrientationEvent !== 'undefined' &&
        typeof DeviceOrientationEvent.requestPermission === 'function') {
      const state = await DeviceOrientationEvent.requestPermission();
      if (state !== 'granted') {
        // F-3: リスナーは once ではないため再タップで再試行できる
        setPermissionMessage(
          '許可が得られませんでした。もう一度ボタンを押してお試しください。' +
          '改善しない場合はページを再読み込みするか、iOSの「設定 > Safari > ' +
          'モーションと画面の向きのアクセス」を確認してください。'
        );
        permissionOverlay.hidden = false;
        return;
      }
    }
    await startDeviceOrientation();
  } catch {
    setPermissionMessage(
      'センサー許可を取得できませんでした。ページを再読み込みして、' +
      'もう一度お試しください。'
    );
    permissionOverlay.hidden = false;
  }
}

function activatePointerFallback(){
  if (inputMode === 'pointer') return;
  inputMode = 'pointer';
  setupPointerControls();
}

function setupInput(){
  const hasDO = ('DeviceOrientationEvent' in window);
  const needsUserGesture = hasDO && (typeof DeviceOrientationEvent.requestPermission === 'function');

  if (needsUserGesture){
    // 許可APIの存在自体を判定に使う（UA判別より頑健）。iOS Safari 13+ 等。
    permissionOverlay.hidden = false;
    // F-3: once:true を廃止。拒否・失敗後もボタンで再試行可能。
    addManagedListener(enableBtn, 'click', requestPermissionIfNeeded);
  } else if (hasDO){
    startDeviceOrientation(); // 実データが来なければ probe がポインタへ切替（F-2）
  } else {
    activatePointerFallback();
  }
}

// 端末の向きが変わったら全リセット（再キャリブレーション）
addManagedListener(window, 'orientationchange', () => {
  if (inputMode !== 'gyro') return;
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
  if (pointerHandlers) return; // 二重登録防止
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
  b.setAttribute('aria-label','視点を初期の正面方向と水平に戻す');
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

// F-4【採用仕様】RECENTER = 「現在の端末姿勢を基準（ニュートラル）とし、
// 視線を初期の正面方向（yaw=0）と水平（pitch=0）へ戻す」。
// ジャイロ時はスムージングにより滑らかに回頭する。
// ポインタ時は直接リセット（旧実装では無機能ボタンだった）。
function recenterNow(){
  if (inputMode === 'gyro'){
    yawZeroUnwrapped = yawUnwrapped;
    yawOffset = 0;
    pitchZero = lastPitchRaw;
  } else {
    yaw = 0;
    pitch = 0;
  }
  needsCameraUpdate = true;
}

// =======================================================
// 遷移演出（すべてブラー：位置だけスナップ／向きは一切いじらない）
// F-6-2: animationend 不発時のフェイルセーフ + 目的地の取りこぼし防止
// F-6-3: prefers-reduced-motion では演出をスキップして即時適用
// =======================================================
let isTransitioning = false;
let pendingDest = null;
let midTimeout = null;
let safetyTimeout = null;
let animationEndHandler = null;

function applyDestination(){
  if (pendingDest === null) return;
  currentIndex = pendingDest;
  pendingDest = null;
  snapCameraToIndex(currentIndex);   // 位置のみ変更
  applyLayerFog(EvPartition[currentIndex]);
}

function finishTransition(){
  if (!isTransitioning) return;
  if (midTimeout)    { clearTimeout(midTimeout);    midTimeout = null; }
  if (safetyTimeout) { clearTimeout(safetyTimeout); safetyTimeout = null; }
  if (animationEndHandler) {
    shell.removeEventListener('animationend', animationEndHandler);
    animationEndHandler = null;
  }
  applyDestination(); // 未適用なら必ずここで適用（入力の取りこぼし防止）
  shell.classList.remove('fx--blur','fx--busy');
  isTransitioning = false;
  renderButtonsFor(currentIndex);
  if (EvPartition[currentIndex] === levelCount) showGoalOverlay();
}

function runBlurTransition(destIndex){
  if (isTransitioning) return;
  isTransitioning = true;
  pendingDest = destIndex;
  shell.classList.add('fx--busy');

  if (REDUCED_MOTION){
    // 演出なしの即時カット（アクセシビリティ対応）
    finishTransition();
    return;
  }

  shell.classList.remove('fx--blur');
  void shell.offsetWidth; // リフロー強制でアニメーション再始動
  shell.classList.add('fx--blur');

  midTimeout = setTimeout(() => {
    midTimeout = null;
    applyDestination(); // ブラー最大の瞬間に切替
  }, FX_DURATION_MS/2);

  animationEndHandler = () => finishTransition();
  shell.addEventListener('animationend', animationEndHandler, { once:true });

  // animationend が何らかの理由で発火しなくても復帰する
  safetyTimeout = setTimeout(finishTransition, FX_DURATION_MS + 150);
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
  runBlurTransition(j); // 常にブラー遷移
};
addManagedListener(controlBar, 'click', controlBarHandler);

// =======================================================
// ゴール処理（F-6-5: 仕様確定）
// 最上層に到達するたびにオーバーレイを表示。
// 「もう一度」= リロードにより迷路・記号対応・配置をすべて再生成。
// 「探索を続ける」= そのまま下降して探索を継続できる。
// =======================================================
function showGoalOverlay(){
  goalOverlay.hidden = false;
}
addManagedListener(goalRestartBtn, 'click', () => { location.reload(); });
addManagedListener(goalContinueBtn, 'click', () => { goalOverlay.hidden = true; });

// =======================================================
// ループ・初期化
// =======================================================
let animationId = null;

function updateCameraRotation(){
  if (!needsCameraUpdate) return;
  // 表示用にだけヨーを [-π,π) に正規化
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
// （共有ジオメトリ/マテリアルは disposables で一元管理し、多重 dispose を排除）
// =======================================================
function dispose() {
  if (animationId) {
    cancelAnimationFrame(animationId);
    animationId = null;
  }
  if (midTimeout)       { clearTimeout(midTimeout);       midTimeout = null; }
  if (safetyTimeout)    { clearTimeout(safetyTimeout);    safetyTimeout = null; }
  if (sensorProbeTimer) { clearTimeout(sensorProbeTimer); sensorProbeTimer = null; }
  if (animationEndHandler) {
    shell.removeEventListener('animationend', animationEndHandler);
    animationEndHandler = null;
  }

  cleanup.forEach(fn => fn());
  cleanup.length = 0;

  nodes.forEach(node => scene.remove(node));

  disposables.forEach(obj => { if (obj.dispose) obj.dispose(); });
  disposables.length = 0;

  materialCache.clear();
  renderer.dispose();
}

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
