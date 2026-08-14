const { onDocumentCreated } = require('firebase-functions/v2/firestore')
const admin = require('firebase-admin')

admin.initializeApp()

const appUrl = 'https://paco4gn.github.io/cuentas-claras/?avisos=pagos'

exports.notifyPaymentConfirmation = onDocumentCreated('users/{userId}/paymentConfirmations/{confirmationId}', async (event) => {
  const confirmation = event.data && event.data.data()
  if (!confirmation || confirmation.status !== 'pending') return

  const { userId, confirmationId } = event.params
  const tokensSnapshot = await admin.firestore().collection('users').doc(userId).collection('notificationTokens').get()
  const tokens = tokensSnapshot.docs.map((doc) => doc.data().token).filter(Boolean)
  if (tokens.length === 0) return

  const amount = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(confirmation.amount || 0)
  const payerName = confirmation.payerName || 'Alguien'
  const body = `${payerName} avisa que ha pagado ${amount}. Entra para aceptarlo o revisarlo.`

  const response = await admin.messaging().sendEachForMulticast({
    tokens,
    notification: {
      title: 'Pago avisado',
      body,
    },
    data: {
      url: appUrl,
      confirmationId,
      qrid: confirmation.qrid || '',
    },
    webpush: {
      fcmOptions: {
        link: appUrl,
      },
      notification: {
        badge: '/cuentas-claras/favicon.svg',
        icon: '/cuentas-claras/favicon.svg',
        renotify: true,
        tag: 'payment-confirmation',
      },
    },
  })

  await Promise.all(
    response.responses.map((result, index) => {
      const code = result.error && result.error.code
      if (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token') {
        return tokensSnapshot.docs[index].ref.delete()
      }
      return Promise.resolve()
    }),
  )
})
