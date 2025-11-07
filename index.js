// index.js
require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');
const basicAuth = require('express-basic-auth');
const cors = require('cors');
const sessionManager = require('./sessionManager');
const logger = require('./logger');

const app = express();
const server = http.createServer(app);

// --- CONFIGURACIÓN CORS PARA SOCKET.IO ---
const io = new Server(server, {
  cors: {
    origin: true, // Permite cualquier origen y lo refleja (necesario para credentials)
    methods: ["GET", "POST"],
    credentials: true
  }
});

const PORT = process.env.PORT || 3000;

// --- Verificación de Secretos ---
if (!process.env.MASTER_KEY || !process.env.PANEL_USER || !process.env.PANEL_PASSWORD) {
  console.error('ERROR FATAL: Faltan variables de entorno en .env');
  process.exit(1);
}

logger.setSocket(io);

// --- Middleware Globales ---
app.use(express.json());
app.use(cors({
  origin: true,
  credentials: true
}));

// --- 1. Middleware de Seguridad para la API REST ---
const masterKeyAuth = (req, res, next) => {
  const providedKey = req.headers['x-api-key'];
  if (!providedKey || providedKey !== process.env.MASTER_KEY) {
    return res.status(401).json({ success: false, error: 'No autorizado' });
  }
  next();
};

// --- 2. Middleware de Seguridad para el Panel Web (Navegador) ---
const panelAuth = basicAuth({
  users: { [process.env.PANEL_USER]: process.env.PANEL_PASSWORD },
  challenge: true,
  realm: 'PanelDeControl',
});

// --- Servir la Interfaz Web ---
app.get('/', panelAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// --- API Endpoints ---
const apiRouter = express.Router();
apiRouter.use(masterKeyAuth);

apiRouter.post('/create-session', async (req, res) => {
  try {
    const apiKey = crypto.randomBytes(20).toString('hex');
    logger.info('System', `Solicitud de creación para nueva apiKey: ${apiKey}`);
    await sessionManager.startSession(apiKey, io, 0);
    res.status(202).json({ success: true, apiKey, message: 'Solicitud de sesión encolada.' });
  } catch (error) {
    logger.error('System', 'Error al crear sesión', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

apiRouter.post('/sessions/restart/:apiKey', async (req, res) => {
  try {
    logger.info(req.params.apiKey, 'Solicitud de reinicio manual recibida.');
    await sessionManager.restartSession(req.params.apiKey, io);
    res.status(200).json({ success: true, message: 'Reiniciando sesión...' });
  } catch (error) {
    logger.error(req.params.apiKey, 'Error al reiniciar sesión', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

apiRouter.get('/session-status/:apiKey', (req, res) => {
  const session = sessionManager.getSession(req.params.apiKey);
  if (!session) return res.status(404).json({ success: false, error: 'Sesión no encontrada.' });
  res.status(200).json({
    success: true,
    status: session.status,
    qr: session.status === 'scantime' ? session.qr : null,
    connectionReady: session.status === 'connected',
  });
});

apiRouter.delete('/close-session/:apiKey', async (req, res) => {
  try {
    const result = await sessionManager.deleteSession(req.params.apiKey, io);
    res.status(200).json(result);
  } catch (error) {
    logger.error(req.params.apiKey, 'Error al cerrar sesión', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

const checkSession = (req, res, next) => {
  const session = sessionManager.getSession(req.params.apiKey);
  if (!session || session.status !== 'connected') {
    return res.status(409).json({ success: false, error: 'Sesión no conectada.', status: session?.status || 'notFound' });
  }
  req.session = session;
  next();
};

// --- Rutas de envío ---
apiRouter.post('/send-message/:apiKey', checkSession, async (req, res) => {
  const { number, message } = req.body;
  if (!number || !message) return res.status(400).json({ success: false, error: 'Faltan datos.' });
  try {
    const tracking_id = crypto.randomUUID();
    sessionManager.sendTrackedMessage(req.params.apiKey, number, message, tracking_id, io);
    res.status(202).json({ success: true, message: 'Mensaje encolado.', tracking_id });
  } catch (error) {
    logger.error(req.params.apiKey, 'Error en /send-message', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

apiRouter.post('/send-pdf/:apiKey', checkSession, async (req, res) => {
  const { number, url, caption } = req.body;
  if (!number || !url) return res.status(400).json({ success: false, error: 'Faltan datos.' });
  try {
    const tracking_id = crypto.randomUUID();
    sessionManager.sendTrackedMedia(req.params.apiKey, number, url, caption, 'pdf', tracking_id, io);
    res.status(202).json({ success: true, message: 'PDF encolado.', tracking_id });
  } catch (error) {
    logger.error(req.params.apiKey, 'Error en /send-pdf', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

apiRouter.post('/send-image/:apiKey', checkSession, async (req, res) => {
  const { number, url, caption } = req.body;
  if (!number || !url) return res.status(400).json({ success: false, error: 'Faltan datos.' });
  try {
    const tracking_id = crypto.randomUUID();
    sessionManager.sendTrackedMedia(req.params.apiKey, number, url, caption, 'image', tracking_id, io);
    res.status(202).json({ success: true, message: 'Imagen encolada.', tracking_id });
  } catch (error) {
    logger.error(req.params.apiKey, 'Error en /send-image', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.use('/api', apiRouter);

// --- Lógica de Autenticación Socket.io (ROBUSTA - SIN CRASH) ---
io.use((socket, next) => {
  const auth = socket.handshake.auth;
  // 1. Revisar si el cliente envió credenciales explícitas (como hace tu CRM)
  if (auth && auth.username === process.env.PANEL_USER && auth.password === process.env.PANEL_PASSWORD) {
    return next();
  }
  
  // 2. Revisar si el navegador envió la cabecera estándar Basic Auth
  const header = socket.handshake.headers.authorization;
  if (header && header.startsWith('Basic ')) {
    const parts = Buffer.from(header.split(' ')[1], 'base64').toString().split(':');
    if (parts[0] === process.env.PANEL_USER && parts[1] === process.env.PANEL_PASSWORD) {
        return next();
    }
  }

  // Si falla, rechazamos sin intentar usar 'res' (evita el crash TypeError)
  next(new Error("Authentication error"));
});

io.on('connection', (socket) => {
  // logger.info('System', 'Cliente conectado al socket.');
  socket.emit('log_history', logger.getHistory());
  socket.emit('initial_status', sessionManager.getAllSessionStatuses());
});

// --- Iniciar Servidor ---
server.listen(PORT, () => {
  logger.info('System', `Servidor API V8 (PROD) iniciado en http://localhost:${PORT}`);
  sessionManager.loadExistingSessions(io);
});