// Requires firebase-app-compat.js, firebase-firestore-compat.js, firebase-auth-compat.js,
// and firebase-config.js to be loaded first (see index.html/admin/index.html <head>).

firebase.initializeApp(FIREBASE_CONFIG);

const db = firebase.firestore();
const auth = firebase.auth();

// ต่อ emulator เฉพาะตอนหน้าเว็บถูกเปิดจาก Hosting emulator เท่านั้น (localhost/127.0.0.1
// ตามที่ README ใช้) — ตรวจจากชื่อโฮสต์อัตโนมัติแทนการ hardcode ไว้ตายตัว เพื่อให้ไฟล์นี้
// ไฟล์เดียวใช้ได้ทั้งตอนรัน local emulator และตอน deploy ขึ้นจริงโดยไม่ต้องแก้อะไรเพิ่ม —
// ถ้าลืมเอาบรรทัด useEmulator() ออกก่อน deploy จริง เว็บที่ deploy แล้วจะพยายามต่อ
// 127.0.0.1:8080/9099 ซึ่งไม่มีอยู่จริงบนเครื่องผู้ใช้ แล้วใช้งานไม่ได้เลยทั้งเว็บ
const isLocalEmulatorHost = ['localhost', '127.0.0.1'].includes(location.hostname);
if (isLocalEmulatorHost) {
  db.useEmulator('127.0.0.1', 8080);
  auth.useEmulator('http://127.0.0.1:9099', { disableWarnings: true });
}
