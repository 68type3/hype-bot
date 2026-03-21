# HYPE Trading Bot — Setup Guide

## Archivos necesarios
- `bot.js` — el bot
- `package.json` — configuración Node.js

## Paso 1: Kraken API Key
1. Ve a kraken.com → Security → API
2. Click "Generate New Key"
3. Nombre: "HYPE Bot"
4. Permisos: ✅ Query Funds, ✅ Create & Modify Orders
5. ⛔ NO actives: Withdraw Funds
6. Guarda: API Key y Private Key (API Secret)

## Paso 2: Telegram Bot
1. Abre Telegram → busca @BotFather
2. Escribe: /newbot
3. Nombre: "HYPE Trading Bot"
4. Username: hypetradingbot_tuusuario
5. Guarda el TOKEN que te da
6. Abre tu nuevo bot → escribe /start
7. Para obtener tu Chat ID:
   - Busca @userinfobot en Telegram
   - Escribe /start → te da tu ID numérico

## Paso 3: Deploy en Railway
1. Ve a railway.app → New Project
2. Deploy from GitHub repo (o sube los archivos)
3. En Settings → Variables, agrega:

   KRAKEN_API_KEY     = tu_api_key_de_kraken
   KRAKEN_API_SECRET  = tu_api_secret_de_kraken
   TELEGRAM_TOKEN     = tu_token_de_telegram
   TELEGRAM_CHAT_ID   = tu_chat_id_numerico

4. Railway detecta package.json y ejecuta `node bot.js` automáticamente

## Paso 4: Verificar
El bot te mandará a Telegram:
- Mensaje de inicio con balances
- Cada COMPRA/VENTA ejecutada con precio y P&L
- Status cada hora
- Cualquier error

## Estrategia del bot
- Revisa señales cada 60 segundos
- Requiere 2 confirmaciones antes de ejecutar (evita ruido)
- COMPRAR: usa 99% del USD disponible
- VENDER: vende todo el HYPE disponible
- Cada ciclo exitoso acumulas más HYPE

## Seguridad
- El bot NO tiene permisos de retiro
- Pérdida máxima = tu balance actual en Kraken
- Para detener: pausa el servicio en Railway
