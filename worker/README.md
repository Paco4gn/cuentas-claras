# CazaMorosos Push Relay

Relay gratuito para avisos push en iPhone cuando alguien confirma que ha pagado.

## Despliegue

1. Inicia sesion en Cloudflare:

```bash
npx wrangler login
```

2. Carga los secretos desde la clave privada de Firebase:

```powershell
.\scripts\set-cloudflare-push-secrets.ps1 -ServiceAccountJson "C:\ruta\a\cuentas-claras-paco4gn-firebase-adminsdk.json"
```

3. Despliega el Worker:

```bash
cd worker
npx wrangler deploy
```

4. Copia la URL que devuelve Wrangler y ponla en `.env.production`:

```bash
VITE_PUSH_RELAY_URL=https://cazamorosos-push-relay.<tu-subdominio>.workers.dev
```

5. Reconstruye y publica GitHub Pages.

El JSON de Firebase no debe subirse nunca al repositorio.
