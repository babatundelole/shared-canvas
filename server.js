const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('crypto'); // Built-in Node crypto module

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Store all drawn points: { id, userId, x, y, color, size }
let drawHistory = [];

app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Shared Canvas</title>
      <style>
        body { margin: 0; background: #111; overflow: hidden; font-family: sans-serif; }
        canvas { display: block; cursor: crosshair; }
        
        #toolbar {
          position: fixed; top: 15px; left: 15px; z-index: 10;
          background: rgba(0,0,0,0.85); padding: 10px 14px;
          border-radius: 8px; display: flex; align-items: center; gap: 12px;
          color: #fff; font-size: 14px; box-shadow: 0 4px 10px rgba(0,0,0,0.5);
        }
        #status { font-weight: bold; font-size: 12px; color: #00ff00; }
        
        input[type="color"] {
          border: none; width: 30px; height: 30px; border-radius: 50%;
          cursor: pointer; background: transparent;
        }
        
        button {
          background: #333; color: white; border: 1px solid #555; padding: 6px 12px;
          border-radius: 4px; font-weight: bold; cursor: pointer; transition: all 0.2s;
        }
        button:hover { background: #444; }
        button.active { background: #e74c3c; border-color: #ff6b6b; }

        .control-group { display: flex; align-items: center; gap: 6px; }
      </style>
    </head>
    <body>
      <div id="toolbar">
        <span id="status">Connecting...</span>
        <div class="control-group">
          <label for="colorPicker">Color:</label>
          <input type="color" id="colorPicker" value="#00ffcc">
        </div>
        <div class="control-group">
          <label for="brushSize">Size:</label>
          <input type="range" id="brushSize" min="2" max="40" value="8">
        </div>
        <button id="eraseBtn">Eraser: OFF</button>
      </div>

      <canvas id="paint"></canvas>

      <script>
        const status = document.getElementById('status');
        const canvas = document.getElementById('paint');
        const ctx = canvas.getContext('2d');
        const colorPicker = document.getElementById('colorPicker');
        const brushSize = document.getElementById('brushSize');
        const eraseBtn = document.getElementById('eraseBtn');

        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;

        let myUserId = null;
        let localHistory = [];
        let isEraserMode = false;
        let drawing = false;

        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const socket = new WebSocket(\`\${protocol}//\${location.host}\`);

        socket.onopen = () => {
          status.innerText = "CONNECTED";
          status.style.color = "#00ff00";
        };

        socket.onerror = () => {
          status.innerText = "FAILED";
          status.style.color = "#ff0000";
        };

        function redrawAll() {
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          localHistory.forEach(pt => {
            ctx.fillStyle = pt.color;
            ctx.beginPath();
            ctx.arc(pt.x, pt.y, pt.size, 0, Math.PI * 2);
            ctx.fill();
          });
        }

        function handlePointer(x, y) {
          const size = parseInt(brushSize.value);

          if (isEraserMode) {
            // Send request to server to remove ONLY my own points within radius
            if (socket.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify({ type: 'erase_mine', x, y, radius: size }));
            }
          } else {
            // Draw new point
            const color = colorPicker.value;
            if (socket.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify({ type: 'draw', x, y, color, size }));
            }
          }
        }

        canvas.addEventListener('mousedown', (e) => { drawing = true; handlePointer(e.clientX, e.clientY); });
        canvas.addEventListener('mousemove', (e) => { if (drawing) handlePointer(e.clientX, e.clientY); });
        window.addEventListener('mouseup', () => drawing = false);

        eraseBtn.addEventListener('click', () => {
          isEraserMode = !isEraserMode;
          eraseBtn.innerText = isEraserMode ? "Eraser: ON" : "Eraser: OFF";
          eraseBtn.classList.toggle('active', isEraserMode);
        });

        socket.onmessage = (e) => {
          const message = JSON.parse(e.data);

          if (message.type === 'init') {
            myUserId = message.userId;
            localHistory = message.history;
            redrawAll();
          } 
          else if (message.type === 'draw') {
            localHistory.push(message.point);
            ctx.fillStyle = message.point.color;
            ctx.beginPath();
            ctx.arc(message.point.x, message.point.y, message.point.size, 0, Math.PI * 2);
            ctx.fill();
          }
          else if (message.type === 'update_history') {
            localHistory = message.history;
            redrawAll();
          }
        };
      </script>
    </body>
    </html>
  `);
});

wss.on('connection', (ws) => {
  // Generate a unique ID for this client session
  const userId = Math.random().toString(36).substring(2, 10);

  // Send client their ID + existing global drawing history
  ws.send(JSON.stringify({ type: 'init', userId, history: drawHistory }));

  ws.on('message', (msg) => {
    const data = JSON.parse(msg.toString());

    if (data.type === 'draw') {
      const point = {
        id: Math.random().toString(36).substring(2, 10),
        userId,
        x: data.x,
        y: data.y,
        color: data.color,
        size: data.size
      };

      drawHistory.push(point);

      // Broadcast new point to everyone
      wss.clients.forEach((client) => {
        if (client.readyState === 1) {
          client.send(JSON.stringify({ type: 'draw', point }));
        }
      });
    } 
    else if (data.type === 'erase_mine') {
      // Filter out points that belong to THIS user and fall within the eraser circle
      const beforeCount = drawHistory.length;
      drawHistory = drawHistory.filter((pt) => {
        if (pt.userId !== userId) return true; // KEEP other users' points untouched
        const distance = Math.hypot(pt.x - data.x, pt.y - data.y);
        return distance > data.radius; // Delete my point if inside eraser radius
      });

      // If points were erased, notify ALL clients to refresh canvas
      if (drawHistory.length !== beforeCount) {
        wss.clients.forEach((client) => {
          if (client.readyState === 1) {
            client.send(JSON.stringify({ type: 'update_history', history: drawHistory }));
          }
        });
      }
    }
  });
});

const listener = server.listen(process.env.PORT || 3000, () => {
  console.log('Server running on port ' + listener.address().port);
});
