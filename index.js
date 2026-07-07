if (!globalThis.crypto) globalThis.crypto = require('crypto').webcrypto;
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestWaWebVersion
} = require('@whiskeysockets/baileys');
const axios = require('axios');
const QRCode = require('qrcode');

const WP_API = process.env.WP_API_URL || 'https://jobayergroup.com/wp-json/ai-router/v1/webhook';
const MAX_RECONNECT_DELAY = 300000;
let reconnectAttempts = 0;

function getDelay() {
  reconnectAttempts++;
  const d = Math.min(1000 * Math.pow(2, reconnectAttempts), MAX_RECONNECT_DELAY);
  console.log(`Reconnecting in ${Math.round(d / 1000)}s (attempt ${reconnectAttempts})...`);
  return d;
}

async function startBot() {
  console.log('Starting WhatsApp AI Bridge...');

  const { state, saveCreds } = await useMultiFileAuthState('auth_info');
  let version;
  try {
    const v = await fetchLatestWaWebVersion();
    version = v.version;
    console.log(`Using WhatsApp Web version: ${version.join('.')}`);
  } catch (e) {
    version = [2, 3000, 1033893291];
    console.log(`Version fetch failed, using fallback: ${version.join('.')}`);
  }

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
      console.log('\n=== SCAN THIS QR CODE WITH WHATSAPP ===');
      try {
        const qrTerminal = await QRCode.toString(qr, { type: 'terminal', small: true });
        console.log(qrTerminal);
        const qrDataUrl = await QRCode.toDataURL(qr, { width: 400, margin: 2 });
        console.log('🔗 Open this link in browser to see QR (scan with WhatsApp):');
        console.log(qrDataUrl);
      } catch (e) {
        console.log('QR data:', qr);
      }
      console.log('========================================\n');
    }

    if (connection === 'open') {
      reconnectAttempts = 0;
      console.log('WhatsApp connected successfully!');
    }

    if (connection === 'close') {
      const reason = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = reason !== DisconnectReason.loggedOut;
      console.log(`Disconnected (reason: ${reason}). Reconnecting: ${shouldReconnect}`);
      if (shouldReconnect) {
        setTimeout(() => startBot(), getDelay());
      } else {
        console.log('Logged out. Delete auth_info folder and restart to re-pair.');
        process.exit(1);
      }
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
        const reply = res.data?.reply || 'Sorry, I could not process that.';
        await sock.sendMessage(from, { text: reply });
        console.log(`[OUT] ${from}: ${reply.slice(0, 80)}`);
      } catch (err) {
        const errMsg = err.response?.data?.message || err.message || 'Unknown error';
        console.error(`[ERR] ${from}: ${errMsg}`);
        try {
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

startBot().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
