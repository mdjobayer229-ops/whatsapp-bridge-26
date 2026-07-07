if (!globalThis.crypto) globalThis.crypto = require('crypto').webcrypto;
const http = require('http');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason
} = require('@whiskeysockets/baileys');
const axios = require('axios');
const QRCode = require('qrcode');

const WP_API = process.env.WP_API_URL || 'https://jobayergroup.com/wp-json/ai-router/v1/webhook';
const PHONE = process.env.WHATSAPP_PHONE || '880130585531';
const AUTH_DIR = process.env.AUTH_DIR || 'auth_info';
const MAX_RECONNECT_DELAY = 300000;
let reconnectAttempts = 0;
let pairingRequested = false;
let qrBuffer = null;
let bridgeConnected = false;

function getDelay() {
  reconnectAttempts++;
  const d = Math.min(1000 * Math.pow(2, reconnectAttempts), MAX_RECONNECT_DELAY);
  console.log(`Reconnecting in ${Math.round(d / 1000)}s (attempt ${reconnectAttempts})...`);
  return d;
}

function startServer() {
  const port = process.env.PORT || 8080;
  http.createServer((req, res) => {
    if (req.url === '/qr' && qrBuffer) {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache' });
      res.end(qrBuffer);
    } else if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ connected: bridgeConnected }));
    } else if (req.url === '/clear-pairing' && req.method === 'POST') {
      pairingRequested = false;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>WhatsApp AI Bridge</title>
<style>body{font-family:sans-serif;text-align:center;padding:40px;background:#f5f5f5;margin:0}
h1{color:#075e54;font-size:28px}img{max-width:100%;width:400px;border-radius:12px;box-shadow:0 4px 20px rgba(0,0,0,.15);margin:20px 0}
.status{font-size:20px;margin:15px 0;padding:10px 20px;border-radius:8px;display:inline-block}
.connected{background:#e8f5e9;color:#2e7d32;border:1px solid #a5d6a7}
.waiting{background:#fff3e0;color:#e65100;border:1px solid #ffcc80}
.instructions{background:#fff;border-radius:12px;padding:24px;margin:20px auto;max-width:460px;text-align:left;box-shadow:0 2px 10px rgba(0,0,0,.08)}
.instructions ol{margin:8px 0 0 20px;line-height:1.8}
.small{color:#888;font-size:13px;margin-top:30px}
</style></head><body>
<h1>WhatsApp AI Bridge</h1>
<p class="status ${bridgeConnected?'connected':'waiting'}">${bridgeConnected?'✅ Connected':'⏳ Waiting for QR scan...'}</p>
${bridgeConnected ? '<p>The bridge is active and running 24/7.</p>' :
 qrBuffer ? '<img src="/qr" alt="QR Code"><p>Scan this QR code with WhatsApp to connect</p><p class="small">QR refreshes automatically if it expires</p>' :
 '<p>Generating QR code... Please refresh in a few seconds.</p>'}
${!bridgeConnected ? '<div class="instructions"><strong>How to connect:</strong><ol><li>Open WhatsApp on your phone</li><li>Tap <strong>⋮ → Linked devices → Link a device</strong></li><li>Scan the QR code above with your phone</li><li>Done! The bridge will be active 24/7</li></ol></div>' : ''}
<p class="small">WhatsApp AI Bridge &mdash; jobayergroup.com</p>
</body></html>`);
    }
  }).listen(port, () => {
    console.log(`\n🌐 Web UI: http://localhost:${port}`);
    console.log(`📱 Open Railway Dashboard → Settings → Public Networking → Generate Domain`);
    console.log(`   Then open that URL in your browser to scan QR.\n`);
  });
}

async function startBot() {
  console.log('Starting WhatsApp AI Bridge...');

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const version = [2, 3000, 1033893291];
  console.log(`Using WhatsApp Web version: ${version.join('.')}`);

  const sock = makeWASocket({
    version: version,
    auth: state,
    browser: ['Chrome', 'macOS', '10.15.7'],
    printQRInTerminal: false,
    defaultQueryTimeoutMs: 60000,
    logger: require('pino')({ level: 'warn' }),
    connectTimeoutMs: 60000,
    keepAliveIntervalMs: 25000,
    markOnlineOnConnect: false,
    emitOwnEvents: true,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      reconnectAttempts = 0;
      bridgeConnected = false;
      try {
        qrBuffer = await QRCode.toBuffer(qr, { width: 400, margin: 2, type: 'png' });
        console.log('\n✅ QR code generated. Open Railway URL in browser to scan.\n');
      } catch (_) {
        console.log('QR buffer failed');
      }
      if (!pairingRequested) {
        pairingRequested = true;
        try {
          const code = await sock.requestPairingCode(PHONE);
          console.log(`📱 Pairing Code (backup): ${code}\n`);
        } catch (_) {}
      }
    }

    if (connection === 'open') {
      reconnectAttempts = 0;
      bridgeConnected = true;
      pairingRequested = false;
      qrBuffer = null;
      console.log('WhatsApp connected successfully!');
    }

    if (connection === 'close') {
      const reason = lastDisconnect?.error?.output?.statusCode;
      if (reason === DisconnectReason.loggedOut) {
        console.log('Logged out. Clearing auth_info and generating fresh QR...');
        try { require('fs').rmSync(AUTH_DIR, { recursive: true, force: true }); } catch (_) {}
        pairingRequested = false;
        qrBuffer = null;
        return setTimeout(() => startBot(), 1000);
      }
      console.log(`Disconnected (reason: ${reason}). Reconnecting...`);
      setTimeout(() => startBot(), getDelay());
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      if (!msg.message || msg.message.protocolMessage) continue;
      const text = msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || '';
      if (!text.trim()) continue;
      const from = msg.key.remoteJid;
      const sender = msg.pushName || from.split('@')[0];
      console.log(`[IN] ${sender} (${from}): ${text.slice(0, 80)}`);
      try {
        const res = await axios.post(WP_API, {
          message: text,
          from: from,
          conversation_id: from,
          sender: sender
        }, { timeout: 30000 });
        const reply = res.data?.reply || res.data?.message || 'Sorry, I could not process that.';
        const typingMs = Math.min(4000, Math.max(1500, reply.length * 50));
        const delay = Math.round(typingMs * (0.7 + Math.random() * 0.6));
        await sock.sendPresenceUpdate('composing', from);
        await new Promise(r => setTimeout(r, delay));
        await sock.sendMessage(from, { text: reply });
        console.log(`[OUT] ${from}: ${reply.slice(0, 80)}`);
      } catch (err) {
        const errMsg = err.response?.data?.message || err.message || 'Unknown error';
        console.error(`[ERR] ${from}: ${errMsg}`);
        try {
          await sock.sendPresenceUpdate('composing', from);
          await new Promise(r => setTimeout(r, 1200 + Math.round(Math.random() * 800)));
          await sock.sendMessage(from, {
            text: 'Sorry, I am having trouble connecting to my brain. Please try again in a moment.'
          });
        } catch (sendErr) {
          console.error('Failed to send error message:', sendErr.message);
        }
      }
    }
  });

  setInterval(() => {
    if (sock?.ws?.readyState === 1) {
      console.log('Heartbeat OK, connected:', !!sock.user);
    }
  }, 60000);
}

startServer();
startBot().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
