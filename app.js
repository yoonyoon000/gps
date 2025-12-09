// ===================== 기본 세팅 =====================
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");

let width, height;

// 지나간 점들: { x, y, dwell }
let points = [];

// GPS 기준점 (처음 받은 위치를 기준 원점으로 사용)
let originLat = null;
let originLon = null;
let hasOrigin = false;

// 화면 중앙 기준 오프셋
let centerX = 0;
let centerY = 0;

// 시간 관리
let lastUpdateTime = performance.now();

// 성능 최적화 상수들
const R = 6371000;              // 지구 반지름 (m)
const PIXELS_PER_METER = 1.5;   // 1m당 px (조금 줄여서 덜 튀게)
const MIN_PIXEL_DIST = 10;      // 이 픽셀 이상 움직였을 때만 새 점 추가

const MAX_POINTS = 400;         // 최대 점 개수 (넘으면 오래된 건 버림)
const MAX_LINE_SEGMENTS = 350;  // 그릴 선 개수 제한
const MAX_MARKERS = 120;        // 헥사 마커도 최근 것만 그리기

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

    const dyMeters = dLat * R;                           // 북/남
    const dxMeters = dLon * R * Math.cos(originLatRad);  // 동/서

    const x = centerX + dxMeters * PIXELS_PER_METER;
    const y = centerY - dyMeters * PIXELS_PER_METER;

    return { x, y };
}


// ===================== 감정 기반 파스텔 색 =====================
// dwellSec: 그 지점에 머문/누적된 시간(초)
function getEmotionColor(dwellSec) {
    // 최대 60초 기준으로 감정 단계 나눔 (천천히 변하도록)
    const maxD = 60;
    const d = Math.min(dwellSec, maxD);
    const t = d / maxD; // 0 ~ 1

    if (t < 0.33) {
        // 안정 (Calm) - 민트/블루
        const tt = t / 0.33;
        const hue = 170 + (190 - 170) * tt;   // 170→190
        const sat = 30 + (45 - 30) * tt;      // 30→45
        const light = 88 - 8 * tt;            // 88→80
        return `hsl(${hue}, ${sat}%, ${light}%)`;
    } else if (t < 0.66) {
        // 기쁨 (Joy) - 옐로/코랄
        const tt = (t - 0.33) / 0.33;
        const hue = 55 + (30 - 55) * tt;      // 55→30
        const sat = 50 + (70 - 50) * tt;      // 50→70
        const light = 86 - 18 * tt;           // 86→68
        return `hsl(${hue}, ${sat}%, ${light}%)`;
    } else {
        // 긴장/집착 (Tension) - 라일락/핑크
        const tt = (t - 0.66) / 0.34;
        const hue = 290 + (335 - 290) * tt;   // 290→335
        const sat = 50 + (78 - 50) * tt;      // 50→78
        const light = 80 - 25 * tt;           // 80→55
        return `hsl(${hue}, ${sat}%, ${light}%)`;
    }
}


// ===================== 헥사곤 마커 (최근 것만, 라이트하게) =====================
function drawHexMarker(p) {
    const color = getEmotionColor(p.dwell);
    const maxD = 60;
    const d = Math.min(p.dwell, maxD);

    const baseR = 6;
    const r = baseR + (d / maxD) * 24; // 최대 꽤 크게

    ctx.save();
    ctx.translate(p.x, p.y);

    ctx.fillStyle = color;
    // 모바일에서 너무 과한 blur는 버벅여서 살짝만
    ctx.shadowColor = color;
    ctx.shadowBlur = 6;

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

    // 바깥 링
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.4;
    ctx.lineWidth = 1.3;
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


// ===================== GPS 기반 위치 추적 =====================
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

            const { x, y } = latLonToXY(lat, lon);

            if (points.length === 0) {
                points.push({ x, y, dwell: 0 });
                return;
            }

            const last = points[points.length - 1];
            const dx = x - last.x;
            const dy = y - last.y;
            const distPx = Math.hypot(dx, dy);

            // 어느 정도 이상 움직였을 때만 새로운 점 찍기
            if (distPx >= MIN_PIXEL_DIST) {
                points.push({ x, y, dwell: 0 });

                // 너무 많이 쌓이면 오래된 건 버리기 (성능용)
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
            maximumAge: 5000, // 5초 내 위치는 재사용
            timeout: 10000,
        }
    );
}

startGPS();


// ===================== 메인 루프: 시간 + 그리기 (경량화) =====================
function updateAndRender() {
    const now = performance.now();
    const dt = (now - lastUpdateTime) / 1000;
    lastUpdateTime = now;

    // 너무 자주 그리면 폰이 힘들어하니까, 30fps 정도로 제한
    if (dt < 1 / 40) {
        requestAnimationFrame(updateAndRender);
        return;
    }

    // 마지막 점에 머문 시간 천천히 누적 (색 변화 매우 느리게)
    if (points.length > 0) {
        points[points.length - 1].dwell += dt * 0.4; // 1초에 0.4씩
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

    // 길(선) 그리기 — 최근 일부만
    const total = points.length;
    const startIndex = Math.max(1, total - MAX_LINE_SEGMENTS);

    ctx.save();
    ctx.shadowBlur = 4; // 전체 선에 한 번만 blur 적용
    for (let i = startIndex; i < total; i++) {
        const p1 = points[i - 1];
        const p2 = points[i];
        const dwell = Math.max(p1.dwell, p2.dwell);
        const color = getEmotionColor(dwell);

        ctx.strokeStyle = color;
        ctx.lineWidth = 3.2;
        ctx.shadowColor = color;

        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.stroke();
    }
    ctx.restore();

    // 헥사 마커들 — 최근 것만
    const markerStart = Math.max(0, total - MAX_MARKERS);
    for (let i = markerStart; i < total; i++) {
        drawHexMarker(points[i]);
    }

    // 현재 위치 강조
    const last = points[points.length - 1];
    if (last) {
        ctx.save();
        ctx.strokeStyle = "rgba(255,255,255,0.85)";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(last.x, last.y, 16, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
    }

    requestAnimationFrame(updateAndRender);
}

updateAndRender();
