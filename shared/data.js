// ============================================================
// data.js — Data layer ที่ใช้ร่วมกันระหว่างหน้าผู้เล่นและหน้าแอดมิน
// (แทนที่ gasCall/gasCallOnce ที่เคย copy-paste ซ้ำในทั้งสองหน้าฝั่ง GAS version)
//
// Requires: firebase-init.js โหลดมาก่อนแล้ว (globals: db, auth)
// ============================================================

const EPData = (function () {
  'use strict';

  const STATE     = db.collection('state');
  const RESPONSES = db.collection('responses');
  const WINNERS   = db.collection('winners');
  const RESPONSE_LOG = db.collection('responseLog');

  // ============================================================
  // Helper — Normalize ชื่อ IGN ก่อนเทียบซ้ำ/ใช้เป็น doc ID
  // พอร์ตจาก gas-client/Code.gs normalizeIGN — เพิ่มการตัด '/' ออกด้วย (ของเดิมไม่มี
  // เพราะ GAS ไม่ผูก IGN เป็น ID ของอะไร) แต่ Firestore document ID ห้ามมี '/' เด็ดขาด
  // ============================================================
  function normalizeIgn(name) {
    const zeroWidthChars = String.fromCharCode(0x200B, 0x200C, 0x200D, 0xFEFF);
    const zeroWidthPattern = new RegExp('[' + zeroWidthChars + ']', 'g');
    return String(name || '')
      .normalize('NFKC')
      .replace(zeroWidthPattern, '')
      .replace(/[\s_\-.'"`/]/g, '')
      .toUpperCase();
  }

  // ใช้เป็น doc ID ของ responses/{id} — ถ้า normalize แล้วว่างเปล่า (เช่นพิมพ์แค่ "...")
  // ให้ throw ข้อความเดียวกับตอนไม่กรอกชื่อเลย แทนที่จะพยายามสร้าง doc ID ว่าง
  function docIdForIgn(name) {
    const id = normalizeIgn(name);
    if (!id) throw new Error('กรุณากรอกชื่อตัวละคร');
    return id;
  }

  // doc ID ของ winners/{rank} — เติมศูนย์ให้เรียงลำดับได้ถูกต้องด้วย orderBy(documentId) เผื่อใช้
  function rankDocId(rank) {
    return String(rank).padStart(3, '0');
  }

  function formatTimestamp(ts) {
    if (!ts || typeof ts.toDate !== 'function') return '';
    return ts.toDate().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' });
  }

  // ============================================================
  // Realtime watchers — แทนที่ polling ทุก 5 วินาทีของเวอร์ชัน GAS ทั้งหมด
  // ============================================================
  function watchConfig(onData, onError) {
    return STATE.doc('config').onSnapshot(function (snap) {
      const d = snap.data();
      onData(d ? Object.assign({ status: 'NoData' }, d) : { status: 'NoData' });
    }, onError);
  }

  function watchWinners(onData, onError) {
    return WINNERS.orderBy('rank').onSnapshot(function (qs) {
      const list = [];
      qs.forEach(function (doc) { list.push(doc.data().ign); });
      onData(list);
    }, onError);
  }

  // เรียกเฉพาะตอน status เป็น Drawing/Drawn เท่านั้น — firestore.rules ปฏิเสธอ่าน state/reveal
  // ตอน Open ทำให้ onSnapshot จะเข้า error callback ทันทีถ้าผูกไว้ตั้งแต่แรก
  function watchReveal(onData, onError) {
    return STATE.doc('reveal').onSnapshot(function (snap) {
      const d = snap.data();
      onData(d
        ? { correctRespondentIGNs: d.correctRespondentIGNs || [], totalCorrect: d.totalCorrect || 0 }
        : { correctRespondentIGNs: [], totalCorrect: 0 });
    }, onError);
  }

  // ============================================================
  // Submit — สร้าง doc ที่ responses/{normalizedIGN} ตรงๆ
  // Firestore จะปฏิเสธเองแบบ atomic ถ้ามี doc ID นี้อยู่แล้ว (ดู firestore.rules: การ set()
  // ทับ doc ที่มีอยู่แล้วถูก Firestore จัดประเภทเป็น "update" ไม่ใช่ "create" โดยอัตโนมัติ —
  // ไม่ต้องใช้ lock/สแกนหาชื่อซ้ำเหมือนฝั่ง GAS อีกต่อไป)
  //
  // currentStatus รับมาจาก listener ที่หน้าเว็บถืออยู่แล้ว (watchConfig) กันไม่ต้องอ่านซ้ำ
  // ก่อนเขียนทุกครั้ง
  // ============================================================
  async function submitAnswer(ign, answer, currentStatus) {
    ign = String(ign || '').trim();
    if (!ign) {
      return { success: false, message: 'กรุณากรอกชื่อตัวละคร' };
    }

    let docId;
    try {
      docId = docIdForIgn(ign);
    } catch (err) {
      return { success: false, message: err.message };
    }

    if (currentStatus !== 'Open') {
      await logAttempt(ign, answer, false, 'closed');
      return { success: false, message: 'กิจกรรมปิดรับคำตอบแล้ว' };
    }

    try {
      await RESPONSES.doc(docId).set({
        ign: ign,
        answer: answer,
        submittedAt: firebase.firestore.FieldValue.serverTimestamp()
      });
      await logAttempt(ign, answer, true, 'ok');
      return { success: true, message: 'ส่งคำตอบเรียบร้อย!' };
    } catch (err) {
      // เช็ค status ว่า Open ไปแล้วข้างบน ถ้ายังโดนปฏิเสธอยู่แปลว่า doc นี้มีอยู่แล้ว (ชื่อซ้ำ)
      // เกือบทุกกรณี ยกเว้น race หายากที่แอดมินปิดกิจกรรมพอดีตอนกำลังส่ง — ยอมรับข้อความ
      // คลาดเคลื่อนได้ในเคสนั้น แลกกับไม่ต้องอ่าน state/config ซ้ำทุกครั้งที่ส่งคำตอบ
      await logAttempt(ign, answer, false, (err && err.code) || 'denied');
      return { success: false, message: 'ชื่อนี้ส่งคำตอบไปแล้ว ไม่สามารถส่งซ้ำได้' };
    }
  }

  // ============================================================
  // Log ทุกครั้งที่พยายามส่งคำตอบ (สำเร็จหรือไม่) — append-only audit trail
  // ไม่ throw ทับ error หลักถ้าเขียน log ไม่สำเร็จ (ไม่ critical ต่อผู้เล่น)
  // ============================================================
  async function logAttempt(ign, answer, accepted, reason) {
    try {
      await RESPONSE_LOG.add({
        ign: String(ign || ''),
        normalizedIgn: normalizeIgn(ign),
        answer: answer || null,
        accepted: !!accepted,
        reason: reason,
        at: firebase.firestore.FieldValue.serverTimestamp()
      });
    } catch (e) { /* เขียน log ไม่สำเร็จ ไม่ critical */ }
  }

  return {
    normalizeIgn: normalizeIgn,
    docIdForIgn: docIdForIgn,
    rankDocId: rankDocId,
    formatTimestamp: formatTimestamp,
    watchConfig: watchConfig,
    watchWinners: watchWinners,
    watchReveal: watchReveal,
    submitAnswer: submitAnswer
  };
})();
