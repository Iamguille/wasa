// sessionManager.js
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const { default: PQueue } = require('p-queue');
const path = require('path');
const fs = require('fs');
const { Boom } = require('@hapi/boom');
const logger = require('./logger');
const pino = require('pino');

const SESSIONS_DIR = path.join(__dirname, 'sessions');
const activeSessions = new Map();
const MAX_RETRIES = 3;

const baileysConfig = {
  printQRInTerminal: false,
  logger: pino({ level: 'silent' }), 
  browser: ['API-V8-Prod', 'Chrome', '1.0.0'],
  syncFullHistory: false,
  getMessage: () => undefined,
};

function clearKeepAlive(apiKey) {
  const session = activeSessions.get(apiKey);
  if (session?.keepAlive) {
    clearInterval(session.keepAlive);
  }
}

function getSession(apiKey) {
  return activeSessions.get(apiKey);
}

function deleteSessionFolder(apiKey) {
  const sessionDir = path.join(SESSIONS_DIR, apiKey);
  if (fs.existsSync(sessionDir)) {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
}

async function restartSession(apiKey, io) {
  logger.info(apiKey, 'Forzando reinicio de sesión...');
  const session = activeSessions.get(apiKey);
  if (session) {
    clearKeepAlive(apiKey);
    try {
      if (session.client) await session.client.logout();
    } catch (e) {}
    activeSessions.delete(apiKey);
  }
  deleteSessionFolder(apiKey);
  setTimeout(() => startSession(apiKey, io, 0), 1000);
}

async function startSession(apiKey, io, retryCount = 0) {
  if (activeSessions.has(apiKey)) {
    const existingSession = activeSessions.get(apiKey);
    if (existingSession.status === 'connected' || existingSession.status === 'scantime') {
      logger.warn(apiKey, 'Intento de iniciar sesión que ya está activa.');
      return;
    }
  }

  if (retryCount > MAX_RETRIES) {
    logger.error(apiKey, `Conexión fallida después de ${MAX_RETRIES} intentos. La sesión se rinde.`);
    activeSessions.set(apiKey, { status: 'failed' }); // Sesión muerta
    io.emit('session_update', { apiKey, status: 'failed' });
    return;
  }
  
  if (retryCount > 0) {
    logger.info(apiKey, `Reintento de conexión ${retryCount}/${MAX_RETRIES}...`);
  } else {
    logger.info(apiKey, 'Iniciando sesión...');
  }

  const sessionDir = path.join(SESSIONS_DIR, apiKey);
  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    ...baileysConfig,
  });

  const sessionData = {
    client: sock,
    status: 'connecting',
    qr: null,
    keepAlive: null,
    retries: retryCount,
    queue: new PQueue({ concurrency: 1, interval: 2000, intervalCap: 1 })
  };
  activeSessions.set(apiKey, sessionData);

  sock.ev.on('creds.update', async () => {
    try {
      await saveCreds();
    } catch (e) {
      logger.error(apiKey, 'Error al guardar credenciales', e);
    }
  });

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    const currentSession = activeSessions.get(apiKey);
    if (!currentSession) return;

    if (qr) {
      currentSession.qr = qr;
      currentSession.status = 'scantime';
      io.emit('session_update', { apiKey, status: 'scantime', qr });
      logger.info(apiKey, 'QR generado. Esperando escaneo.');
      currentSession.retries = 0;
    }

    if (connection === 'open') {
      currentSession.status = 'connected';
      currentSession.qr = null;
      currentSession.retries = 0;
      io.emit('session_update', { apiKey, status: 'connected' });
      logger.info(apiKey, '¡Sesión conectada exitosamente!');
      
      currentSession.keepAlive = setInterval(() => {
        sock.sendPresenceUpdate('available', '');
      }, 25000);
    
    } else if (connection === 'close') {
      clearKeepAlive(apiKey);
      const boomError = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const isLoggedOut = boomError === DisconnectReason.loggedOut;
      
      activeSessions.delete(apiKey);

      if (isLoggedOut) {
        currentSession.status = 'loggedOut';
        io.emit('session_update', { apiKey, status: 'loggedOut' });
        deleteSessionFolder(apiKey);
        logger.error(apiKey, 'Sesión cerrada (loggedOut). Requiere nuevo escaneo.');
        activeSessions.set(apiKey, currentSession); 
      } else {
        const nextRetryCount = currentSession.retries + 1;
        io.emit('session_update', { apiKey, status: 'disconnected' });
        logger.warn(apiKey, `Conexión perdida (Razón: ${boomError}). Reintentando en 10s...`);
        setTimeout(() => startSession(apiKey, io, nextRetryCount), 10000);
      }
    }
  });
}

