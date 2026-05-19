# ApnaServo Backend

Production backend for the ApnaServo user and partner Android apps.

## Stack

- Node.js + Express
- MongoDB Atlas through Mongoose
- Firebase Auth token verification
- Firebase Cloud Messaging
- Socket.IO realtime booking dispatch
- Cloudinary and Razorpay config hooks

## Local Setup

```powershell
cd backend
npm install
copy .env.example .env
npm start
```

For a physical Android phone connected by USB during local testing:

```powershell
adb reverse tcp:5000 tcp:5000
```

The debug apps default to `http://127.0.0.1:5000`, which works through `adb reverse`.

## Cloud Setup

Laptop par backend chalana production nahi hota. Realtime booking ke liye this backend must run on a public HTTPS domain from a cloud host.

Required environment variables on the cloud host:

```text
NODE_ENV=production
PORT=5000
CLIENT_ORIGIN=*
MONGODB_URI=mongodb+srv://...
FIREBASE_PROJECT_ID=apna-servo
FIREBASE_SERVICE_ACCOUNT_JSON={...one-line firebase admin json...}
DEFAULT_PARTNER_RADIUS_KM=25
CLOUDINARY_CLOUD_NAME=
CLOUDINARY_API_KEY=
CLOUDINARY_API_SECRET=
RAZORPAY_KEY_ID=
RAZORPAY_KEY_SECRET=
```

Do not use `FIREBASE_SERVICE_ACCOUNT_PATH` in cloud hosting because the cloud server cannot read files from your laptop.

Generate `FIREBASE_SERVICE_ACCOUNT_JSON` from your Firebase admin SDK file:

```powershell
node scripts/firebase-json-one-line.js "C:\Users\Admin\Downloads\apna-servo-firebase-adminsdk-fbsvc-cab8c1c568.json"
```

Copy the printed one-line JSON into the cloud host environment variable.

## Render/Railway

This repo includes:

- `Procfile` for Heroku-style hosts.
- `render.yaml` for Render blueprint deploys.
- `railway.json` for Railway deploys.

After deployment, check:

```text
https://YOUR-BACKEND-DOMAIN/health
```

It should return:

```json
{ "ok": true, "realtime": "socket.io", "dataStore": "mongodb" }
```

## Build Apps For Cloud Backend

After your backend has a public URL, rebuild both Android apps with that URL:

```powershell
cd "C:\Users\Admin\Documents\New project\ApnaServo"
.\BUILD_APPS_FOR_CLOUD.bat https://YOUR-BACKEND-DOMAIN
```

This creates APKs that connect to:

```text
https://YOUR-BACKEND-DOMAIN/api
https://YOUR-BACKEND-DOMAIN
```

Do not leave production APKs pointing to `127.0.0.1`, `192.168.x.x`, or `192.168.56.1`; those only work for local testing.

## Core Flow

- User app calls `POST /api/bookings`.
- Backend stores the booking in MongoDB.
- Backend finds online verified partners matching service category and location.
- Backend emits `booking:new_request` through Socket.IO and sends FCM.
- Partner app accepts via `POST /api/bookings/:bookingId/accept`.
- Backend atomically locks the booking for the first accepted partner.
- User app receives `booking:accepted` and later `booking:status_update`.
