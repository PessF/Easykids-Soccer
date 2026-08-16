EasyKids Robot Soccer — HTML / CSS / JavaScript ธรรมดา
=======================================================

ไฟล์หลัก
- index.html            หน้าควบคุมของกรรมการ
- display.html          หน้าจอแสดงเวลาและคะแนน
- css/styles.css        รูปแบบและธีมทั้งหมด
- js/firebase-config.js ตั้งค่า Firebase
- js/control.js         ระบบหน้าควบคุม
- js/display.js         ระบบหน้าจอแสดงผล

วิธีใช้งาน
1. เปิด index.html เพื่อเข้าสู่หน้าควบคุม
2. กรอกรหัสสนาม 4 หลัก และรหัสผ่านห้อง 2877
3. เปิด display.html ในอีกหน้าจอ แล้วกรอกรหัสสนามและรหัสผ่านเดียวกัน
4. ตั้งเวลา ชื่อทีม และควบคุมคะแนนจาก index.html

ประวัติการแข่งขัน
- เมื่อหมดเวลา นาฬิกาจะหยุดที่ 00:00.000 แต่ยังไม่จบและไม่บันทึกแมตช์
- ระบบบันทึกประวัติเฉพาะเมื่อกรรมการกดจบการแข่งขัน
- ข้อมูลอยู่ที่ rooms/{roomCode}/history ใน Firebase Realtime Database
- แต่ละแมตช์ใช้ Firebase Push ID ไม่ซ้ำกันและแสดงประวัติทุก child ตามเวลาจบ
- ลบได้ทีละแมตช์หรือล้างประวัติทั้งหมดจากหน้าควบคุม

ไม่ต้องติดตั้ง Node.js, npm, React หรือ Framework ใด ๆ
สามารถอัปโหลดโฟลเดอร์ทั้งหมดขึ้น Static Hosting ได้ทันที

ไฟล์โลโก้และเสียง
- logos/logo-left.png
- logos/logo-right.png
- sounds/countdown.mp3
- sounds/whistle.mp3

Firebase
- เปิด Realtime Database ในโปรเจกต์ easykidssoccer
- เลือก Region: Singapore (asia-southeast1)
- นำ Rules จาก firebase-rules.json ไปวางในหน้า Rules
- ถ้า URL ฐานข้อมูลไม่ตรง ให้แก้ databaseURL ใน js/firebase-config.js

หมายเหตุด้านความปลอดภัย
Rules ที่ให้มาสำหรับการทดสอบหรือใช้งานภายในงานแข่งขัน ผู้ที่ทราบ Room Code
สามารถแก้ข้อมูลได้ หากเปิดใช้งานสาธารณะควรเพิ่ม Firebase Authentication
รหัสผ่าน 2877 เป็นตัวกรองหน้าเว็บแบบง่ายสำหรับงานภายใน ไม่ใช่การยืนยันตัวตน
ระดับเซิร์ฟเวอร์ เพราะ HTML/JavaScript ฝั่งผู้ใช้สามารถถูกเปิดดูซอร์สได้
