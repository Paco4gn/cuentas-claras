# Cuentas claras

PWA para controlar quien te debe dinero, a quien debes, gastos compartidos, pagos parciales y etiquetas.

## Funciones

- Login local con contrasena cifrada mediante SHA-256 y salt.
- Cambio de contrasena y recuperacion mediante codigo local.
- Inicio con Google preparado mediante Google Identity Services.
- Base de datos IndexedDB en el dispositivo con Dexie.
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

La app es local-first: los datos se guardan en el navegador del dispositivo. No hay servidor externo ni sincronizacion automatica entre moviles. Usa la opcion de exportar JSON para hacer copias de seguridad.

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

## Desarrollo

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
```
