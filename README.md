🚀 API WhatsApp V8 (Node.js + Baileys + Socket.io)
Sistema de gestión de sesiones de WhatsApp multi-dispositivo, cola de mensajes y seguimiento en tiempo real.

Esta API es un servidor independiente diseñado para ser consumido por aplicaciones externas (CRMs, ERPs, Sistemas Web en PHP/Laravel/Node). Utiliza la librería Baileys para la conexión con WhatsApp y Socket.io para reportar estados en tiempo real al frontend.

🏛️ Arquitectura del Sistema
El sistema se basa en 4 pilares fundamentales:

Seguridad: Doble capa de autenticación (Header X-API-KEY para endpoints REST y Basic Auth para el Panel/Sockets).

Estabilidad: Implementación de p-queue para encolar mensajes y evitar baneos por saturación.

Persistencia: Las sesiones se guardan localmente para sobrevivir a reinicios del servidor.

Tracking Real: Confirmación de envío mediante WebSockets para evitar "falsos positivos".

🛠️ Requisitos Previos
Node.js: Versión 16.x o superior.

NPM o Yarn: Gestor de paquetes.

PM2 (Recomendado): Para mantener el proceso activo en producción.

Puerto Disponible: Por defecto el 3000 (o el que definas).

⚙️ Instalación y Configuración
1. Clonar y Dependencias

Bash
git clone https://github.com/TU_USUARIO/TU_REPO.git
cd TU_REPO
npm install
2. Variables de Entorno (.env)

Crea un archivo .env en la raíz del proyecto. ¡ESTO ES CRÍTICO!

Fragmento de código
# Configuración del Servidor
PORT=3000
NODE_ENV=production

# Seguridad API REST (Para consumir desde PHP/Postman)
MASTER_KEY=tu-clave-maestra-muy-secreta-123456

# Seguridad Panel Web y WebSockets
PANEL_USER=admin
PANEL_PASSWORD=admin
3. Ejecución

Modo Desarrollo:

Bash
npm run dev
# o
node app.js
Modo Producción (Con PM2):

Bash
pm2 start app.js --name "whatsapp-api-v8"
pm2 save
pm2 startup
🔌 Documentación de Endpoints (API REST)
Todas las peticiones deben incluir el header de seguridad:

Header: X-API-KEY: tu-clave-maestra-muy-secreta-123456

1. Crear Sesión

Genera una nueva instancia de WhatsApp.

Método: POST

URL: /api/create-session

Respuesta:

JSON
{
  "success": true,
  "apiKey": "a1b2c3d4...", 
  "message": "Sesión encolada..."
}
Nota: Guarda la apiKey retornada, la necesitarás para enviar mensajes.

2. Verificar Estado / Obtener QR

Consulta si la sesión está conectada o devuelve el QR en base64.

Método: GET

URL: /api/session-status/:apiKey

Respuesta (Esperando QR):

JSON
{ "success": true, "status": "scantime", "qr": "data:image/png;base64,..." }
Respuesta (Conectado):

JSON
{ "success": true, "status": "connected" }
3. Enviar Mensaje de Texto

Encola un mensaje de texto.

Método: POST

URL: /api/send-message/:apiKey

Body (JSON):

JSON
{
  "number": "584121234567",
  "message": "Hola mundo"
}
Respuesta:

JSON
{
  "success": true,
  "message": "Encolado",
  "tracking_id": "uuid-gen-123" 
}
Importante: Usa el tracking_id para escuchar el evento de éxito por WebSocket.

4. Enviar PDF / Archivo

Método: POST

URL: /api/send-pdf/:apiKey

Body (JSON):

JSON
{
  "number": "584121234567",
  "url": "https://midominio.com/archivo.pdf",
  "caption": "Aquí tienes tu factura"
}
5. Cerrar Sesión

Desconecta y elimina los archivos de sesión del servidor.

Método: DELETE

URL: /api/close-session/:apiKey

📡 WebSockets (Socket.io) - Tracking Real
El servidor emite eventos para informar al frontend sobre el estado real de los envíos.

Conexión desde el Cliente (JS):

JavaScript
const socket = io("https://api.tu-dominio.com", {
    auth: {
        username: "admin", // Debe coincidir con .env
        password: "admin"  // Debe coincidir con .env
    }
});
Eventos Disponibles:

message_status_update (El más importante) Se emite cuando Baileys confirma que el mensaje salió del servidor.

Payload Exitoso:

JSON
{ "tracking_id": "uuid-gen-123", "status": "SUCCESS" }
Payload Fallido:

JSON
{ "tracking_id": "uuid-gen-123", "status": "FAILED", "error": "Motivo..." }
session_update Se emite cuando cambia el estado de una sesión (ej. se generó un nuevo QR, se conectó, se desconectó).

Payload: { "apiKey": "...", "status": "scantime", "qr": "..." }

📂 Estructura de Carpetas
sessions/: Carpeta donde Baileys guarda las credenciales (auth_info). Nunca borrar manualmente si hay sesiones activas.

logs/: Archivos de registro de errores y actividad.

src/: Código fuente de la API.

public/: Archivos estáticos para el Panel de Control Web.

⚠️ Solución de Problemas Comunes
Error CORS en el Frontend:

Verifica en app.js la configuración de CORS de Socket.io. Asegúrate de que el dominio de tu CRM esté en la lista de orígenes permitidos.

El QR no carga:

Revisa que el servidor Node.js esté corriendo.

Verifica que la apiKey sea correcta.

Mensajes se quedan "Encolados":

Verifica que el teléfono tenga internet.

Reinicia el proceso con PM2 (pm2 restart whatsapp-api-v8).

📝 Notas de Integración (PHP)
Para consumir la API desde PHP, usa cURL. Ejemplo básico:

PHP
$ch = curl_init('https://api.tudominio.com/api/send-message/' . $apiKey);
curl_setopt($ch, CURLOPT_HTTPHEADER, [
    'Content-Type: application/json',
    'X-API-KEY: ' . $MASTER_KEY
]);
// ... resto de configuración cURL
