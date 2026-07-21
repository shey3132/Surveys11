# Survey API

מערכת סקרים עם שלושה ממשקים:
1. **Admin API** – ניהול משתמשים וסקרים (`/admin/...`)
2. **IVR Endpoint** – מענה טלפוני דרך ימות המשיח (`/ivr/survey`)
3. **Display Endpoint** – מסך תצוגה ראשי עם polling (`/display/status`)

## התקנה

```bash
npm install
```

## הרצה

```bash
node app.js
```

השרת יעלה על פורט 3000 (או לפי משתנה הסביבה `PORT`).

## מסד נתונים

**Firebase Firestore** (NoSQL, חינמי לצמיתות - בלי מגבלת 30 יום כמו ב-Postgres החינמי של Render).

### הגדרה
1. ב-[console.firebase.google.com](https://console.firebase.google.com) → **Add project** → תן שם, אפשר לכבות Google Analytics (לא נחוץ).
2. בתפריט הצד → **Build** → **Firestore Database** → **Create database** → מצב **Production** → תבחר אזור (למשל `eur3` אם קרוב לישראל).
3. **Project settings** (⚙️ ליד "Project Overview") → **Service accounts** → **Generate new private key** - מוריד קובץ `.json`.
4. פתח את הקובץ שהורד בעורך טקסט, העתק את **כל** התוכן שלו (כולל הסוגריים המסולסלים).
5. ב-Render: השירות `surveys11` → **Environment** → **Add Environment Variable**:
   - Key: `FIREBASE_SERVICE_ACCOUNT`
   - Value: מה שהעתקת (כל תוכן ה-JSON, כמות אחת ארוכה)
6. שמור - Render יעשה Redeploy אוטומטי. אין צורך ליצור טבלאות מראש - Firestore יוצר אוסף (collection) אוטומטית ברגע שנכתב אליו מסמך ראשון.

⚠️ **חשוב:** אל תעלה את קובץ ה-JSON עצמו ל-GitHub בשום שלב - הוא מכיל מפתח סודי עם הרשאה מלאה למסד שלך. הוא צריך להיכנס **רק** דרך Environment Variable ב-Render.

### הרצה מקומית (לבדיקות)
```bash
export FIREBASE_SERVICE_ACCOUNT='<תוכן קובץ ה-JSON כמחרוזת אחת>'
node app.js
```

---

## Admin API

### העלאת רשימת משתמשים (מחליפה את כל הרשימה הקיימת!)
```
POST /admin/users/upload
Content-Type: multipart/form-data
Field: file  (קובץ .xlsx עם עמודות "phone" ו-"name")
```
⚠️ **שים לב:** העלאה מוחקת את כל המשתמשים הקודמים, וכל היסטוריית התשובות שהייתה שייכת למשתמשים שהוסרו נמחקת יחד איתם (cascade). אם צריך לשמר היסטוריה — יש לייצא תוצאות (`/admin/surveys/:id/results`) לפני החלפת הרשימה.

### יצירת סקר
```
POST /admin/surveys
Content-Type: application/json

{
  "title": "סקר שביעות רצון",
  "description": "אופציונלי",
  "questions": [
    { "text": "עד כמה אתה מרוצה", "options": ["מאוד מרוצה", "בסדר", "לא מרוצה"] },
    { "text": "האם תמליץ לחבר", "options": ["כן", "לא"] }
  ]
}
```
מקסימום 9 אופציות לשאלה (ספרה אחת = אופציה).

### עריכת סקר (רק במצב draft)
```
PUT /admin/surveys/:id   (אותו גוף כמו יצירה)
```

### הפעלה / סגירה
```
POST /admin/surveys/:id/activate   # סוגר אוטומטית כל סקר פעיל אחר
POST /admin/surveys/:id/close      # זה מה שמקפיץ תוצאות במסך הראשי
```

### תוצאות
```
GET /admin/surveys/:id/results
```

---

## IVR Endpoint (ימות המשיח)

**כתובת אחת קבועה**, מוגדרת כ-`api_link` בשלוחה: `/ivr/survey`

השרת מקבל בכל קריאה: `ApiCallId`, `ApiPhone` (Caller ID אוטומטי), ואת כל התשובות שנאספו עד כה (פרמטרים בשם `ans_<question_id>`, מצטברים אוטומטית ע"י ימות המשיח).

זרימה:
- קריאה ראשונה (בלי תשובות) → בדיקת הרשאה מול רשימת המשתמשים + בדיקת "כבר ענה" → מחזיר `read=...` לשאלה הראשונה
- כל קריאה נוספת → בודק אילו תשובות כבר יש, שולח `read=...` לשאלה הבאה
- כשכל השאלות נענו → שומר ל-DB, מחזיר הודעת סיום (`id_list_message=...`)

**הגנות מובנות מפני "שגיאה" קולית (M1080):**
- כל טקסט שמנוהל דרך `/admin.html` (כותרת סקר, טקסט שאלה, טקסט אופציה) עובר ניקוי אוטומטי לפני שהוא נשלח ל-TTS — מוסרים ממנו `. - = , &`, כי כל אחד מהתווים האלה עלול לשבש את פענוח הפקודה (`,` למשל מזיז את רשימת הפרמטרים של `read=` מהמקום, ו-`&` הוא מפריד שרשור פקודות של ימות המשיח).
- כל הזרימה עטופה ב-try/catch גלובלי: אם קורה משהו לא צפוי בשרת, חוזרת הודעת שגיאה מסודרת (`id_list_message=t-...`) במקום עמוד שגיאה HTML שימות המשיח לא יודע לפרש (וגורם ל"שגיאה" קולית).

---

## Display Endpoint

```
GET /display/status
```
לבצע polling כל 2 שניות מהמסך הראשי.

תגובה כשהסקר פעיל:
```json
{ "status": "active", "question": "...", "options": [...], "response_count": 17 }
```

תגובה אחרי `close`:
```json
{ "status": "closed", "results": [ { "question": "...", "options": [{"text":"...","count":12,"percent":71}] } ] }
```

---

## פריסה (Hosting)

**Render** (Free tier) - מתאים לשכבה החינמית, כי המידע נשמר ב-Firestore (שירות חיצוני של Google, חינמי לצמיתות) ולא בדיסק המקומי של השרת. אין צורך ב-Persistent Disk. **לא מתאים ל-Vercel/Netlify** (עדיין - אלה serverless בלי שרת ארוך-טווח, וה-IVR/Display צריכים שרת שרץ ברציפות).
