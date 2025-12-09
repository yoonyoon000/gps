// ===================== 기본 세팅 =====================
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");

let width, height;

// GPS에서 받아온 "세계 좌표" 점들: { x, y, dwell }
let points = [];

// GPS 기준점
let originLat = null;
let originLon = null;
let hasOrigin = false;

// 화면 중앙
let centerX = 0;
let centerY = 0;

// 스무딩용 위치
let smoothedX = null;
let smoothedY = null;

// 시간 관리
let lastUpdateTime = performance.now();

// ===== 성능 & 스무딩 상수 =====
const R = 6371000;            // 지구 반지름 (m)
const PIXELS_PER_METER = 1.1; // 1m당 px (너무 퍼지지 않게)
const MIN_PIXEL_DIST = 16;    // 이 픽셀 이상 움직였을 때만 점 추가
const MAX_STEP_PX = 120;      // 이 이상 갑자기 튀면 GPS 잡음으로 보고 무시

const MAX_POINTS = 260;       // 최대 점 개수 (오래된 건 버림)
const MAX_LINE_SEGMENTS = 220;
const MAX_MARKERS = 80;

const SMOOTH_ALPHA = 0.25;    // GPS 스무딩 정도 (0~1, 클수록 덜 부드러움)

function resize() {
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = width;
    canvas.height = height;

    centerX = width / 2;
    centerY = height / 2;
}
window.addEventListener("resize", resize);
resize();


// ===================== 위도/경도 → 화면 좌표 변환 =====================
function latLonToXY(lat, lon) {
    if (!hasOrigin || originLat === null || originLon === null) {
        originLat = lat;
        originLon = lon;
        hasOrigin = true;
    }

    const latRad = (lat * Math.PI) / 180;
    const originLatRad = (originLat * Math.PI) / 180;

    const dLat = ((lat - originLat) * Math.PI) / 180;
    const dLon = ((lon - originLon) * Math.PI) / 180;

    const dyMeters = dLat * R;                           // 위/아래
    const dxMeters = dLon * R * Math.cos(originLatRad);  // 좌/우

    // 일단 "세계 좌표계" 상 위치
    const x = centerX + dxMeters * PIXELS_PER_METER;
    const y = centerY - dyMeters * PIXELS_PER_METER;

    return { x, y };
}


// ===================== 감정 기반 파스텔 색 =====================
function getEmotionColor(dwellSec) {
    const maxD = 60;                 // 60초 기준으로 감정 포화
    const d = Math.min(dwellSec, maxD);
    const t = d / maxD;              // 0 ~ 1

    if (t < 0.33) {
        // 안정 (Calm) - 민트/블루 계열
        const tt = t / 0.33;
        const hue = 170 + (190 - 170) * tt;
        const sat = 30 + (45 - 30) * tt;
        const light = 88 - 8 * tt;
        return `hsl(${hue}, ${sat}%, ${light}%)`;
    } else if (t < 0.66) {
        // 기쁨 (Joy) - 옐로/코랄
        const tt = (t - 0.33) / 0.33;
        const hue = 55 + (30 - 55) * tt;   // 55→30
        const sat = 50 + (70 - 50) * tt;
        const light = 86 - 18 * tt;
        return `hsl(${hue}, ${sat}%, ${light}%)`;
    } else {
        // 긴장/집착 (Tension) - 라일락/핑크
        const tt = (t - 0.66) / 0.34;
        const hue = 290 + (335 - 290) * tt; // 290→335
        const sat = 50 + (78 - 50) * tt;
        const light = 80 - 25 * tt;
        return `hsl(${hue}, ${sat}%, ${light}%)`;
    }
}


