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
        body { margin: 0; background: #111; overflow: hidden; font-family: sans-serif; transition: background 0.3s; }
        body.theme-light { background: #f4f4f9; }
        body.theme-grid { 
          background-color: #111;
          background-image: linear-gradient(rgba(255,255,255,0.05) 1px, transparent 1px),
                            linear-gradient(90deg, rgba(255,255,255,0.05) 1px, transparent 1px);
          background-size: 20px 20px;
        }

        #bg-image-layer {
          position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
          object-fit: cover; z-index: 1; display: none;
        }
        
        canvas { display: block; cursor: crosshair; position: relative; z-index: 2; }
        
        #toolbar {
          position: fixed; top: 15px; left: 15px; z-index: 10;
          background: rgba(0,0,0,0.85); padding: 10px 14px;
          border-radius: 8px; display: flex; align-items: center; gap: 10px;
          color: #fff; font-size: 13px; box-shadow: 0 4px 10px rgba(0,0,0,0.5);
          user-select: none; flex-wrap: wrap;
        }
        #status { font-weight: bold; font-size: 11px; color: #00ff00; margin-right: 5px; }
        
        input[type="color"] {
          border: none; width: 26px; height: 26px; border-radius: 50%;
          cursor: pointer; background: transparent;
        }
        
        select, button, label.btn {
          background: #333; color: white; border: 1px solid #555; padding: 5px 10px;
          border-radius: 4px; font-weight: bold; cursor: pointer; transition: all 0.2s;
          font-size: 12px;
        }
        button:hover, label.btn:hover, select:hover { background: #444; }
        button.active { background: #e74c3c; border-color: #ff6b6b; }
        input[type="file"] { display: none; }

        .control-group { display: flex; align-items: center; gap: 4px; }
      </style>
    </head>
    <body>
      <img id="bg-image-layer" alt="Background">

      <div id="toolbar">
        <span id="status">Connecting...</span>

        <div class="control-group">
          <input type="color" id="colorPicker" value="#00ffcc">
        </div>

        <div class="control-group">
          <label for="brushSize">Size:</label>
          <input type="range" id="brushSize" min="2" max="50" value="12">
        </div>

        <button id="eraseBtn">Eraser: OFF</button>
        <button id="undoBtn">Undo</button>
        <button id="redoBtn">Redo</button>

        <div class="control-group">
          <select id="bgSelect">
            <option value="dark">Theme: Dark</option>
            <option value="light">Theme: Light</option>
            <option value="grid">Theme: Grid</option>
          </select>
        </div>

        <label for="bgUpload" class="btn">Upload BG</label>
        <input type="file" id="bgUpload" accept="image/*">
      </div>

      <canvas id="mainCanvas"></canvas>

      <script>
        const status = document.getElementById('status');
        const mainCanvas = document.getElementById('mainCanvas');
        const mainCtx = mainCanvas.getContext('2d');
        const colorPicker = document.getElementById('colorPicker');
        const brushSize = document.getElementById('brushSize');
        const eraseBtn = document.getElementById('eraseBtn');
        const undoBtn = document.getElementById('undoBtn');
        const redoBtn = document.getElementById('redoBtn');
        const bgSelect = document.getElementById('bgSelect');
        const bgUpload = document.getElementById('bgUpload');
        const bgImageLayer = document.getElementById('bg-image-layer');

        mainCanvas.width = window.innerWidth;
        mainCanvas.height = window.innerHeight;

        let myUserId = null;
        let isEraserMode = false;
        let drawing = false;
        let lastPos = null;

        // Undo / Redo Stacks for local user actions
        const undoStack = [];
        const redoStack = [];
        let currentStrokeId = null;

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

        function clearAllLayers() {
          for (const uid in userLayers) {
            userLayers[uid].ctx.clearRect(0, 0, mainCanvas.width, mainCanvas.height);
          }
          flattenLayersToMain();
        }

        function rebuildFromHistory(history) {
          clearAllLayers();
          history.forEach(item => {
            strokeSegment(item.userId, item.x1, item.y1, item.x2, item.y2, item.color, item.size, item.isEraser);
          });
        }

        function handlePointerMove(e) {
          if (!drawing) return;

          const currentPos = { x: e.clientX, y: e.clientY };
          if (!lastPos) lastPos = currentPos;

          const size = parseInt(brushSize.value);
          const color = colorPicker.value;

          strokeSegment(myUserId, lastPos.x, lastPos.y, currentPos.x, currentPos.y, color, size, isEraserMode);

          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({
              type: 'stroke',
              strokeId: currentStrokeId,
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
          currentStrokeId = Math.random().toString(36).substring(2, 10);
          undoStack.push(currentStrokeId);
          redoStack.length = 0; // Clear redo on new stroke
          lastPos = { x: e.clientX, y: e.clientY };
          handlePointerMove(e);
        });

        mainCanvas.addEventListener('mousemove', handlePointerMove);

        window.addEventListener('mouseup', () => {
          drawing = false;
          lastPos = null;
        });

        // Undo & Redo Handlers
        function triggerUndo() {
          if (undoStack.length === 0) return;
          const strokeIdToUndo = undoStack.pop();
          redoStack.push(strokeIdToUndo);
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: 'undo', strokeId: strokeIdToUndo }));
          }
        }

        function triggerRedo() {
          if (redoStack.length === 0) return;
          const strokeIdToRedo = redoStack.pop();
          undoStack.push(strokeIdToRedo);
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: 'redo', strokeId: strokeIdToRedo }));
          }
        }

        undoBtn.addEventListener('click', triggerUndo);
        redoBtn.addEventListener('click', triggerRedo);

        // Keyboard Shortcuts (Ctrl+Z / Ctrl+Y)
        window.addEventListener('keydown', (e) => {
          if (e.ctrlKey && e.key === 'z') { e.preventDefault(); triggerUndo(); }
          if (e.ctrlKey && e.key === 'y') { e.preventDefault(); triggerRedo(); }
        });

        // Theme & Background Upload Handlers
        bgSelect.addEventListener('change', (e) => {
          document.body.className = '';
          bgImageLayer.style.display = 'none';
          if (e.target.value !== 'dark') {
            document.body.classList.add('theme-' + e.target.value);
          }
        });

        bgUpload.addEventListener('change', (e) => {
          const file = e.target.files[0];
          if (file) {
            const reader = new FileReader();
            reader.onload = (event) => {
              bgImageLayer.src = event.target.result;
              bgImageLayer.style.display = 'block';
            };
            reader.readAsDataURL(file);
          }
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
            rebuildFromHistory(message.history);
          } 
          else if (message.type === 'stroke') {
            if (message.userId !== myUserId) {
              strokeSegment(message.userId, message.x1, message.y1, message.x2, message.y2, message.color, message.size, message.isEraser);
            }
          }
          else if (message.type === 'update_history') {
            rebuildFromHistory(message.history);
          }
        };
      </script>
    </body>
    </html>
  `);
});

// Stashed items for user undo/redo management
let undoneHistory = [];

wss.on('connection', (ws) => {
  const userId = Math.random().toString(36).substring(2, 10);
  ws.send(JSON.stringify({ type: 'init', userId, history: drawHistory }));

  ws.on('message', (msg) => {
    const data = JSON.parse(msg.toString());

    if (data.type === 'stroke') {
      const strokeData = {
        strokeId: data.strokeId,
        userId,
        x1: data.x1, y1: data.y1,
        x2: data.x2, y2: data.y2,
        color: data.color,
        size: data.size,
        isEraser: data.isEraser
      };

      drawHistory.push(strokeData);

      wss.clients.forEach((client) => {
        if (client.readyState === 1) {
          client.send(JSON.stringify({ type: 'stroke', ...strokeData }));
        }
      });
    } 
    else if (data.type === 'undo') {
      // Remove strokes associated with the undo action
      const removed = drawHistory.filter(item => item.strokeId === data.strokeId);
      drawHistory = drawHistory.filter(item => item.strokeId !== data.strokeId);
      undoneHistory.push(...removed);

      wss.clients.forEach((client) => {
        if (client.readyState === 1) {
          client.send(JSON.stringify({ type: 'update_history', history: drawHistory }));
        }
      });
    }
    else if (data.type === 'redo') {
      // Restore strokes associated with the redo action
      const restored = undoneHistory.filter(item => item.strokeId === data.strokeId);
      undoneHistory = undoneHistory.filter(item => item.strokeId !== data.strokeId);
      drawHistory.push(...restored);

      wss.clients.forEach((client) => {
        if (client.readyState === 1) {
          client.send(JSON.stringify({ type: 'update_history', history: drawHistory }));
        }
      });
    }
  });
});

const listener = server.listen(process.env.PORT || 3000, () => {
  console.log('Server running on port ' + listener.address().port);
});
