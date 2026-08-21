const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

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
          user-select: none;
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
          <input type="range" id="brushSize" min="2" max="50" value="12">
        </div>
        <button id="eraseBtn">Eraser: OFF</button>
      </div>

      <canvas id="mainCanvas"></canvas>

      <script>
        const status = document.getElementById('status');
        const mainCanvas = document.getElementById('mainCanvas');
        const mainCtx = mainCanvas.getContext('2d');
        const colorPicker = document.getElementById('colorPicker');
        const brushSize = document.getElementById('brushSize');
        const eraseBtn = document.getElementById('eraseBtn');

        mainCanvas.width = window.innerWidth;
        mainCanvas.height = window.innerHeight;

        let myUserId = null;
        let isEraserMode = false;
        let drawing = false;
        let lastPos = null;

        // Store offscreen canvas layers per user: { [userId]: { canvas, ctx } }
        const userLayers = {};

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

        function getUserLayer(userId) {
          if (!userLayers[userId]) {
            const canvas = document.createElement('canvas');
            canvas.width = mainCanvas.width;
            canvas.height = mainCanvas.height;
            const ctx = canvas.getContext('2d');
            userLayers[userId] = { canvas, ctx };
          }
          return userLayers[userId];
        }

        function flattenLayersToMain() {
          mainCtx.clearRect(0, 0, mainCanvas.width, mainCanvas.height);
          for (const uid in userLayers) {
            mainCtx.drawImage(userLayers[uid].canvas, 0, 0);
          }
        }

        function strokeSegment(userId, x1, y1, x2, y2, color, size, isEraser) {
          const layer = getUserLayer(userId);
          const ctx = layer.ctx;

          ctx.save();
          if (isEraser) {
            // Cut transparent holes into ONLY this user's layer
            ctx.globalCompositeOperation = 'destination-out';
            ctx.strokeStyle = 'rgba(0,0,0,1)';
          } else {
            ctx.globalCompositeOperation = 'source-over';
            ctx.strokeStyle = color;
          }

          ctx.lineWidth = size;
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';

          ctx.beginPath();
          ctx.moveTo(x1, y1);
          ctx.lineTo(x2, y2);
          ctx.stroke();
          ctx.restore();

          flattenLayersToMain();
        }

        function handlePointerMove(e) {
          if (!drawing) return;

          const currentPos = { x: e.clientX, y: e.clientY };
          if (!lastPos) lastPos = currentPos;

          const size = parseInt(brushSize.value);
          const color = colorPicker.value;

          // 1. Draw segment instantly to local layer
          strokeSegment(myUserId, lastPos.x, lastPos.y, currentPos.x, currentPos.y, color, size, isEraserMode);

          // 2. Broadcast smooth line stroke data
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({
              type: 'stroke',
              x1: lastPos.x, y1: lastPos.y,
              x2: currentPos.x, y2: currentPos.y,
              color, size,
              isEraser: isEraserMode
            }));
          }

          lastPos = currentPos;
        }

        mainCanvas.addEventListener('mousedown', (e) => {
          drawing = true;
          lastPos = { x: e.clientX, y: e.clientY };
          handlePointerMove(e);
        });

        mainCanvas.addEventListener('mousemove', handlePointerMove);

        window.addEventListener('mouseup', () => {
          drawing = false;
          lastPos = null;
        });

        eraseBtn.addEventListener('click', () => {
          isEraserMode = !isEraserMode;
          eraseBtn.innerText = isEraserMode ? "Eraser: ON" : "Eraser: OFF";
          eraseBtn.classList.toggle('active', isEraserMode);
        });

        socket.onmessage = (e) => {
          const message = JSON.parse(e.data);

          if (message.type === 'init') {
            myUserId = message.userId;
            // Play back stored history
            message.history.forEach(item => {
              strokeSegment(item.userId, item.x1, item.y1, item.x2, item.y2, item.color, item.size, item.isEraser);
            });
          } 
          else if (message.type === 'stroke') {
            // Render incoming strokes from other users
            if (message.userId !== myUserId) {
              strokeSegment(message.userId, message.x1, message.y1, message.x2, message.y2, message.color, message.size, message.isEraser);
            }
          }
        };
      </script>
    </body>
    </html>
  `);
});

wss.on('connection', (ws) => {
  const userId = Math.random().toString(36).substring(2, 10);

  // Send initial session data & history
  ws.send(JSON.stringify({ type: 'init', userId, history: drawHistory }));

  ws.on('message', (msg) => {
    const data = JSON.parse(msg.toString());

    if (data.type === 'stroke') {
      const strokeData = {
        userId,
        x1: data.x1, y1: data.y1,
        x2: data.x2, y2: data.y2,
        color: data.color,
        size: data.size,
        isEraser: data.isEraser
      };

      drawHistory.push(strokeData);

      // Broadcast to all connected clients
      wss.clients.forEach((client) => {
        if (client.readyState === 1) {
          client.send(JSON.stringify({ type: 'stroke', ...strokeData }));
        }
      });
    }
  });
});

const listener = server.listen(process.env.PORT || 3000, () => {
  console.log('Server running on port ' + listener.address().port);
});