// ===================== 헥사곤 마커 =====================
function drawHexMarkerLocal(px, py, dwell) {
    const color = getEmotionColor(dwell);
    const maxD = 60;
    const d = Math.min(dwell, maxD);

    const baseR = 6;
    const r = baseR + (d / maxD) * 24;

    ctx.save();
    ctx.translate(px, py);

    ctx.fillStyle = color;

    const sides = 6;
    ctx.beginPath();
    for (let i = 0; i < sides; i++) {
        const a = (Math.PI * 2 * i) / sides + Math.PI / 6;
        const x = Math.cos(a) * r;
        const y = Math.sin(a) * r;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.4;
    ctx.lineWidth = 1.2;
    const outerR = r + 4;
    ctx.beginPath();
    for (let i = 0; i < sides; i++) {
        const a = (Math.PI * 2 * i) / sides + Math.PI / 6;
        const x = Math.cos(a) * outerR;
        const y = Math.sin(a) * outerR;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.stroke();

    ctx.restore();
}


// ===================== GPS 기반 위치 추적 (스무딩 + 튐 필터) =====================
let watchId = null;

function startGPS() {
    if (!navigator.geolocation) {
        alert("이 기기는 GPS(위치 정보)를 지원하지 않습니다.");
        return;
    }

    watchId = navigator.geolocation.watchPosition(
        (pos) => {
            const lat = pos.coords.latitude;
            const lon = pos.coords.longitude;

            const raw = latLonToXY(lat, lon);

            // 스무딩 적용
            if (smoothedX == null || smoothedY == null) {
                smoothedX = raw.x;
                smoothedY = raw.y;
            } else {
                smoothedX = smoothedX * (1 - SMOOTH_ALPHA) + raw.x * SMOOTH_ALPHA;
                smoothedY = smoothedY * (1 - SMOOTH_ALPHA) + raw.y * SMOOTH_ALPHA;
            }

            const x = smoothedX;
            const y = smoothedY;

            if (points.length === 0) {
                points.push({ x, y, dwell: 0 });
                return;
            }

            const last = points[points.length - 1];
            const dx = x - last.x;
            const dy = y - last.y;
            const distPx = Math.hypot(dx, dy);

            // 갑자기 멀리 튀면 무시 (GPS 잡음)
            if (distPx > MAX_STEP_PX) {
                return;
            }

            // 어느 정도 이상 움직였을 때만 점 추가
            if (distPx >= MIN_PIXEL_DIST) {
                points.push({ x, y, dwell: 0 });

                // 너무 많이 쌓이면 오래된 점 제거
                if (points.length > MAX_POINTS) {
                    const overflow = points.length - MAX_POINTS;
                    points.splice(0, overflow);
                }
            }
        },
        (err) => {
            console.error("GPS 에러:", err);
            alert("위치 정보를 가져올 수 없습니다. 브라우저 권한을 확인해주세요.");
        },
        {
            enableHighAccuracy: true,
            maximumAge: 5000,
            timeout: 10000,
        }
    );
}

startGPS();


// ===================== 메인 루프: 시간 + 회전 렌더링 =====================
function updateAndRender() {
    const now = performance.now();
    const dt = (now - lastUpdateTime) / 1000;
    lastUpdateTime = now;

    // 마지막 점 dwell 누적 (색 변화 아주 천천히)
    if (points.length > 0) {
        points[points.length - 1].dwell += dt * 0.4;
    }

    // 배경
    ctx.clearRect(0, 0, width, height);
    const gradient = ctx.createRadialGradient(
        width / 2,
        height / 2,
        0,
        width / 2,
        height / 2,
        Math.max(width, height)
    );
    gradient.addColorStop(0, "#050509");
    gradient.addColorStop(1, "#020203");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);

    const total = points.length;
    if (total === 0) {
        requestAnimationFrame(updateAndRender);
        return;
    }

    const last = points[total - 1];
    // 방향 벡터 (마지막 두 점 기준)
    let angle = -Math.PI / 2; // 기본은 위쪽
    if (total >= 2) {
        const prev = points[total - 2];
        const dx = last.x - prev.x;
        const dy = last.y - prev.y;
        if (Math.hypot(dx, dy) > 0.001) {
            const theta = Math.atan2(dy, dx);
            // theta: 0 = 오른쪽, pi/2 = 아래, -pi/2 = 위
            // 우리는 "이동 방향이 화면 위쪽(−π/2)"이 되도록 회전
            angle = -Math.PI / 2 - theta;
        }
    }

    // === 여기부터 회전 좌표계 (플레이어가 항상 위쪽을 향하도록 회전) ===
    ctx.save();
    ctx.translate(width / 2, height / 2); // 화면 중앙을 원점으로
    ctx.rotate(angle);                    // 전체 지도 회전
    // 이 상태에서 last 지점이 (0,0)이 되도록 좌표 보정해서 그림

    const startIndex = Math.max(1, total - MAX_LINE_SEGMENTS);

    // 길(선) 그리기 – 오래된 건 투명, 최근일수록 진하게
    for (let i = startIndex; i < total; i++) {
        const p1 = points[i - 1];
        const p2 = points[i];

        const dwell = Math.max(p1.dwell, p2.dwell);
        const color = getEmotionColor(dwell);

        const t = (i - startIndex) / (total - startIndex || 1);
        const alpha = 0.18 + 0.82 * t;

        const x1 = p1.x - last.x;
        const y1 = p1.y - last.y;
        const x2 = p2.x - last.x;
        const y2 = p2.y - last.y;

        ctx.save();
        ctx.strokeStyle = color;
        ctx.globalAlpha = alpha;
        ctx.lineWidth = 3;

        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
        ctx.restore();
    }

    // 헥사 마커 – 최근 일부만
    const markerStart = Math.max(0, total - MAX_MARKERS);
    for (let i = markerStart; i < total; i++) {
        const p = points[i];
        const localX = p.x - last.x;
        const localY = p.y - last.y;
        drawHexMarkerLocal(localX, localY, p.dwell);
    }

    // 플레이어 (현재 위치) – 항상 위쪽 보고 있는 느낌
    ctx.save();
    // 현재 위치는 회전 좌표계에서 (0,0)
    // 헤드 삼각형: 항상 위쪽을 향하도록 그리기
    const headLen = 24;
    const wing = 8;

    ctx.fillStyle = "rgba(255,255,255,0.95)";
    ctx.beginPath();
    ctx.moveTo(0, -headLen);        // 위쪽
    ctx.lineTo(-wing, 4);
    ctx.lineTo(wing, 4);
    ctx.closePath();
    ctx.fill();

    // 현재 위치 링
    ctx.strokeStyle = "rgba(255,255,255,0.7)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(0, 0, 16, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    ctx.restore(); // 회전 좌표계 끝

    requestAnimationFrame(updateAndRender);
}

updateAndRender();
