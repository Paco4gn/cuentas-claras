# Cuentas claras

PWA para controlar quien te debe dinero, a quien debes, gastos compartidos, pagos parciales y etiquetas.

## Funciones

- Login con Firebase Auth cuando esta configurado.
- Modo local de respaldo con contrasena protegida mediante PBKDF2 y salt.
- Cambio de contrasena y recuperacion mediante codigo local.
- Inicio con Google mediante Firebase o Google Identity Services en modo local.
- Sincronizacion cloud con Firestore y copia local en IndexedDB.
- Personas con telefono, email y notas.
- Gastos divididos entre varias personas, con reparto igual o importes manuales.
- Deudas directas: "me debe" y "le debo".
- Pagos: "me ha pagado" y "le he pagado".
- Estados: por pagar, parcial y pagado.
- Etiquetas, notas, busqueda, borrado, importacion y exportacion JSON.
- Edicion de personas y movimientos.
- Liquidacion rapida de saldos con registro de pago en historial.
- Filtro por estado y exportacion CSV.
- Resumen de actividad y etiquetas.
- Instalable en iPhone desde Safari con "Anadir a pantalla de inicio".

## Privacidad

La app funciona con Firebase si las variables `VITE_FIREBASE_*` estan configuradas. En ese modo, personas y movimientos se guardan en Firestore por usuario y tambien se reflejan en IndexedDB como copia local.

Si falta Firebase o decides usar el fallback, la app pasa a modo local-first: los datos se guardan en el navegador del dispositivo. Usa la opcion de exportar JSON para hacer copias de seguridad.

La recuperacion de contrasena funciona con un codigo local. Guarda ese codigo en un sitio seguro: la app guarda solo su hash y no puede mostrarlo de nuevo si lo pierdes.

## Google Login

Para activar "Entrar con Google" crea un OAuth Client ID en Google Cloud para una aplicacion web y autoriza:

- `https://paco4gn.github.io`
- `http://127.0.0.1:5175`

Despues crea un `.env.local` con:

```bash
VITE_GOOGLE_CLIENT_ID=tu-client-id.apps.googleusercontent.com
```

Vuelve a ejecutar `npm run build` y despliega `dist` a `gh-pages`.

## Firebase

Proyecto creado: `cuentas-claras-paco4gn`.

Archivos incluidos:

- `src/firebase.ts`: inicializacion Firebase.
- `firestore.rules`: cada usuario solo accede a `users/{uid}` y sus subcolecciones.
- `firebase.json` y `.firebaserc`: despliegue de reglas al proyecto correcto.

Variables necesarias:

```bash
VITE_FIREBASE_API_KEY=...
VITE_FIREBASE_AUTH_DOMAIN=...
VITE_FIREBASE_PROJECT_ID=...
VITE_FIREBASE_STORAGE_BUCKET=...
VITE_FIREBASE_MESSAGING_SENDER_ID=...
VITE_FIREBASE_APP_ID=...
```

Firestore ya esta creado en `eur3` y las reglas se han desplegado. Para que Auth funcione hay que activar en Firebase Console los proveedores `Email/Password` y `Google` en Authentication > Sign-in method, y autorizar `paco4gn.github.io` como dominio.

## Desarrollo

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
```
