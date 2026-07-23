# Cuentas claras

PWA para controlar quien te debe dinero, a quien debes, gastos compartidos, pagos parciales y etiquetas.

## Funciones

- Login local con contraseña cifrada mediante SHA-256 y salt.
- Base de datos IndexedDB en el dispositivo con Dexie.
- Personas con telefono, email y notas.
- Gastos divididos entre varias personas, con reparto igual o importes manuales.
- Deudas directas: "me debe" y "le debo".
- Pagos: "me ha pagado" y "le he pagado".
- Estados: por pagar, parcial y pagado.
- Etiquetas, notas, busqueda, borrado, importacion y exportacion JSON.
- Instalable en iPhone desde Safari con "Añadir a pantalla de inicio".

## Privacidad

La app es local-first: los datos se guardan en el navegador del dispositivo. No hay servidor externo ni sincronizacion automatica entre moviles. Usa la opcion de exportar JSON para hacer copias de seguridad.

## Desarrollo

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
```
