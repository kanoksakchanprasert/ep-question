// ============================================================
// Crowd Grid — แสดงคนตอบถูกทั้งหมดเป็นไอคอนคน + ชื่อ แล้ว "สปอตไลต์" ไล่ไฮไลท์
// ไปเรื่อยๆ (สุ่มดูวุ่นวายเป็นเอฟเฟกต์เฉยๆ ไม่ได้เป็นตัวสุ่มจริง — server สุ่มมาแล้ว)
// ก่อนไปหยุดค้างที่คนซึ่ง server สุ่มได้จริง
//
// ใช้ร่วมกันทั้งหน้า client (index.html) และหน้า admin (admin/index.html) เพื่อให้หน้าตาเหมือนกัน
// ต้องมี element id: crowdGrid, crowdScroll, crowdCountText และ escHtml() ในหน้าที่เรียกใช้
// ============================================================
const CHASE_STEP_DELAYS = [70, 70, 80, 90, 100, 120, 140, 170, 210, 260, 320, 400, 500, 650];
const CROWD_COLUMNS = 4; // ต้องตรงกับ grid-cols-4 ที่ตั้งไว้ใน HTML ของ #crowdGrid
const CROWD_ROW_HEIGHT = 86; // ประมาณ cell height + row-gap ไว้คำนวณตำแหน่ง auto-scroll คร่าวๆ

let crowdNames = []; // ชื่อคนตอบถูกทั้งหมดที่ render เป็น grid อยู่ตอนนี้

function normNameCompare(s) { return String(s || '').trim().toUpperCase(); }

function resetCrowdGrid() {
  crowdNames = [];
  document.getElementById('crowdGrid').innerHTML = '';
  document.getElementById('crowdCountText').textContent = 'ผู้ตอบถูกทั้งหมด (0 คน)';
  document.getElementById('crowdScroll').scrollTop = 0;
}

function ensureCrowdGrid(names) {
  const grid = document.getElementById('crowdGrid');
  if (grid.childElementCount > 0) return; // สร้างแค่ครั้งแรกของรอบนี้ กันโดนรีเซ็ตสถานะ "ได้รางวัลแล้ว" ทับ
  crowdNames = names;
  document.getElementById('crowdCountText').textContent = 'ผู้ตอบถูกทั้งหมด (' + names.length + ' คน)';
  names.forEach(function(name, i) {
    const cell = document.createElement('div');
    cell.className = 'person-cell';
    cell.innerHTML =
      '<div style="position: relative;">' +
        '<div class="person-icon" id="personIcon' + i + '">' +
          '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
            '<circle cx="12" cy="8" r="3.6"></circle>' +
            '<path d="M4.5 20.2c1.2-4 4-6.2 7.5-6.2s6.3 2.2 7.5 6.2"></path>' +
          '</svg>' +
        '</div>' +
        '<div class="rank-badge hidden" id="rankBadge' + i + '"></div>' +
      '</div>' +
      '<p class="person-name" id="personName' + i + '">' + escHtml(name) + '</p>';
    grid.appendChild(cell);
  });
}

function findCrowdIndex(name) {
  return crowdNames.findIndex(function(nm) { return normNameCompare(nm) === normNameCompare(name); });
}

function scrollCrowdToIndex(index) {
  const scroller = document.getElementById('crowdScroll');
  if (!scroller) return;
  const row = Math.floor(index / CROWD_COLUMNS);
  const target = row * CROWD_ROW_HEIGHT - (scroller.clientHeight / 2) + (CROWD_ROW_HEIGHT / 2);
  scroller.scrollTop = Math.max(0, target);
}

function setHighlight(index) {
  crowdNames.forEach(function(_, i) {
    if (i === index) return;
    const icon = document.getElementById('personIcon' + i);
    if (icon && !icon.classList.contains('is-won')) icon.classList.remove('is-highlighted');
  });
  const icon = document.getElementById('personIcon' + index);
  if (icon && !icon.classList.contains('is-won')) icon.classList.add('is-highlighted');
  scrollCrowdToIndex(index);
}

// animate=false ใช้ตอนกู้สถานะผู้ชนะเดิมกลับมาแสดง (ไม่ต้องเด้ง)
function markWon(index, rank, animate) {
  const icon = document.getElementById('personIcon' + index);
  const badge = document.getElementById('rankBadge' + index);
  const nameEl = document.getElementById('personName' + index);
  if (icon) {
    icon.classList.remove('is-highlighted');
    icon.classList.add('is-won');
    if (animate !== false) icon.classList.add('won-pop');
  }
  if (badge) {
    badge.textContent = rank;
    badge.classList.remove('hidden');
  }
  if (nameEl) nameEl.classList.add('is-won-name');
}

// วางสถานะ "ได้รางวัลแล้ว" ของผู้ชนะทุกคนที่มีอยู่ลงบน grid (ไม่มีแอนิเมชัน)
function markAllWon(winners) {
  winners.forEach(function(name, i) {
    const idx = findCrowdIndex(name);
    if (idx !== -1) markWon(idx, i + 1, false);
  });
}

// ไล่ไฮไลท์สุ่มๆ ในหมู่คนที่ยังไม่ได้รางวัล แล้วไปหยุดที่ targetIndex จากนั้นเรียก onLanded
function runCrowdChase(targetIndex, wonNames, onLanded) {
  const alreadyWonNormalized = wonNames.map(function(nm) { return normNameCompare(nm); });
  const eligible = crowdNames
    .map(function(_, i) { return i; })
    .filter(function(i) { return alreadyWonNormalized.indexOf(normNameCompare(crowdNames[i])) === -1; });
  if (eligible.length === 0) eligible.push(targetIndex);

  let step = 0;
  function runStep() {
    const isLastStep = step >= CHASE_STEP_DELAYS.length - 1;
    const idx = isLastStep ? targetIndex : eligible[Math.floor(Math.random() * eligible.length)];
    setHighlight(idx);

    const delay = CHASE_STEP_DELAYS[step];
    if (!isLastStep) {
      step++;
      setTimeout(runStep, delay);
      return;
    }
    setTimeout(onLanded, delay);
  }
  runStep();
}
