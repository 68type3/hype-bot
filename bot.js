// ── HYPE Trading Bot ─────────────────────────────────────────────────────────
// Runs 24/7 on Railway.app
// Strategy: Buy/Sell HYPE on Kraken spot using TA signals
// Notifications via Telegram
// ─────────────────────────────────────────────────────────────────────────────

const https = require('https');
const crypto = require('crypto');

// ── Config (set as Railway environment variables) ─────────────────────────────
const CONFIG = {
  KRAKEN_KEY:    process.env.KRAKEN_API_KEY    || '',
  KRAKEN_SECRET: process.env.KRAKEN_API_SECRET || '',
  TELEGRAM_TOKEN:process.env.TELEGRAM_TOKEN    || '',
  TELEGRAM_CHAT: process.env.TELEGRAM_CHAT_ID  || '',
  PAIR:          'HYPEUSD',
  MIN_ORDER_USD: 5,       // min USD to trade (Kraken minimum)
  CHECK_INTERVAL:60000,   // check every 60 seconds
  SIGNAL_CONFIRM:2,       // require same signal N times before trading
};

// ── State ─────────────────────────────────────────────────────────────────────
let state = {
  closes: [],
  lastSignal: null,
  signalCount: 0,
  position: 'none',   // 'long' or 'none'
  hypeBalance: 0,
  usdBalance: 0,
  trades: [],
  startTime: Date.now(),
  totalPnl: 0,
};

// ── Utilities ─────────────────────────────────────────────────────────────────
function log(msg) {
  const t = new Date().toLocaleTimeString('es');
  console.log(`[${t}] ${msg}`);
}

function httpsRequest(options, body='') {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { resolve(data); }
      });
    });
    req.on('error', reject);
    if(body) req.write(body);
    req.end();
  });
}

