require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { startBot } = require('./bot');
const { initDb, setupTables } = require('./db');

if (process.env.DATABASE_URL) {
  initDb(process.env.DATABASE_URL);
  setupTables().then(async () => {
    console.log('Database ready');
    const { getStoredPhoneNumbers } = require('./db');
    const numbers = await getStoredPhoneNumbers();
    for (const num of numbers) {
      console.log(`Auto-reconnecting ${num}...`);
      startBot(num, null).catch(err => console.error(`Auto-reconnect error for ${num}:`, err));
    }
  }).catch(err => console.error('DB setup error:', err));
}

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static(path.join(__dirname, '../public')));
io.on('connection', (socket) => {
    console.log('Frontend connected');
    socket.on('request-code', async (phoneNumber) => {
        console.log('Phone number received:', phoneNumber);
        try {
            const code = await startBot(phoneNumber, socket);
        } catch (error) {
            console.error('Error starting bot:', error);
            socket.emit('error', 'Failed to start bot');
        }
    });
});
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});