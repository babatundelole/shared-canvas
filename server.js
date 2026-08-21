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
        let eraseThrottleTimer = null;

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
          for (let i = 0; i < localHistory.length; i++) {
            const pt = localHistory[i];
            ctx.fillStyle = pt.color;
            ctx.beginPath();
            ctx.arc(pt.x, pt.y, pt.size, 0, Math.PI * 2);
            ctx.fill();
          }
        }

        function drawSinglePoint(pt) {
          ctx.fillStyle = pt.color;
          ctx.beginPath();
          ctx.arc(pt.x, pt.y, pt.size, 0, Math.PI * 2);
          ctx.fill();
        }

        function handlePointer(x, y) {
          const size = parseInt(brushSize.value);

          if (isEraserMode) {
            // 1. INSTANT LOCAL ERASE: Remove only my points locally and redraw immediately
            const initialLength = localHistory.length;
            localHistory = localHistory.filter(pt => {
              if (pt.userId !== myUserId) return true;
              return Math.hypot(pt.x - x, pt.y - y) > size;
            });

            if (localHistory.length !== initialLength) {
              redrawAll();

              // 2. THROTTLED SERVER SYNC: Only talk to server every 50ms instead of every pixel
              if (!eraseThrottleTimer) {
                eraseThrottleTimer = setTimeout(() => {
                  if (socket.readyState === WebSocket.OPEN) {
                    socket.send(JSON.stringify({ type: 'erase_mine', x, y, radius: size }));
                  }
                  eraseThrottleTimer = null;
                }, 50);
              }
            }
          } else {
            const color = colorPicker.value;
            const tempPoint = { userId: myUserId, x, y, color, size };

            drawSinglePoint(tempPoint);
            localHistory.push(tempPoint);

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
            if (message.point.userId !== myUserId) {
              localHistory.push(message.point);
              drawSinglePoint(message.point);
            }
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
  const userId = Math.random().toString(36).substring(2, 10);
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

      wss.clients.forEach((client) => {
        if (client.readyState === 1) {
          client.send(JSON.stringify({ type: 'draw', point }));
        }
      });
    } 
    else if (data.type === 'erase_mine') {
      const beforeCount = drawHistory.length;
      drawHistory = drawHistory.filter((pt) => {
        if (pt.userId !== userId) return true;
        return Math.hypot(pt.x - data.x, pt.y - data.y) > data.radius;
      });

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