async function deleteSession(apiKey, io) {
  logger.info(apiKey, 'Cerrando y eliminando sesión...');
  clearKeepAlive(apiKey);
  const session = activeSessions.get(apiKey);
  if (session) {
    try {
      await session.client.logout();
    } catch (e) {
      logger.error(apiKey, 'Error al hacer logout', e);
    }
  }
  activeSessions.delete(apiKey);
  deleteSessionFolder(apiKey);
  io.emit('session_update', { apiKey, status: 'deleted' });
  logger.info(apiKey, 'Sesión eliminada.');
  return { success: true };
}

// --- FUNCIONES DE ENVÍO CON "TRACKING ID" ---

async function sendTrackedMessage(apiKey, number, message, tracking_id, io) {
  const session = getSession(apiKey);
  if (!session || session.status !== 'connected') {
    throw new Error('Sesión no conectada.');
  }
  logger.info(apiKey, `Encolando mensaje [${tracking_id}] para: ${number}`);
  
  return session.queue.add(async () => {
    try {
      const formattedNumber = number.includes('@') ? number : `${number}@s.whatsapp.net`;
      await session.client.sendMessage(formattedNumber, { text: message });
      logger.info(apiKey, `Mensaje [${tracking_id}] enviado a: ${number}`);
      // --- EMITE EL ÉXITO ---
      io.emit('message_status_update', { tracking_id, status: 'SUCCESS' });
    } catch (e) {
      logger.error(apiKey, `Error al enviar [${tracking_id}] a ${number}`, e);
      // --- EMITE EL FALLO ---
      io.emit('message_status_update', { tracking_id, status: 'FAILED', error: e.message });
    }
  });
}

async function sendTrackedMedia(apiKey, number, url, caption, type, tracking_id, io) {
  const session = getSession(apiKey);
  if (!session || session.status !== 'connected') {
    throw new Error('Sesión no conectada.');
  }
  logger.info(apiKey, `Encolando media [${tracking_id}] para: ${number}`);

  return session.queue.add(async () => {
    try {
      const formattedNumber = number.includes('@') ? number : `${number}@s.whatsapp.net`;
      let messagePayload;
      if (type === 'image') messagePayload = { image: { url }, caption };
      else if (type === 'pdf') messagePayload = { document: { url }, mimetype: 'application/pdf', caption };
      else throw new Error('Tipo de medio no soportado');
      
      await session.client.sendMessage(formattedNumber, messagePayload);
      logger.info(apiKey, `Media [${tracking_id}] enviada a: ${number}`);
      // --- EMITE EL ÉXITO ---
      io.emit('message_status_update', { tracking_id, status: 'SUCCESS' });
    } catch (e) {
      logger.error(apiKey, `Error al enviar media [${tracking_id}] a ${number}`, e);
      // --- EMITE EL FALLO ---
      io.emit('message_status_update', { tracking_id, status: 'FAILED', error: e.message });
    }
  });
}

function loadExistingSessions(io) {
  if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR);
  const sessionFolders = fs.readdirSync(SESSIONS_DIR);
  if (sessionFolders.length > 0) {
    logger.info('System', `Se encontraron ${sessionFolders.length} sesiones. Cargando...`);
  }
  for (const apiKey of sessionFolders) {
    if (fs.existsSync(path.join(SESSIONS_DIR, apiKey, 'creds.json'))) {
      logger.info(apiKey, 'Cargando sesión existente...');
      startSession(apiKey, io, 0);
    }
  }
}

function getAllSessionStatuses() {
  const statuses = [];
  if (fs.existsSync(SESSIONS_DIR)) {
    const sessionFolders = fs.readdirSync(SESSIONS_DIR);
    for (const apiKey of sessionFolders) {
      if (!activeSessions.has(apiKey)) {
        statuses.push({ apiKey, status: 'failed', qr: null });
      }
    }
  }
  activeSessions.forEach((session, apiKey) => {
    statuses.push({ apiKey, status: session.status, qr: session.status === 'scantime' ? session.qr : null });
  });
  return statuses;
}

module.exports = {
  startSession,
  restartSession,
  deleteSession,
  getSession,
  getAllSessionStatuses,
  sendTrackedMessage,
  sendTrackedMedia,
  loadExistingSessions // <-- ¡LA LÍNEA QUE FALTABA!
};