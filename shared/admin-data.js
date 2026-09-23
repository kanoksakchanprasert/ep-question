// ============================================================
// admin-data.js — Firestore operations สำหรับหน้าแอดมินเท่านั้น
// พอร์ตจาก gas-admin/Code.gs ทุก action
//
// Requires: firebase-init.js + data.js โหลดมาก่อนแล้ว (globals: db, auth, EPData)
// ============================================================

const EPAdmin = (function () {
  'use strict';

  const STATE     = db.collection('state');
  const RESPONSES = db.collection('responses');
  const WINNERS   = db.collection('winners');
  const HISTORY   = db.collection('history');

  // Firebase Auth ต้องใช้ email — หน้า login ยังให้กรอกแค่ username เหมือนเดิม แล้วแปะโดเมน
  // ปลอมนี้ต่อท้ายก่อนยิงจริง แอดมินไม่ต้องรู้เรื่อง email เลย
  const ADMIN_EMAIL_DOMAIN = '@ep-gvg.local';

  function toEmail(user) {
    return String(user || '').trim() + ADMIN_EMAIL_DOMAIN;
  }

  // ============================================================
  // Login
  // ============================================================
  async function signIn(user, pass) {
    try {
      await auth.signInWithEmailAndPassword(toEmail(user), pass);
      return { ok: true };
    } catch (err) {
      return { ok: false, message: 'Username หรือ Password ไม่ถูกต้อง' };
    }
  }

  function signOut() {
    return auth.signOut();
  }

  function onAuthChange(cb) {
    return auth.onAuthStateChanged(cb);
  }

  // ============================================================
  // อ่าน config เต็ม (รวม correctAnswer) — เฉพาะแอดมิน
  // ============================================================
  async function getAdminConfig() {
    const configSnap = await STATE.doc('config').get();
    const config = configSnap.exists ? configSnap.data() : { status: 'NoData' };
    let correctAnswer = '';
    try {
      const secureSnap = await STATE.doc('secureAnswer').get();
      if (secureSnap.exists) correctAnswer = secureSnap.data().correctAnswer || '';
    } catch (e) { /* ยังไม่เคยเปิดกิจกรรมเลย — ไม่มี secureAnswer */ }
    return Object.assign({ status: 'NoData' }, config, { correctAnswer: correctAnswer });
  }

  async function getSecureCorrectAnswer() {
    try {
      const secureSnap = await STATE.doc('secureAnswer').get();
      return secureSnap.exists ? (secureSnap.data().correctAnswer || '') : '';
    } catch (e) {
      return '';
    }
  }

  // ============================================================
  // Helper — ลบทั้ง collection เป็น batch ละ ≤500 doc (ข้อจำกัดของ Firestore batch write)
  // ============================================================
  async function deleteCollection(ref) {
    for (;;) {
      const snap = await ref.limit(400).get();
      if (snap.empty) return;
      const batch = db.batch();
      snap.forEach(function (doc) { batch.delete(doc.ref); });
      await batch.commit();
      if (snap.size < 400) return;
    }
  }

  // ============================================================
  // Helper — บันทึกสำรองข้อมูลรอบก่อนหน้าลง history/{roundId} (+ subcollection responses)
  // พอร์ตจาก gas-admin/Code.gs archiveCurrentRound
  // ============================================================
  async function archiveRound() {
    const configSnap = await STATE.doc('config').get();
    const config = configSnap.exists ? configSnap.data() : null;
    if (!config || config.status === 'NoData' || !config.question) {
      return; // ไม่มีรอบที่เปิดอยู่ ไม่ต้องสำรอง
    }

    const respSnap = await RESPONSES.get();
    const winSnap = await WINNERS.orderBy('rank').get();
    if (respSnap.empty && winSnap.empty) {
      return; // ไม่มีข้อมูลในรอบเก่า ไม่ต้องสำรอง
    }

    const correctAnswer = await getSecureCorrectAnswer();
    const correctUpper = String(correctAnswer || '').trim().toUpperCase();

    // นับ TotalParticipants/TotalCorrect แบบตัดชื่อซ้ำ — ในเวอร์ชันนี้แทบไม่มีทางเกิดซ้ำแล้ว
    // (doc ID กันซ้ำตั้งแต่ตอนส่ง) แต่ยังคงตรรกะเดิมไว้เผื่อข้อมูลเก่าก่อนเปลี่ยน rule
    const uniqueParticipants = {};
    const seenCorrect = {};
    let correctCount = 0;
    const rows = [];
    respSnap.forEach(function (doc) {
      const d = doc.data();
      const key = EPData.normalizeIgn(d.ign);
      uniqueParticipants[key] = true;
      const isCorrect = String(d.answer || '').trim().toUpperCase() === correctUpper;
      if (isCorrect && !seenCorrect[key]) {
        seenCorrect[key] = true;
        correctCount++;
      }
      rows.push({ ign: d.ign, answer: d.answer, submittedAt: d.submittedAt || null, isCorrect: isCorrect });
    });

    const winnersList = [];
    winSnap.forEach(function (doc) { winnersList.push(doc.data().ign); });

    const roundId = String(Date.now());
    const roundTimestamp = new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' });
    const optionsSummary = 'A: ' + (config.optionA || '-') + ' | B: ' + (config.optionB || '-') +
      ' | C: ' + (config.optionC || '-') + ' | D: ' + (config.optionD || '-');

    await HISTORY.doc(roundId).set({
      roundTimestamp: roundTimestamp,
      question: config.question,
      optionsSummary: optionsSummary,
      correctAnswer: correctAnswer,
      prizeCount: config.prizeCount || 1,
      totalParticipants: Object.keys(uniqueParticipants).length,
      totalCorrect: correctCount,
      winners: winnersList
    });

    // สำรองแถวดิบทุกคำตอบลง history/{roundId}/responses แบ่ง batch ละ ≤500
    const archiveResponsesRef = HISTORY.doc(roundId).collection('responses');
    for (let i = 0; i < rows.length; i += 400) {
      const batch = db.batch();
      rows.slice(i, i + 400).forEach(function (row) {
        batch.set(archiveResponsesRef.doc(), row);
      });
      await batch.commit();
    }
  }

  // ============================================================
  // บันทึกคำถาม + ตั้งค่า (เปิดกิจกรรมรอบใหม่)
  // ============================================================
  async function saveConfig(data) {
    await archiveRound();

    const batch = db.batch();
    batch.set(STATE.doc('config'), {
      question:   data.question,
      optionA:    data.optionA,
      optionB:    data.optionB,
      optionC:    data.optionC,
      optionD:    data.optionD,
      prizeCount: parseInt(data.prizeCount) || 1,
      endTime:    data.endTime,
      status:     'Open'
    });
    batch.set(STATE.doc('secureAnswer'), { correctAnswer: data.correctAnswer });
    batch.delete(STATE.doc('reveal'));
    await batch.commit();

    // ล้าง Responses/Winners ของรอบเก่า (สำรองลง history แล้วข้างบน)
    await deleteCollection(RESPONSES);
    await deleteCollection(WINNERS);

    return { success: true, message: 'บันทึกสำเร็จ — กิจกรรมเปิดแล้ว!' };
  }

  // ============================================================
  // ขยาย/ปรับเวลาสิ้นสุดของรอบที่กำลังเปิดอยู่ โดยไม่ล้างคำตอบ/ผู้ชนะเดิม
  // ============================================================
  async function extendEndTime(newEndTime) {
    const configSnap = await STATE.doc('config').get();
    const config = configSnap.exists ? configSnap.data() : { status: 'NoData' };

    if (config.status !== 'Open') {
      return { success: false, message: 'ขยายเวลาได้เฉพาะตอนกิจกรรมยังเปิดรับคำตอบอยู่ (Open) เท่านั้น' };
    }

    newEndTime = String(newEndTime || '').trim();
    if (!newEndTime) {
      return { success: false, message: 'กรุณาระบุเวลาสิ้นสุดใหม่' };
    }

    await STATE.doc('config').update({ endTime: newEndTime });
    return { success: true, message: 'ขยายเวลาสิ้นสุดเรียบร้อย', endTime: newEndTime };
  }

  // ============================================================
  // ดึงรายชื่อคนตอบถูก — ไม่ต้อง dedup ด้วย normalizeIGN อีกแล้ว เพราะ doc ID
  // (responses/{normalizedIGN}) กันคนตอบซ้ำไม่ให้มีมากกว่า 1 แถวต่อคนตั้งแต่ตอนส่งแล้ว
  // ============================================================
  async function getCorrectRespondents() {
    const correctAnswer = await getSecureCorrectAnswer();
    if (!correctAnswer) return [];

    const snap = await RESPONSES.where('answer', '==', correctAnswer).get();
    const list = [];
    snap.forEach(function (doc) {
      const d = doc.data();
      list.push({ ign: d.ign, answer: d.answer, timestamp: EPData.formatTimestamp(d.submittedAt) });
    });
    list.sort(function (a, b) { return (a.timestamp || '').localeCompare(b.timestamp || ''); });
    return list;
  }

  // ============================================================
  // ดึงรายชื่อคนตอบทั้งหมด
  // ============================================================
  async function getAllRespondents() {
    const snap = await RESPONSES.get();
    const list = [];
    snap.forEach(function (doc) {
      const d = doc.data();
      list.push({ ign: d.ign, answer: d.answer, timestamp: EPData.formatTimestamp(d.submittedAt) });
    });
    return list;
  }

  // ============================================================
  // สุ่มผู้ชนะทีละคน (Step-by-Step)
  // สำคัญ: ต้องเขียน state/reveal พร้อมกับตอนเปลี่ยนสถานะเป็น Drawing ใน batch เดียวกันเสมอ
  // ไม่งั้นหน้าผู้เล่นจะเห็นสถานะ Drawing แต่อ่าน reveal ไม่ได้ (crowd grid ว่างเปล่า)
  // ============================================================
  async function drawNextWinner() {
    const configSnap = await STATE.doc('config').get();
    const config = configSnap.exists ? configSnap.data() : {};
    const maxPrizes = parseInt(config.prizeCount) || 1;

    const correctList = await getCorrectRespondents();
    const currentWinners = await getCurrentWinnersList();

    if (correctList.length === 0) {
      return { success: false, message: 'ไม่มีคนตอบถูก ไม่สามารถสุ่มได้', winners: currentWinners, isComplete: false };
    }
    if (currentWinners.length >= maxPrizes) {
      return {
        success: false,
        message: 'สุ่มครบตามจำนวน ' + maxPrizes + ' รางวัลแล้ว!',
        winners: currentWinners,
        isComplete: true
      };
    }

    const existingNormalized = currentWinners.map(function (w) { return EPData.normalizeIgn(w); });
    const eligible = correctList.filter(function (r) {
      return existingNormalized.indexOf(EPData.normalizeIgn(r.ign)) === -1;
    });

    if (eligible.length === 0) {
      return {
        success: false,
        message: 'ไม่มีผู้ตอบถูกที่ยังไม่ได้รางวัลเหลืออยู่ (สุ่มได้ทั้งหมด ' + currentWinners.length + ' คน)',
        winners: currentWinners,
        isComplete: true
      };
    }

    const picked = eligible[Math.floor(Math.random() * eligible.length)];
    const newWinners = currentWinners.concat([picked.ign]);
    const rank = newWinners.length;
    const isComplete = (newWinners.length >= maxPrizes) || (newWinners.length >= correctList.length);

    const batch = db.batch();
    batch.set(WINNERS.doc(EPData.rankDocId(rank)), {
      ign: picked.ign,
      rank: rank,
      drawnAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    batch.set(STATE.doc('config'), { status: isComplete ? 'Drawn' : 'Drawing' }, { merge: true });
    batch.set(STATE.doc('reveal'), {
      correctRespondentIGNs: correctList.map(function (r) { return r.ign; }),
      totalCorrect: correctList.length
    });
    await batch.commit();

    return {
      success: true,
      message: 'สุ่มได้: ' + picked.ign + ' (รางวัลที่ ' + rank + '/' + maxPrizes + ')',
      winner: picked.ign,
      winnerRank: rank,
      winners: newWinners,
      prizeCount: maxPrizes,
      totalCorrect: correctList.length,
      remainingEligible: eligible.length - 1,
      isComplete: isComplete
    };
  }

  // ============================================================
  // สุ่มผู้ชนะที่เหลือทั้งหมดในครั้งเดียว (Fisher-Yates)
  // ============================================================
  async function drawWinners() {
    const configSnap = await STATE.doc('config').get();
    const config = configSnap.exists ? configSnap.data() : {};
    const maxPrizes = parseInt(config.prizeCount) || 1;

    const correctList = await getCorrectRespondents();
    let currentWinners = await getCurrentWinnersList();

    if (correctList.length === 0) {
      return { success: false, message: 'ไม่มีคนตอบถูก ไม่สามารถสุ่มได้', winners: currentWinners, isComplete: false };
    }

    const existingNormalized = currentWinners.map(function (w) { return EPData.normalizeIgn(w); });
    let eligible = correctList.filter(function (r) {
      return existingNormalized.indexOf(EPData.normalizeIgn(r.ign)) === -1;
    });

    const needCount = maxPrizes - currentWinners.length;
    if (needCount <= 0 || eligible.length === 0) {
      return {
        success: true,
        message: 'สุ่มครบแล้ว',
        winners: currentWinners,
        totalCorrect: correctList.length,
        isComplete: true
      };
    }

    for (let i = eligible.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = eligible[i]; eligible[i] = eligible[j]; eligible[j] = tmp;
    }
    const newPicks = eligible.slice(0, needCount);

    const batch = db.batch();
    newPicks.forEach(function (picked, i) {
      const rank = currentWinners.length + i + 1;
      batch.set(WINNERS.doc(EPData.rankDocId(rank)), {
        ign: picked.ign,
        rank: rank,
        drawnAt: firebase.firestore.FieldValue.serverTimestamp()
      });
    });
    batch.set(STATE.doc('config'), { status: 'Drawn' }, { merge: true });
    batch.set(STATE.doc('reveal'), {
      correctRespondentIGNs: correctList.map(function (r) { return r.ign; }),
      totalCorrect: correctList.length
    });
    await batch.commit();

    currentWinners = currentWinners.concat(newPicks.map(function (p) { return p.ign; }));

    return {
      success: true,
      message: 'สุ่มครบทั้งหมด ' + currentWinners.length + ' รางวัลแล้ว!',
      winners: currentWinners,
      totalCorrect: correctList.length,
      isComplete: true
    };
  }

  async function getCurrentWinnersList() {
    const snap = await WINNERS.orderBy('rank').get();
    const list = [];
    snap.forEach(function (doc) { list.push(doc.data().ign); });
    return list;
  }

  // ============================================================
  // ล้างเฉพาะรายชื่อผู้ชนะ (เผื่อต้องการเริ่มสุ่มใหม่)
  // ============================================================
  async function resetWinnersOnly() {
    await deleteCollection(WINNERS);
    await STATE.doc('config').set({ status: 'Open' }, { merge: true });
    await STATE.doc('reveal').delete();
    return { success: true, message: 'ล้างรายชื่อผู้ชนะเรียบร้อย — สามารถเริ่มสุ่มใหม่ได้' };
  }

  // ============================================================
  // Reset กิจกรรมทั้งหมด
  // state/config ต้อง set เหลือ { status: 'NoData' } เท่านั้น ห้าม delete ทั้ง doc —
  // firestore.rules เรียก get(.../state/config).data.status ทุกครั้งที่เช็คสิทธิ์อื่นๆ
  // ถ้า doc หายไปเลย rule จะ error แล้ว deny ทุกอย่างที่พึ่ง status() ต่อจากนี้
  // ============================================================
  async function resetActivity() {
    await archiveRound();

    await deleteCollection(RESPONSES);
    await deleteCollection(WINNERS);
    await STATE.doc('secureAnswer').delete();
    await STATE.doc('reveal').delete();
    await STATE.doc('config').set({ status: 'NoData' });

    return { success: true, message: 'รีเซ็ตกิจกรรมเรียบร้อย — ข้อมูลเดิมถูกสำรองลง History แล้ว' };
  }

  return {
    signIn: signIn,
    signOut: signOut,
    onAuthChange: onAuthChange,
    getAdminConfig: getAdminConfig,
    saveConfig: saveConfig,
    extendEndTime: extendEndTime,
    getCorrectRespondents: getCorrectRespondents,
    getAllRespondents: getAllRespondents,
    drawNextWinner: drawNextWinner,
    drawWinners: drawWinners,
    resetWinnersOnly: resetWinnersOnly,
    resetActivity: resetActivity
  };
})();
