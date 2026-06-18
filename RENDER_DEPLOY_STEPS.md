# ApnaServo Render Deployment

Deploy this folder:

`C:\Users\Admin\Documents\New project\apnaservo-backend-deploy`

GitHub repository:

`https://github.com/developerhere45-oss/apnaservobk`

## 1. Push the updated backend

Open PowerShell and run:

```powershell
cd "C:\Users\Admin\Documents\New project\apnaservo-backend-deploy"
git status
git add .
git commit -m "Deploy updated booking and partner flow"
git push origin main
```

The `.env`, `node_modules`, local logs, and generated audit report are ignored and will not be uploaded.

## 2. Configure the existing Render service

Open Render and select the web service connected to:

`developerhere45-oss/apnaservobk`

Use these settings:

- Runtime: `Node`
- Branch: `main`
- Root Directory: leave empty
- Build Command: `npm ci`
- Start Command: `npm start`
- Health Check Path: `/health`
- Auto Deploy: enabled

## 3. Set Render environment variables

Required:

```text
NODE_ENV=production
CLIENT_ORIGIN=https://YOUR-ADMIN-OR-WEBSITE-DOMAIN
MONGODB_URI=YOUR_MONGODB_ATLAS_CONNECTION_STRING
FIREBASE_PROJECT_ID=apna-servo
FIREBASE_SERVICE_ACCOUNT_JSON=YOUR_ONE_LINE_FIREBASE_SERVICE_ACCOUNT_JSON
ENCRYPTION_KEY=YOUR_32_BYTE_BASE64_KEY
ADMIN_API_SECRET=YOUR_RANDOM_ADMIN_SECRET
DEFAULT_PARTNER_RADIUS_KM=25
REQUIRE_CUSTOMER_PHONE_OTP=false
```

At least one admin allow-list value should also be set:

```text
ADMIN_FIREBASE_UIDS=comma-separated-admin-firebase-uids
ADMIN_EMAILS=comma-separated-verified-admin-emails
```

If the admin website is not deployed yet, `CLIENT_ORIGIN` can temporarily be the Render backend URL. Replace it with the real admin/website origin before browser-based admin access.

Generate secure values locally:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Use the first output for `ENCRYPTION_KEY` and the second for `ADMIN_API_SECRET`.

Convert the Firebase service account file to one-line JSON:

```powershell
node scripts/firebase-json-one-line.js "C:\path\to\firebase-service-account.json"
```

Copy the command output into `FIREBASE_SERVICE_ACCOUNT_JSON`. Never commit the service account file or JSON.

Optional integrations:

```text
CLOUDINARY_CLOUD_NAME=
CLOUDINARY_API_KEY=
CLOUDINARY_API_SECRET=
RAZORPAY_KEY_ID=
RAZORPAY_KEY_SECRET=
REDIS_REST_URL=
REDIS_REST_TOKEN=
```

## 4. Deploy

After pushing:

1. Open the Render service.
2. Click `Manual Deploy`.
3. Choose `Clear build cache & deploy`.
4. Wait for `Live`.

## 5. Verify production

Open:

```text
https://apnaservobk-1.onrender.com/health
https://apnaservobk-1.onrender.com/ready
```

Expected `/health` response includes:

```json
{"ok":true,"service":"apnaservo-backend"}
```

Expected `/ready` response includes:

```json
{"ok":true,"mongo":"connected"}
```

If `/ready` returns `503`, check `MONGODB_URI`, MongoDB Atlas Network Access, and Render logs.