// ── Telegram ──────────────────────────────────────────────────────────────────
async function telegram(msg) {
  if(!CONFIG.TELEGRAM_TOKEN || !CONFIG.TELEGRAM_CHAT) return;
  try {
    const body = JSON.stringify({ chat_id: CONFIG.TELEGRAM_CHAT, text: msg, parse_mode: 'HTML' });
    await httpsRequest({
      hostname: 'api.telegram.org',
      path: `/bot${CONFIG.TELEGRAM_TOKEN}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, body);
  } catch(e) { log('Telegram error: ' + e.message); }
}

// ── Kraken API ────────────────────────────────────────────────────────────────
function krakenSign(path, nonce, postData) {
  const secret = Buffer.from(CONFIG.KRAKEN_SECRET, 'base64');
  const hash = crypto.createHash('sha256').update(nonce + postData).digest('binary');
  const hmac = crypto.createHmac('sha512', secret).update(path + hash, 'binary').digest('base64');
  return hmac;
}

async function krakenPrivate(method, params={}) {
  const nonce = Date.now().toString();
  params.nonce = nonce;
  const postData = new URLSearchParams(params).toString();
  const path = `/0/private/${method}`;
  const signature = krakenSign(path, nonce, postData);
  const res = await httpsRequest({
    hostname: 'api.kraken.com',
    path, method: 'POST',
    headers: {
      'API-Key': CONFIG.KRAKEN_KEY,
      'API-Sign': signature,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(postData)
    }
  }, postData);
  if(res.error && res.error.length) throw new Error(res.error.join(', '));
  return res.result;
}

async function krakenPublic(method, params={}) {
  const query = new URLSearchParams(params).toString();
  const path = `/0/public/${method}${query ? '?'+query : ''}`;
  const res = await httpsRequest({ hostname: 'api.kraken.com', path, method: 'GET' });
  if(res.error && res.error.length) throw new Error(res.error.join(', '));
  return res.result;
}

async function getBalances() {
  const bal = await krakenPrivate('Balance');
  state.hypeBalance = parseFloat(bal['HYPE'] || bal['XBT'] || 0);
  // Find USD balance
  state.usdBalance = parseFloat(bal['ZUSD'] || bal['USD'] || 0);
  return { hype: state.hypeBalance, usd: state.usdBalance };
}

async function getPrice() {
  const t = await krakenPublic('Ticker', { pair: CONFIG.PAIR });
  const data = Object.values(t)[0];
  return parseFloat(data.c[0]);
}

async function getOHLC() {
  const data = await krakenPublic('OHLC', { pair: CONFIG.PAIR, interval: 60, count: 60 });
  const candles = Object.values(data).find(v => Array.isArray(v)) || [];
  return candles.map(c => parseFloat(c[4])); // close prices
}

async function placeMarketBuy(usdAmount) {
  const price = await getPrice();
  const volume = (usdAmount / price).toFixed(4);
  log(`Placing BUY order: ${volume} HYPE @ ~$${price}`);
  const result = await krakenPrivate('AddOrder', {
    pair: CONFIG.PAIR,
    type: 'buy',
    ordertype: 'market',
    volume,
  });
  return { volume: parseFloat(volume), price, txid: result.txid };
}

async function placeMarketSell(volume) {
  const price = await getPrice();
  log(`Placing SELL order: ${volume} HYPE @ ~$${price}`);
  const result = await krakenPrivate('AddOrder', {
    pair: CONFIG.PAIR,
    type: 'sell',
    ordertype: 'market',
    volume: volume.toFixed(4),
  });
  return { volume, price, txid: result.txid };
}

// ── Technical Analysis ────────────────────────────────────────────────────────
function calcRSI(p, per=14) {
  if(p.length < per+1) return 50;
  let g=0, l=0;
  for(let i=p.length-per; i<p.length; i++) {
    const d = p[i]-p[i-1];
    d>0 ? g+=d : l+=Math.abs(d);
  }
  return parseFloat((100-100/(1+g/(l||.001))).toFixed(1));
}

function calcEMA(p, per) {
  const n=Math.min(per,p.length), k=2/(n+1);
  let e = p.slice(0,n).reduce((a,b)=>a+b)/n;
  for(let i=n; i<p.length; i++) e = p[i]*k + e*(1-k);
  return e;
}

function calcBB(p, per=20) {
  const s = p.slice(-Math.min(per,p.length));
  const m = s.reduce((a,b)=>a+b)/s.length;
  const std = Math.sqrt(s.reduce((a,b)=>a+(b-m)**2,0)/s.length);
  return { upper: m+2*std, lower: m-2*std, mid: m };
}

function detectElliottWave(closes) {
  if(closes.length < 20) return null;
  const p = closes.slice(-40);
  const n = p.length;

  function pivots(arr, window=3) {
    const pts = [];
    for(let i=window; i<arr.length-window; i++) {
      const slice = arr.slice(i-window, i+window+1);
      const mx = Math.max(...slice), mn = Math.min(...slice);
      if(arr[i]===mx) pts.push({i, v:arr[i], type:'H'});
      else if(arr[i]===mn) pts.push({i, v:arr[i], type:'L'});
    }
    return pts;
  }

  const pts = pivots(p, 3);
  if(pts.length < 5) return { wave:'?', bias:'neu', confidence:0 };

  const last5 = pts.slice(-5);
  const lastPivot = pts[pts.length-1];
  const types = last5.map(p=>p.type).join('');
  const vals  = last5.map(p=>p.v);

  let wave='?', label='', confidence=0, bias='neu', target=null, invalidation=null;

  if(types==='LHLHL') {
    const higherHighs = vals[2]>vals[0] && vals[4]>vals[2];
    const higherLows  = vals[3]>vals[1];
    if(higherHighs && higherLows) {
      wave='5'; label='Onda 5 Alcista'; confidence=85; bias='bull';
      target=vals[4]+(vals[4]-vals[3])*0.618; invalidation=vals[3];
    } else if(higherLows) {
      wave='3'; label='Onda 3 Alcista'; confidence=75; bias='bull';
      target=vals[2]+(vals[2]-vals[1])*1.618; invalidation=vals[1];
    } else {
      wave='1'; label='Onda 1 — inicio impulso'; confidence=60; bias='bull';
      target=vals[0]+(vals[4]-vals[3])*1.0; invalidation=vals[1];
    }
  } else if(types==='HLHLH') {
    const lowerLows  = vals[2]<vals[0] && vals[4]<vals[2];
    const lowerHighs = vals[3]<vals[1];
    if(lowerLows && lowerHighs) {
      wave='5↓'; label='Onda 5 Bajista'; confidence=80; bias='bear';
      target=vals[4]-(vals[3]-vals[4])*0.618; invalidation=vals[3];
    } else {
      wave='3↓'; label='Onda 3 Bajista'; confidence=70; bias='bear';
      target=vals[4]-(vals[2]-vals[4])*0.618; invalidation=vals[1];
    }
  } else if(types==='HLH'||types==='HLHL') {
    wave='C↓'; label='Onda C rebote próximo'; confidence=65; bias='bull';
    target=lastPivot.v*1.05; invalidation=lastPivot.v*0.97;
  } else if(types==='LHL'||types==='LHLH') {
    wave='C'; label='Onda C correctiva'; confidence=65; bias='bear';
    invalidation=lastPivot.v;
  } else {
    if(lastPivot.type==='L' && p[n-1]>lastPivot.v) {
      wave='2/4'; label='Retroceso alcista'; confidence=55; bias='bull'; invalidation=lastPivot.v;
    } else if(lastPivot.type==='H' && p[n-1]<lastPivot.v) {
      wave='2/4↓'; label='Retroceso bajista'; confidence=50; bias='bear'; invalidation=lastPivot.v;
    }
  }
  return { wave, label, confidence, bias, target, invalidation, lastPivot: lastPivot.v };
}

function runTA(closes, price, ch24) {
  if(closes.length < 10) return null;
  const r   = calcRSI(closes);
  const e20 = calcEMA(closes, 20);
  const b   = calcBB(closes);
  const macd = calcEMA(closes, Math.min(12,closes.length)) - calcEMA(closes, Math.min(26,closes.length));
  const ew  = detectElliottWave(closes);

  const ewBullish = ew && ew.bias==='bull' && ew.confidence>=60;
  const ewBearish = ew && ew.bias==='bear' && ew.confidence>=60;

  let sc = 0;
  const rsiBullThresh = ewBullish ? 40 : 45;
  const rsiBearThresh = ewBearish ? 60 : 55;

  if(r < rsiBullThresh) sc+=2;
  else if(r > rsiBearThresh) sc-=2;

  if(macd > 0) sc+=2; else sc-=2;
  if(price >= e20) sc+=2; else sc-=2;
  if(price < b.mid) sc+=1; else sc-=1;
  if(ch24 > 1) sc+=2; else if(ch24 < -1) sc-=2;

  if(ew) {
    const w = ew.wave;
    if(ew.bias==='bull') {
      if((w==='1'||w==='3') && ew.confidence>=60) sc+=3;
      else if(w==='5' && ew.confidence>=80) sc+=2;
      else if(ew.confidence>=65) sc+=2;
      else sc+=1;
    } else if(ew.bias==='bear') {
      if((w==='3↓'||w==='5↓') && ew.confidence>=65) sc-=3;
      else if(ew.confidence>=65) sc-=2;
      else sc-=1;
    }
  }

  sc = Math.max(-5, Math.min(5, sc));
  let action = 'ESPERAR';
  if(sc >= 2) action = 'COMPRAR';
  else if(sc <= -2) action = 'VENDER';

  return { action, score: sc, rsi: r, macd, ema20: e20, bb: b, ew };
}

// ── Trading Logic ─────────────────────────────────────────────────────────────
async function checkAndTrade() {
  try {
    const closes = await getOHLC();
    if(!closes || closes.length < 15) { log('Not enough candles'); return; }

    const price = closes[closes.length-1];
    // Estimate 24h change from first vs last candle
    const ch24 = ((price - closes[0]) / closes[0]) * 100;

    const ta = runTA(closes, price, ch24);
    if(!ta) return;

    const { action, score, rsi, ew } = ta;
    const ewLabel = ew ? `W${ew.wave} ${ew.confidence}%` : '—';

    log(`HYPE $${price.toFixed(2)} | Signal: ${action} (${score>0?'+':''}${score}) | RSI: ${rsi} | EW: ${ewLabel}`);

    // Require same signal N times to avoid noise
    if(action === state.lastSignal) {
      state.signalCount++;
    } else {
      state.lastSignal = action;
      state.signalCount = 1;
    }

    if(state.signalCount < CONFIG.SIGNAL_CONFIRM) {
      log(`Signal ${action} confirmed ${state.signalCount}/${CONFIG.SIGNAL_CONFIRM} — waiting`);
      return;
    }

    // Get current balances
    const bal = await getBalances();
    log(`Balances — HYPE: ${bal.hype.toFixed(4)}, USD: $${bal.usd.toFixed(2)}`);

    // ── BUY signal ──
    if(action === 'COMPRAR' && state.position !== 'long') {
      if(bal.usd < CONFIG.MIN_ORDER_USD) {
        log('Not enough USD to buy');
        await telegram(`⚠️ <b>HYPE Bot</b>\nSeñal COMPRAR pero sin USD suficiente ($${bal.usd.toFixed(2)})`);
        return;
      }
      const useUsd = bal.usd * 0.99; // keep 1% for fees
      const order = await placeMarketBuy(useUsd);
      state.position = 'long';
      state.signalCount = 0;

      const trade = { type:'BUY', price: order.price, volume: order.volume, time: new Date().toISOString(), usdSpent: useUsd };
      state.trades.push(trade);

      const msg = `🟢 <b>HYPE BOT — COMPRA</b>\n\n` +
        `💰 Precio: <b>$${order.price.toFixed(2)}</b>\n` +
        `📦 Cantidad: <b>${order.volume} HYPE</b>\n` +
        `💵 USD usado: <b>$${useUsd.toFixed(2)}</b>\n` +
        `📊 Score: ${score>0?'+':''}${score}/5\n` +
        `📈 RSI: ${rsi}\n` +
        `〰 EW: ${ewLabel}\n` +
        `🕐 ${new Date().toLocaleTimeString('es')}`;
      await telegram(msg);
      log('BUY executed ✓');
    }

    // ── SELL signal ──
    else if(action === 'VENDER' && state.position === 'long') {
      if(bal.hype < 0.001) {
        log('Not enough HYPE to sell');
        state.position = 'none';
        return;
      }

      // Minimum move filter — require 1.5% gain to cover fees (0.52%) + profit
      const lastBuyPrice = [...state.trades].reverse().find(t=>t.type==='BUY')?.price;
      const currentPrice = await getPrice();
      if(lastBuyPrice){
        const movePct = ((currentPrice - lastBuyPrice) / lastBuyPrice) * 100;
        if(movePct < 1.5){
          log(`Skip SELL — move only ${movePct.toFixed(2)}% (min 1.5% required to cover fees)`);
          return;
        }
      }

      const order = await placeMarketSell(bal.hype);
      state.position = 'none';
      state.signalCount = 0;

      // Calculate PnL
      const lastBuy = [...state.trades].reverse().find(t => t.type==='BUY');
      let pnl = 0, pnlPct = 0;
      if(lastBuy) {
        pnl = (order.price - lastBuy.price) * order.volume;
        pnlPct = ((order.price - lastBuy.price) / lastBuy.price) * 100;
        state.totalPnl += pnl;
      }

      const trade = { type:'SELL', price: order.price, volume: order.volume, time: new Date().toISOString(), pnl };
      state.trades.push(trade);

      const pnlEmoji = pnl >= 0 ? '📈' : '📉';
      const msg = `🔴 <b>HYPE BOT — VENTA</b>\n\n` +
        `💰 Precio: <b>$${order.price.toFixed(2)}</b>\n` +
        `📦 Cantidad: <b>${order.volume} HYPE</b>\n` +
        `${pnlEmoji} P&L: <b>${pnl>=0?'+':''}$${pnl.toFixed(2)} (${pnlPct.toFixed(1)}%)</b>\n` +
        `📊 Score: ${score>0?'+':''}${score}/5\n` +
        `📈 RSI: ${rsi}\n` +
        `〰 EW: ${ewLabel}\n` +
        `💼 P&L Total: $${state.totalPnl.toFixed(2)}\n` +
        `🕐 ${new Date().toLocaleTimeString('es')}`;
      await telegram(msg);
      log('SELL executed ✓');
    }

    else {
      log(`Holding — position: ${state.position}, signal: ${action}`);
    }

  } catch(e) {
    log('Error: ' + e.message);
    await telegram(`⚠️ <b>HYPE Bot Error</b>\n${e.message}`);
  }
}

// ── Status report every hour ──────────────────────────────────────────────────
async function sendStatus() {
  try {
    const price = await getPrice();
    const bal = await getBalances();
    const uptime = Math.floor((Date.now()-state.startTime)/1000/60);
    const msg = `📊 <b>HYPE Bot — Status</b>\n\n` +
      `💰 HYPE: <b>$${price.toFixed(2)}</b>\n` +
      `📦 Balance HYPE: ${bal.hype.toFixed(4)}\n` +
      `💵 Balance USD: $${bal.usd.toFixed(2)}\n` +
      `📈 P&L Total: $${state.totalPnl.toFixed(2)}\n` +
      `🔄 Trades: ${state.trades.length}\n` +
      `⏱ Uptime: ${uptime}min\n` +
      `📍 Posición: ${state.position==='long'?'LONG 🟢':'Sin posición ⚪'}`;
    await telegram(msg);
  } catch(e) { log('Status error: '+e.message); }
}

// ── Boot ──────────────────────────────────────────────────────────────────────
async function start() {
  log('HYPE Trading Bot starting...');

  if(!CONFIG.KRAKEN_KEY || !CONFIG.KRAKEN_SECRET) {
    log('ERROR: Missing Kraken API keys. Set KRAKEN_API_KEY and KRAKEN_API_SECRET env vars.');
    process.exit(1);
  }

  await telegram(`🤖 <b>HYPE Bot iniciado</b>\n\nPar: HYPE/USD\nIntervalo: 60s\nConfirmación: ${CONFIG.SIGNAL_CONFIRM} señales\n\nMonitoreando... 👀`);

  // Initial balance check
  try {
    const bal = await getBalances();
    log(`Initial balances — HYPE: ${bal.hype}, USD: $${bal.usd}`);
    if(bal.hype > 0) state.position = 'long';
  } catch(e) {
    log('Balance check failed: '+e.message);
  }

  // Start main loop
  checkAndTrade();
  setInterval(checkAndTrade, CONFIG.CHECK_INTERVAL);

  // Status every hour
  setInterval(sendStatus, 60*60*1000);
}

start();

// Keep-alive server
const http = require('http');
http.createServer((req,res)=>{res.writeHead(200);res.end('OK');}).listen(process.env.PORT||3000);
