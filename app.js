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

// 화면 중앙 기준 오프셋 (좌표를 가운데에 배치)
let centerX = 0;
let centerY = 0;

// 시간 관리
let lastUpdateTime = performance.now();

// 캔버스 리사이즈
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

// 근사적인 거리 계산을 위한 값
const R = 6371000;              // 지구 반지름 (m)
const PIXELS_PER_METER = 2;     // 1m를 화면에서 몇 px로 볼지 (맵 스케일)
const MIN_PIXEL_DIST = 12;      // 이 픽셀 이상 움직였을 때만 새 점 추가

function latLonToXY(lat, lon) {
    if (!hasOrigin || originLat === null || originLon === null) {
        // 처음 호출될 때 기준점 설정
        originLat = lat;
        originLon = lon;
        hasOrigin = true;
    }

    const latRad = (lat * Math.PI) / 180;
    const originLatRad = (originLat * Math.PI) / 180;

    const dLat = ((lat - originLat) * Math.PI) / 180;
    const dLon = ((lon - originLon) * Math.PI) / 180;

    // 근사적인 거리 (m)
    const dyMeters = dLat * R;                           // 위도 차이 → 북/남
    const dxMeters = dLon * R * Math.cos(originLatRad);  // 경도 차이 → 동/서

    // 화면 좌표로 변환 (중앙 기준)
    const x = centerX + dxMeters * PIXELS_PER_METER;
    const y = centerY - dyMeters * PIXELS_PER_METER;

    return { x, y };
}


// ===================== 감정 기반 파스텔 색 =====================
// dwellSec: 그 지점에 머문/누적된 시간(초)
function getEmotionColor(dwellSec) {
    const maxD = 60;             // 60초 이상은 색이 더 안 변하고 포화
    const d = Math.min(dwellSec, maxD);
    const t = d / maxD;          // 0 ~ 1

    if (t < 0.33) {
        // 안정 (Calm) - 민트/블루 계열
        const tt = t / 0.33; // 0~1
        const hue = 170 + (190 - 170) * tt;   // 170→190 (민트→블루)
        const sat = 30 + (45 - 30) * tt;      // 30→45
        const light = 88 - (8 * tt);          // 88→80
        return `hsl(${hue}, ${sat}%, ${light}%)`;
    } else if (t < 0.66) {
        // 기쁨 (Joy) - 옐로/코랄 계열
        const tt = (t - 0.33) / 0.33;         // 0~1
        const hue = 55 + (30 - 55) * tt;      // 55→30 (라이트 옐로→코랄)
        const sat = 50 + (70 - 50) * tt;      // 50→70
        const light = 86 - (18 * tt);         // 86→68
        return `hsl(${hue}, ${sat}%, ${light}%)`;
    } else {
        // 긴장/집착 (Tension) - 라일락/핑크 계열
        const tt = (t - 0.66) / 0.34;         // 0~1
        const hue = 290 + (335 - 290) * tt;   // 290→335 (보라→핑크레드)
        const sat = 50 + (78 - 50) * tt;      // 50→78
        const light = 80 - (25 * tt);         // 80→55
        return `hsl(${hue}, ${sat}%, ${light}%)`;
    }
}


// ===================== 헥사곤 마커 =====================
function drawHexMarker(p) {
    const color = getEmotionColor(p.dwell);
    const maxD = 60;
    const d = Math.min(p.dwell, maxD);

    // 기본 크기 + 감정이 쌓일수록 커짐
    const baseR = 6;
    const r = baseR + (d / maxD) * 26; // 최대 약 baseR + 26

    ctx.save();
    ctx.translate(p.x, p.y);

    // 안쪽 헥사곤
    ctx.fillStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = 12;

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
    ctx.globalAlpha = 0.45;
    ctx.lineWidth = 1.6;
    const outerR = r + 5;
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
                // 첫 위치
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


// ===================== 메인 루프: 시간 + 그리기 =====================
function updateAndRender() {
    const now = performance.now();
    const dt = (now - lastUpdateTime) / 1000; // 초 단위
    lastUpdateTime = now;

    // 마지막 점에 머문 시간(초) 천천히 누적
    if (points.length > 0) {
        points[points.length - 1].dwell += dt;
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

    // 길(선) 그리기
    for (let i = 1; i < points.length; i++) {
        const p1 = points[i - 1];
        const p2 = points[i];
        const dwell = Math.max(p1.dwell, p2.dwell);
        const color = getEmotionColor(dwell);

        ctx.save();
        ctx.strokeStyle = color;
        ctx.lineWidth = 4;
        ctx.setLineDash([]);
        ctx.shadowColor = color;
        ctx.shadowBlur = 10;

        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.stroke();
        ctx.restore();
    }

    // 헥사 마커들
    for (const p of points) {
        drawHexMarker(p);
    }

    // 현재 마지막 점 강조 (있을 경우)
    const last = points[points.length - 1];
    if (last) {
        ctx.save();
        ctx.strokeStyle = "rgba(255,255,255,0.85)";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(last.x, last.y, 18, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
    }

    requestAnimationFrame(updateAndRender);
}

updateAndRender();
