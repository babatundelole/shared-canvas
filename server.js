const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Array to store all drawn points globally in server memory
const drawHistory = [];

app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Shared Canvas</title>
      <style>
        body { margin: 0; background: #111; overflow: hidden; font-family: sans-serif; }
        canvas { display: block; cursor: crosshair; }
        #status {
          position: fixed; top: 15px; left: 15px; z-index: 10;
          color: #00ff00; background: rgba(0,0,0,0.8);
          padding: 8px 16px; border-radius: 4px; font-weight: bold;
        }
      </style>
    </head>
    <body>
      <div id="status">Connecting...</div>
      <canvas id="paint"></canvas>
      <script>
        const status = document.getElementById('status');
        const canvas = document.getElementById('paint');
        const ctx = canvas.getContext('2d');

        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;

        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const socket = new WebSocket(\`\${protocol}//\${location.host}\`);

        socket.onopen = () => {
          status.innerText = "CONNECTED! Click and drag to draw.";
          status.style.color = "#00ff00";
        };

        socket.onerror = () => {
          status.innerText = "Connection Failed";
          status.style.color = "#ff0000";
        };

        let drawing = false;
        const color = 'hsl(' + Math.floor(Math.random() * 360) + ', 100%, 50%)';

        function drawPoint(x, y, c, send = true) {
          ctx.fillStyle = c;
          ctx.beginPath();
          ctx.arc(x, y, 6, 0, Math.PI * 2);
          ctx.fill();

          if (send && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: 'draw', x, y, color: c }));
          }
        }

        canvas.addEventListener('mousedown', (e) => { drawing = true; drawPoint(e.clientX, e.clientY, color); });
        canvas.addEventListener('mousemove', (e) => { if (drawing) drawPoint(e.clientX, e.clientY, color); });
        window.addEventListener('mouseup', () => drawing = false);

        socket.onmessage = (e) => {
          const message = JSON.parse(e.data);

          // Handle initial full canvas history load
          if (message.type === 'history') {
            message.data.forEach(pt => drawPoint(pt.x, pt.y, pt.color, false));
          } 
          // Handle real-time incoming points from other users
          else if (message.type === 'draw') {
            drawPoint(message.x, message.y, message.color, false);
          }
        };
      </script>
    </body>
    </html>
  `);
});

wss.on('connection', (ws) => {
  console.log('User connected');

  // 1. Immediately send full existing drawing history to the newly connected user
  ws.send(JSON.stringify({ type: 'history', data: drawHistory }));

  // 2. Listen for new draw events
  ws.on('message', (msg) => {
    const data = JSON.parse(msg.toString());
    if (data.type === 'draw') {
      // Save point to server history
      drawHistory.push({ x: data.x, y: data.y, color: data.color });

      // Broadcast point to all other connected users
      wss.clients.forEach((client) => {
        if (client !== ws && client.readyState === 1) {
          client.send(JSON.stringify(data));
        }
      });
    }
  });
});

const listener = server.listen(process.env.PORT || 3000, () => {
  console.log('Server running on port ' + listener.address().port);
});
