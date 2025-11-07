// logger.js
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'api.log');
const MAX_LOGS = 100; // Guardar los últimos 100 logs en memoria para el panel
const logHistory = [];

// Asegurarse de que el directorio de logs exista
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR);
}

// Cargar historial de logs desde el archivo al iniciar
try {
  const data = fs.readFileSync(LOG_FILE, 'utf8');
  const lines = data.split('\n').filter(Boolean); // Filtra líneas vacías
  const recentLines = lines.slice(-MAX_LOGS); // Tomar solo las últimas MAX_LOGS
  recentLines.forEach(line => {
    try {
      logHistory.push(JSON.parse(line)); // Asumimos que guardamos JSON
    } catch (e) { /* Ignora líneas corruptas */ }
  });
} catch (e) {
  if (e.code !== 'ENOENT') { // ENOENT (No such file) es normal la primera vez
    console.error('Error al cargar historial de logs:', e);
  }
}

// Stream para escribir logs al archivo de forma persistente
const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });

class Logger extends EventEmitter {
  constructor() {
    super();
    this.io = null;
  }

  setSocket(io) {
    this.io = io;
  }

  getHistory() {
    return logHistory;
  }

  _log(level, apiKey, message) {
    const timestamp = new Date();
    const logEntry = {
      timestamp: timestamp.toLocaleString('sv-SE'),
      level,
      apiKey: apiKey || 'System',
      message,
    };
    
    // Guardar en historial de memoria
    logHistory.push(logEntry);
    if (logHistory.length > MAX_LOGS) {
      logHistory.shift();
    }
    
    // Escribir en consola (para 'docker logs')
    const consoleMsg = `[${logEntry.timestamp}] [${level.toUpperCase()}] [${logEntry.apiKey}] ${message}`;
    if (level === 'error') console.error(consoleMsg);
    else if (level === 'warn') console.warn(consoleMsg);
    else console.log(consoleMsg);

    // Escribir en archivo persistente
    logStream.write(JSON.stringify(logEntry) + '\n');

    // Emitir a panel web
    if (this.io) {
      this.io.emit('log_message', logEntry);
    }
  }

  info(apiKey, message) { this._log('info', apiKey, message); }
  warn(apiKey, message) { this._log('warn', apiKey, message); }
  error(apiKey, message, error = null) {
    const msg = error ? `${message} | Error: ${error.message || error}` : message;
    this._log('error', apiKey, msg);
  }
}

module.exports = new Logger();