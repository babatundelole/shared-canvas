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

        canvas { display: block; position: absolute; top: 0; left: 0; z-index: 2; }
        
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

        <label for="imgUpload" class="btn">Add Image</label>
        <input type="file" id="imgUpload" accept="image/*">
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
        const imgUpload = document.getElementById('imgUpload');

        mainCanvas.width = window.innerWidth;
        mainCanvas.height = window.innerHeight;

        let myUserId = null;
        let isEraserMode = false;
        let drawing = false;
        let lastPos = null;

        const undoStack = [];
        const redoStack = [];
        let currentStrokeId = null;

        const userLayers = {};
        
        let imageObjects = [];
        let selectedImg = null;
        let dragMode = null;
        let isDragging = false; // Lock flag to stop jitter during manipulation
        let dragOffset = { x: 0, y: 0 };
        const HANDLE_SIZE = 12;
        const ROTATE_HANDLE_OFFSET = 30;

        let renderScheduled = false;
        let lastNetworkSend = 0;

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

        function requestRender() {
          if (!renderScheduled) {
            renderScheduled = true;
            requestAnimationFrame(flattenLayersToMain);
          }
        }

        function flattenLayersToMain() {
          renderScheduled = false;
          mainCtx.clearRect(0, 0, mainCanvas.width, mainCanvas.height);
          
          imageObjects.forEach(obj => {
            if (obj.imgElement && obj.imgElement.complete) {
              mainCtx.save();
              const cx = obj.x + obj.w / 2;
              const cy = obj.y + obj.h / 2;
              mainCtx.translate(cx, cy);
              mainCtx.rotate(obj.angle || 0);

              mainCtx.drawImage(obj.imgElement, -obj.w / 2, -obj.h / 2, obj.w, obj.h);

              if (obj === selectedImg) {
                mainCtx.strokeStyle = '#00ffcc';
                mainCtx.lineWidth = 2;
                mainCtx.strokeRect(-obj.w / 2, -obj.h / 2, obj.w, obj.h);

                // Resize handle
                mainCtx.fillStyle = '#00ffcc';
                mainCtx.fillRect(obj.w / 2 - HANDLE_SIZE, obj.h / 2 - HANDLE_SIZE, HANDLE_SIZE, HANDLE_SIZE);

                // Rotate handle
                mainCtx.beginPath();
                mainCtx.moveTo(0, -obj.h / 2);
                mainCtx.lineTo(0, -obj.h / 2 - ROTATE_HANDLE_OFFSET);
                mainCtx.stroke();

                mainCtx.beginPath();
                mainCtx.arc(0, -obj.h / 2 - ROTATE_HANDLE_OFFSET, 6, 0, Math.PI * 2);
                mainCtx.fill();
              }
              mainCtx.restore();
            }
          });

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

          requestRender();
        }

        function clearAllLayers() {
          for (const uid in userLayers) {
            userLayers[uid].ctx.clearRect(0, 0, mainCanvas.width, mainCanvas.height);
          }
        }

        function rebuildFromHistory(history) {
          clearAllLayers();
          history.forEach(item => {
            if (item.type === 'stroke') {
              strokeSegment(item.userId, item.x1, item.y1, item.x2, item.y2, item.color, item.size, item.isEraser);
            }
          });
          requestRender();
        }

        function addImageToCanvas(imgData) {
          const img = new Image();
          img.src = imgData.src;
          const obj = { angle: 0, ...imgData, imgElement: img };
          
          img.onload = () => {
            imageObjects.push(obj);
            requestRender();
          };
        }

        function toLocalCoords(obj, worldX, worldY) {
          const cx = obj.x + obj.w / 2;
          const cy = obj.y + obj.h / 2;
          const rad = -(obj.angle || 0);
          const dx = worldX - cx;
          const dy = worldY - cy;
          return {
            x: dx * Math.cos(rad) - dy * Math.sin(rad),
            y: dx * Math.sin(rad) + dy * Math.cos(rad)
          };
        }

        function getHitHandle(obj, worldX, worldY) {
          const local = toLocalCoords(obj, worldX, worldY);
          
          if (local.x >= obj.w / 2 - HANDLE_SIZE && local.x <= obj.w / 2 + 5 &&
              local.y >= obj.h / 2 - HANDLE_SIZE && local.y <= obj.h / 2 + 5) {
            return 'resize';
          }
          
          const rotY = -obj.h / 2 - ROTATE_HANDLE_OFFSET;
          if (Math.hypot(local.x - 0, local.y - rotY) <= 12) {
            return 'rotate';
          }

          return null;
        }

        function getHitImage(worldX, worldY) {
          for (let i = imageObjects.length - 1; i >= 0; i--) {
            const obj = imageObjects[i];
            const local = toLocalCoords(obj, worldX, worldY);
            if (local.x >= -obj.w / 2 && local.x <= obj.w / 2 &&
                local.y >= -obj.h / 2 && local.y <= obj.h / 2) {
              return obj;
            }
          }
          return null;
        }

        mainCanvas.addEventListener('mousedown', (e) => {
          const x = e.clientX;
          const y = e.clientY;

          if (selectedImg) {
            const handle = getHitHandle(selectedImg, x, y);
            if (handle) {
              dragMode = handle;
              isDragging = true;
              return;
            }
          }

          const hitImg = getHitImage(x, y);
          if (hitImg) {
            selectedImg = hitImg;
            dragMode = 'move';
            isDragging = true;
            dragOffset = { x: x - selectedImg.x, y: y - selectedImg.y };
            requestRender();
            return;
          }

          if (selectedImg) {
            selectedImg = null;
            requestRender();
          }

          drawing = true;
          currentStrokeId = Math.random().toString(36).substring(2, 10);
          undoStack.push(currentStrokeId);
          redoStack.length = 0;
          lastPos = { x, y };
          handlePointerMove(e);
        });

        function handlePointerMove(e) {
          const x = e.clientX;
          const y = e.clientY;

          if (dragMode === 'move' && selectedImg) {
            selectedImg.x = x - dragOffset.x;
            selectedImg.y = y - dragOffset.y;
            requestRender();
            syncImageUpdateThrottled(selectedImg);
            return;
          }

          if (dragMode === 'resize' && selectedImg) {
            const local = toLocalCoords(selectedImg, x, y);
            selectedImg.w = Math.max(30, local.x * 2);
            selectedImg.h = Math.max(30, local.y * 2);
            requestRender();
            syncImageUpdateThrottled(selectedImg);
            return;
          }

          if (dragMode === 'rotate' && selectedImg) {
            const cx = selectedImg.x + selectedImg.w / 2;
            const cy = selectedImg.y + selectedImg.h / 2;
            selectedImg.angle = Math.atan2(y - cy, x - cx) + Math.PI / 2;
            requestRender();
            syncImageUpdateThrottled(selectedImg);
            return;
          }

          if (!drawing) return;

          const currentPos = { x, y };
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

        mainCanvas.addEventListener('mousemove', handlePointerMove);

        window.addEventListener('mouseup', () => {
          if (dragMode && selectedImg) {
            syncImageUpdate(selectedImg);
          }
          drawing = false;
          isDragging = false;
          dragMode = null;
          lastPos = null;
        });

        function syncImageUpdateThrottled(imgObj) {
          const now = Date.now();
          if (now - lastNetworkSend > 40) { // Throttled to ~25fps over network to avoid flooding
            syncImageUpdate(imgObj);
            lastNetworkSend = now;
          }
        }

        function syncImageUpdate(imgObj) {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({
              type: 'update_image',
              id: imgObj.id,
              x: imgObj.x,
              y: imgObj.y,
              w: imgObj.w,
              h: imgObj.h,
              angle: imgObj.angle
            }));
          }
        }

        imgUpload.addEventListener('change', (e) => {
          const file = e.target.files[0];
          if (file) {
            const reader = new FileReader();
            reader.onload = (event) => {
              const newImgData = {
                id: Math.random().toString(36).substring(2, 10),
                src: event.target.result,
                x: 100, y: 100,
                w: 200, h: 200,
                angle: 0
              };

              addImageToCanvas(newImgData);
              selectedImg = imageObjects[imageObjects.length - 1];

              if (socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({ type: 'add_image', image: newImgData }));
              }
            };
            reader.readAsDataURL(file);
          }
        });

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

        window.addEventListener('keydown', (e) => {
          if (e.ctrlKey && e.key === 'z') { e.preventDefault(); triggerUndo(); }
          if (e.ctrlKey && e.key === 'y') { e.preventDefault(); triggerRedo(); }
        });

        bgSelect.addEventListener('change', (e) => {
          document.body.className = '';
          if (e.target.value !== 'dark') {
            document.body.classList.add('theme-' + e.target.value);
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
            
            if (message.images) {
              message.images.forEach(img => addImageToCanvas(img));
            }
            
            rebuildFromHistory(message.history);
          } 
          else if (message.type === 'stroke') {
            if (message.userId !== myUserId) {
              strokeSegment(message.userId, message.x1, message.y1, message.x2, message.y2, message.color, message.size, message.isEraser);
            }
          }
          else if (message.type === 'add_image') {
            addImageToCanvas(message.image);
          }
          else if (message.type === 'update_image') {
            // Ignore network updates for the image YOU are currently dragging to avoid glitching
            if (isDragging && selectedImg && selectedImg.id === message.id) return;

            const target = imageObjects.find(img => img.id === message.id);
            if (target) {
              target.x = message.x;
              target.y = message.y;
              target.w = message.w;
              target.h = message.h;
              target.angle = message.angle;
              requestRender();
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

let imageStore = [];
let undoneHistory = [];

wss.on('connection', (ws) => {
  const userId = Math.random().toString(36).substring(2, 10);
  ws.send(JSON.stringify({ type: 'init', userId, history: drawHistory, images: imageStore }));

  ws.on('message', (msg) => {
    const data = JSON.parse(msg.toString());

    if (data.type === 'stroke') {
      const strokeData = {
        type: 'stroke',
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
          client.send(JSON.stringify(strokeData));
        }
      });
    } 
    else if (data.type === 'add_image') {
      imageStore.push(data.image);
      wss.clients.forEach((client) => {
        if (client !== ws && client.readyState === 1) {
          client.send(JSON.stringify(data));
        }
      });
    }
    else if (data.type === 'update_image') {
      const target = imageStore.find(img => img.id === data.id);
      if (target) {
        target.x = data.x;
        target.y = data.y;
        target.w = data.w;
        target.h = data.h;
        target.angle = data.angle;
      }

      wss.clients.forEach((client) => {
        if (client !== ws && client.readyState === 1) {
          client.send(JSON.stringify(data));
        }
      });
    }
    else if (data.type === 'undo') {
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
