const defaultAppUrl = 'https://paco4gn.github.io/cuentas-claras/?avisos=pagos'
const corsHeaders = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })
    const url = new URL(request.url)
    if (request.method !== 'POST' || url.pathname !== '/notify-payment') {
      return json({ ok: false, error: 'not_found' }, 404)
    }

    try {
      const body = await request.json()
      const ownerId = String(body.ownerId || '').trim()
      const confirmationId = String(body.confirmationId || '').trim()
      if (!ownerId || !confirmationId) return json({ ok: false, error: 'missing_data' }, 400)

      const accessToken = await getGoogleAccessToken(env)
      const confirmation = await getFirestoreDoc(
        env,
        accessToken,
        `users/${encodeURIComponent(ownerId)}/paymentConfirmations/${encodeURIComponent(confirmationId)}`,
      )
      if (!confirmation) return json({ ok: false, error: 'confirmation_not_found' }, 404)
      if (fieldValue(confirmation, 'status') !== 'pending') return json({ ok: true, skipped: 'not_pending' })
      if (fieldValue(confirmation, 'notifiedAt')) return json({ ok: true, skipped: 'already_notified' })

      const tokens = await listNotificationTokens(env, accessToken, ownerId)
      if (tokens.length === 0) return json({ ok: true, sent: 0, skipped: 'no_tokens' })

      const amount = Number(fieldValue(confirmation, 'amount') || 0)
      const payerName = String(fieldValue(confirmation, 'payerName') || 'Alguien')
      const qrid = String(fieldValue(confirmation, 'qrid') || '')
      const appUrl = env.APP_URL || defaultAppUrl
      const notification = {
        title: 'Pago avisado',
        body: `${payerName} avisa que ha pagado ${formatMoney(amount)}. Entra para revisarlo y cerrar la cuenta.`,
        url: appUrl,
        confirmationId,
        qrid,
      }

      const results = await Promise.allSettled(
        tokens.map((item) => sendFcmMessage(env, accessToken, item.token, notification)),
      )
      const invalidDeletes = results.map((result, index) => {
        if (result.status !== 'rejected' || !isInvalidTokenError(result.reason)) return null
        return deleteFirestoreDoc(env, accessToken, tokens[index].docPath)
      }).filter(Boolean)
      await Promise.allSettled(invalidDeletes)
      await markConfirmationNotified(env, accessToken, ownerId, confirmationId)

      const sent = results.filter((result) => result.status === 'fulfilled').length
      return json({ ok: true, sent, failed: results.length - sent })
    } catch (error) {
      return json({ ok: false, error: error instanceof Error ? error.message : 'unknown_error' }, 500)
    }
  },
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { ...corsHeaders, 'content-type': 'application/json; charset=utf-8' },
  })
}

async function getGoogleAccessToken(env) {
  const now = Math.floor(Date.now() / 1000)
  const payload = {
    iss: env.GOOGLE_CLIENT_EMAIL,
    scope: 'https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }
  const assertion = await signJwt(payload, env.GOOGLE_PRIVATE_KEY)
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error_description || data.error || 'google_auth_failed')
  return data.access_token
}

async function signJwt(payload, privateKey) {
  const header = { alg: 'RS256', typ: 'JWT' }
  const unsigned = `${base64urlJson(header)}.${base64urlJson(payload)}`
  const key = await importPrivateKey(privateKey)
  const signature = await crypto.subtle.sign(
    { name: 'RSASSA-PKCS1-v1_5' },
    key,
    new TextEncoder().encode(unsigned),
  )
  return `${unsigned}.${base64urlBytes(new Uint8Array(signature))}`
}

async function importPrivateKey(privateKey) {
  const pem = privateKey.replace(/\\n/g, '\n')
  const base64 = pem
    .replace('-----BEGIN PRIVATE KEY-----', '')
    .replace('-----END PRIVATE KEY-----', '')
    .replace(/\s/g, '')
  const raw = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))
  return crypto.subtle.importKey(
    'pkcs8',
    raw,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  )
}

function base64urlJson(value) {
  return base64urlBytes(new TextEncoder().encode(JSON.stringify(value)))
}

function base64urlBytes(bytes) {
  let binary = ''
  bytes.forEach((byte) => { binary += String.fromCharCode(byte) })
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

async function getFirestoreDoc(env, accessToken, path) {
  const response = await fetch(firestoreUrl(env, path), {
    headers: { authorization: `Bearer ${accessToken}` },
  })
  if (response.status === 404) return null
  const data = await response.json()
  if (!response.ok) throw new Error(data.error?.message || 'firestore_get_failed')
  return data
}

async function listNotificationTokens(env, accessToken, ownerId) {
  const path = `users/${encodeURIComponent(ownerId)}/notificationTokens`
  const response = await fetch(firestoreUrl(env, path), {
    headers: { authorization: `Bearer ${accessToken}` },
  })
  if (response.status === 404) return []
  const data = await response.json()
  if (!response.ok) throw new Error(data.error?.message || 'firestore_tokens_failed')
  return (data.documents || [])
    .map((doc) => ({ docPath: doc.name, token: fieldValue(doc, 'token') }))
    .filter((item) => item.token)
}

async function deleteFirestoreDoc(env, accessToken, fullDocName) {
  const response = await fetch(fullDocName, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${accessToken}` },
  })
  if (!response.ok && response.status !== 404) {
    const data = await response.json().catch(() => ({}))
    throw new Error(data.error?.message || 'firestore_delete_failed')
  }
}

async function markConfirmationNotified(env, accessToken, ownerId, confirmationId) {
  const path = `users/${encodeURIComponent(ownerId)}/paymentConfirmations/${encodeURIComponent(confirmationId)}?updateMask.fieldPaths=notifiedAt`
  const response = await fetch(firestoreUrl(env, path), {
    method: 'PATCH',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      fields: {
        notifiedAt: { timestampValue: new Date().toISOString() },
      },
    }),
  })
  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    throw new Error(data.error?.message || 'firestore_patch_failed')
  }
}

async function sendFcmMessage(env, accessToken, token, notification) {
  const response = await fetch(`https://fcm.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/messages:send`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      message: {
        token,
        notification: {
          title: notification.title,
          body: notification.body,
        },
        data: {
          url: notification.url,
          confirmationId: notification.confirmationId,
          qrid: notification.qrid,
        },
        webpush: {
          fcm_options: {
            link: notification.url,
          },
          notification: {
            badge: '/cuentas-claras/favicon.svg',
            icon: '/cuentas-claras/favicon.svg',
            renotify: true,
            tag: 'payment-confirmation',
          },
        },
      },
    }),
  })
  const data = await response.json()
  if (!response.ok) {
    const error = new Error(data.error?.message || 'fcm_send_failed')
    error.status = data.error?.status
    throw error
  }
  return data
}

function firestoreUrl(env, path) {
  return `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/${path}`
}

function fieldValue(doc, field) {
  const value = doc.fields?.[field]
  if (!value) return undefined
  if ('stringValue' in value) return value.stringValue
  if ('doubleValue' in value) return Number(value.doubleValue)
  if ('integerValue' in value) return Number(value.integerValue)
  if ('booleanValue' in value) return Boolean(value.booleanValue)
  if ('timestampValue' in value) return value.timestampValue
  return undefined
}

function isInvalidTokenError(error) {
  const text = `${error?.message || ''} ${error?.status || ''}`
  return /registration-token|not found|NOT_FOUND|INVALID_ARGUMENT/i.test(text)
}

function formatMoney(value) {
  return new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(value)
}
