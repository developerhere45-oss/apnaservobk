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

For a physical Android phone connected by USB during local testing, expose the backend with HTTPS tunneling or a cloud dev URL, then rebuild the apps with that HTTPS URL.

Production builds reject cleartext `http://` traffic.

## Cloud Setup

Laptop par backend chalana production nahi hota. Realtime booking ke liye this backend must run on a public HTTPS domain from a cloud host.

Required environment variables on the cloud host:

```text
NODE_ENV=production
PORT=5000
CLIENT_ORIGIN=https://your-admin-domain.example
MONGODB_URI=mongodb+srv://...
FIREBASE_PROJECT_ID=apna-servo
FIREBASE_SERVICE_ACCOUNT_JSON={...one-line firebase admin json...}
ENCRYPTION_KEY=base64-32-byte-key
ADMIN_FIREBASE_UIDS=comma,separated,uids
ADMIN_EMAILS=admin@example.com
DEFAULT_PARTNER_RADIUS_KM=25
PARTNER_SEARCH_RADIUS_STEPS_KM=5,10
CLOUDINARY_CLOUD_NAME=
CLOUDINARY_API_KEY=
CLOUDINARY_API_SECRET=
RAZORPAY_KEY_ID=
RAZORPAY_KEY_SECRET=
OMNIDIM_API_KEY=
OMNIDIM_AGENT_ID=
# Optional: uses the OmniDimension workspace default when omitted.
OMNIDIM_FROM_NUMBER_ID=
```

Do not use `FIREBASE_SERVICE_ACCOUNT_PATH` in cloud hosting because the cloud server cannot read files from your laptop.
Do not use `CLIENT_ORIGIN=*` in production. Set it to your exact admin/web origins as a comma-separated allow-list.

Generate `ENCRYPTION_KEY` once and keep it safely backed up:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

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

## Optional AI assistance calls (OmniDimension)

The User app can request an optional help call after an opted-in customer spends
five foreground minutes exploring services. The backend accepts this at
`POST /api/users/engagement/assistance-call`, verifies the Firebase phone claim
against the stored verified profile, enforces an atomic seven-day cooldown, then
dispatches with OmniDimension. No OmniDimension key is shipped in either app.

Set `OMNIDIM_API_KEY` and `OMNIDIM_AGENT_ID` in Render/Railway environment
variables, then publish the configured outgoing OmniDimension agent. Configure a
post-call webhook in OmniDimension separately if call outcomes should update the
admin dashboard. Do not add provider keys to Git, an APK, or client-side config.

## Launching in new cities

Service availability is published from the Admin Control Center, not hardcoded
to Guwahati. As a Super Admin, save a `serviceAreas` draft and then publish it:

```json
{
  "section": "serviceAreas",
  "value": [
    { "id": "guwahati", "name": "Guwahati, Assam", "enabled": true, "centerLat": 26.1445, "centerLng": 91.7362, "radiusKm": 35 },
    { "id": "tezpur", "name": "Tezpur, Assam", "enabled": true, "centerLat": 26.6338, "centerLng": 92.8000, "radiusKm": 18 }
  ]
}
```

Send the body to `PATCH /api/admin/control-center/draft?app=customer&platform=android`,
then publish it with `POST /api/admin/control-center/publish?app=customer&platform=android`.
The user app refreshes the published zones automatically. Each enabled zone is a
circle: choose its center coordinates and a radius from 1 to 250 km. Disable a
zone rather than deleting it when pausing a city launch.
