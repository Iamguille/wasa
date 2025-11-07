// index.js
require('dotenv').config(); // <-- Carga el .env
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');
const basicAuth = require('express-basic-auth'); // <-- Importa el login
const cors = require('cors'); // <-- NECESARIO PARA PERMITIR OTROS DOMINIOS
const sessionManager = require('./sessionManager');
const logger = require('./logger');

const app = express();
const server = http.createServer(app);

// --- CONFIGURACIÓN CORS PARA SOCKET.IO (ABIERTO A TODOS) ---
const io = new Server(server, {
  cors: {
    origin: "true", // <-- Permite conexión desde CUALQUIER dominio
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 3000;

// --- Verificación de Secretos (Mejor Práctica) ---
if (!process.env.MASTER_KEY || !process.env.PANEL_USER || !process.env.PANEL_PASSWORD) {
  console.error('ERROR FATAL: Faltan variables de entorno (MASTER_KEY, PANEL_USER, PANEL_PASSWORD) en el archivo .env');
  process.exit(1);
}

logger.setSocket(io);

// --- Middleware Globales ---
app.use(express.json());
// Configuración CORS global para todas las rutas de Express (API REST)
app.use(cors()); // <-- Al no poner opciones, permite todo (*) por defecto

// --- 1. Middleware de Seguridad para la API ---
const masterKeyAuth = (req, res, next) => {
  const providedKey = req.headers['x-api-key'];
  if (!providedKey || providedKey !== process.env.MASTER_KEY) {
    logger.warn('System', `Intento de acceso a la API RECHAZADO (Clave: ${providedKey || 'ninguna'})`);
    return res.status(401).json({ success: false, error: 'No autorizado' });
  }
  next();
};

// --- 2. Middleware de Seguridad para el Panel Web (Login) ---
const panelAuth = basicAuth({
  users: { [process.env.PANEL_USER]: process.env.PANEL_PASSWORD },
  challenge: true,
  realm: 'PanelDeControl',
});


// --- Servir la Interfaz Web (Protegida) ---
app.get('/', panelAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// --- API Endpoints (Protegidos y con prefijo /api) ---

// Todas las rutas /api/* requieren la Clave Maestra
const apiRouter = express.Router();
apiRouter.use(masterKeyAuth);

apiRouter.post('/create-session', async (req, res) => {
  try {
    const apiKey = crypto.randomBytes(20).toString('hex');
    logger.info('System', `Solicitud de creación para nueva apiKey: ${apiKey}`);
    await sessionManager.startSession(apiKey, io, 0);
    res.status(202).json({
      success: true,
      apiKey: apiKey,
      message: 'Solicitud de sesión encolada. Consulte el estado.',
    });
  } catch (error) {
    logger.error('System', 'Error al crear sesión', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

apiRouter.post('/sessions/restart/:apiKey', async (req, res) => {
  const { apiKey } = req.params;
  try {
    logger.info(apiKey, 'Solicitud de reinicio manual recibida.');
    await sessionManager.restartSession(apiKey, io);
    res.status(200).json({ success: true, message: 'Reiniciando sesión. Escanee el nuevo QR.' });
  } catch (error) {
    logger.error(apiKey, 'Error al reiniciar sesión', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

apiRouter.get('/session-status/:apiKey', (req, res) => {
  const { apiKey } = req.params;
  const session = sessionManager.getSession(apiKey);
  if (!session) {
    return res.status(404).json({ success: false, error: 'Sesión no encontrada.' });
  }
  res.status(200).json({
    success: true,
    status: session.status,
    qr: session.status === 'scantime' ? session.qr : null,
    connectionReady: session.status === 'connected',
  });
});

apiRouter.delete('/close-session/:apiKey', async (req, res) => {
  const { apiKey } = req.params;
  try {
    const result = await sessionManager.deleteSession(apiKey, io);
    res.status(200).json(result);
  } catch (error) {
    logger.error(apiKey, 'Error al cerrar sesión', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

const checkSession = (req, res, next) => {
  const { apiKey } = req.params;
  const session = sessionManager.getSession(apiKey);
  if (!session || session.status !== 'connected') {
    logger.warn(apiKey, `Intento de envío fallido (Sesión no conectada). Estado: ${session?.status}`);
    return res.status(409).json({
      success: false,
      error: 'La sesión no está conectada.',
      status: session?.status || 'notFound',
    });
  }
  req.session = session;
  next();
};

// --- Rutas de envío con TRACKING_ID ---

apiRouter.post('/send-message/:apiKey', checkSession, async (req, res) => {
  const { apiKey } = req.params;
  const { number, message } = req.body;
  if (!number || !message) {
    return res.status(400).json({ success: false, error: 'Número y mensaje obligatorios.' });
  }
  try {
    const tracking_id = crypto.randomUUID(); // Genera ID único
    sessionManager.sendTrackedMessage(apiKey, number, message, tracking_id, io);
    res.status(202).json({ 
      success: true, 
      message: 'Mensaje encolado.',
      tracking_id: tracking_id // Devuelve el ID a tu CRM
    });
  } catch (error) {
    logger.error(apiKey, 'Error en API /send-message', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

apiRouter.post('/send-pdf/:apiKey', checkSession, async (req, res) => {
  const { apiKey } = req.params;
  const { number, url, caption } = req.body;
  if (!number || !url) {
    return res.status(400).json({ success: false, error: 'Número y URL obligatorios.' });
  }
  try {
    const tracking_id = crypto.randomUUID();
    sessionManager.sendTrackedMedia(apiKey, number, url, caption, 'pdf', tracking_id, io);
    res.status(202).json({ 
      success: true, 
      message: 'PDF encolado.',
      tracking_id: tracking_id
    });
  } catch (error) {
    logger.error(apiKey, 'Error en API /send-pdf', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

apiRouter.post('/send-image/:apiKey', checkSession, async (req, res) => {
  const { apiKey } = req.params;
  const { number, url, caption } = req.body;
  if (!number || !url) {
    return res.status(400).json({ success: false, error: 'Número y URL obligatorios.' });
  }
  try {
    const tracking_id = crypto.randomUUID();
    sessionManager.sendTrackedMedia(apiKey, number, url, caption, 'image', tracking_id, io);
    res.status(202).json({ 
      success: true, 
      message: 'Imagen encolada.',
      tracking_id: tracking_id
    });
  } catch (error) {
    logger.error(apiKey, 'Error en API /send-image', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Registrar el router de la API
app.use('/api', apiRouter);


// --- Lógica de Socket.io (Protegida) ---
// Protege el handshake de Socket.IO con la misma autenticación del panel
io.use((socket, next) => {
  // NOTA: Si quieres que CUALQUIER dominio se conecte al socket sin login
  // (ej. para solo recibir estados públicos), deberías comentar la siguiente línea.
  // Pero para mantener el panel seguro, es mejor dejarlo.
  // Los clientes externos que no sean el panel usualmente no se conectan al socket
  // a menos que también les des usuario/pass.
  panelAuth(socket.request, socket.request.res, next);
});

io.on('connection', (socket) => {
  logger.info('System', 'Un cliente web se ha conectado al panel.');
  socket.emit('log_history', logger.getHistory());
  socket.emit('initial_status', sessionManager.getAllSessionStatuses());
  socket.on('disconnect', () => {
    logger.info('System', 'Un cliente web se desconectó.');
  });
});

// --- Iniciar Servidor ---
server.listen(PORT, () => {
  logger.info('System', `Servidor API V8 (PROo) iniciado en http://localhost:${PORT}`);
  sessionManager.loadExistingSessions(io);
});