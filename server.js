const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Serve complete drawing app on root request
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

        socket.onerror = (err) => {
          status.innerText = "Connection Failed";
          status.style.color = "#ff0000";
        };

        let drawing = false;
        const color = 'hsl(' + Math.floor(Math.random() * 360) + ', 100%, 50%)';

        function draw(x, y, send = true) {
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(x, y, 6, 0, Math.PI * 2);
          ctx.fill();

          if (send && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ x, y, color }));
          }
        }

        canvas.addEventListener('mousedown', (e) => { drawing = true; draw(e.clientX, e.clientY); });
        canvas.addEventListener('mousemove', (e) => { if (drawing) draw(e.clientX, e.clientY); });
        window.addEventListener('mouseup', () => drawing = false);

        socket.onmessage = (e) => {
          const data = JSON.parse(e.data);
          ctx.fillStyle = data.color;
          ctx.beginPath();
          ctx.arc(data.x, data.y, 6, 0, Math.PI * 2);
          ctx.fill();
        };
      </script>
    </body>
    </html>
  `);
});

wss.on('connection', (ws) => {
  console.log('SUCCESS: Browser connected!');
  ws.on('message', (msg) => {
    wss.clients.forEach((client) => {
      if (client !== ws && client.readyState === 1) client.send(msg.toString());
    });
  });
});

server.listen(3000, () => {
  console.log('--- SERVER RUNNING AT http://localhost:3000 ---');
});