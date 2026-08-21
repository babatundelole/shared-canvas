const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

let drawHistory = [];
let mediaStore = [];
const connectedUsers = {};

function getRandomColor() {
  const letters = '0123456789ABCDEF';
  let color = '#';
  for (let i = 0; i < 6; i++) {
    color += letters[Math.floor(Math.random() * 16)];
  }
  return color;
}

app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Collaborative Canvas</title>
      <style>
        body { margin: 0; background: #111; overflow: hidden; font-family: sans-serif; transition: background 0.3s; }
        body.theme-light { background: #f4f4f9; }
        body.theme-grid { 
          background-color: #111;
          background-image: linear-gradient(rgba(255,255,255,0.05) 1px, transparent 1px),
                            linear-gradient(90deg, rgba(255,255,255,0.05) 1px, transparent 1px);
          background-size: 20px 20px;
        }

        canvas { display: block; position: absolute; top: 0; left: 0; }
        #mainCanvas { z-index: 2; }
        #cursorCanvas { z-index: 3; pointer-events: none; }
        #overlayContainer { position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; z-index: 1; }

        .canvas-video-wrapper {
          position: absolute;
          transform-origin: center center;
          pointer-events: none;
          box-sizing: border-box;
        }

        .canvas-video-wrapper video {
          width: 100%; height: 100%; border: none; display: block; object-fit: cover; background: #000; pointer-events: none;
        }

        #toolbar {
          position: fixed; top: 15px; left: 15px; z-index: 10;
          background: rgba(0,0,0,0.85); padding: 10px 14px;
          border-radius: 8px; display: flex; align-items: center; gap: 10px;
          color: #fff; font-size: 13px; box-shadow: 0 4px 10px rgba(0,0,0,0.5);
          user-select: none; flex-wrap: wrap;
        }
        #status { font-weight: bold; font-size: 11px; color: #00ff00; margin-right: 5px; }
        #userBadge { 
          background: #222; border: 1px solid #444; padding: 3px 8px; 
          border-radius: 12px; font-weight: bold; font-size: 11px; color: #00ffcc; 
        }
        
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

        #deleteMediaBtn { background: #c0392b; border-color: #e74c3c; display: none; }
        #deleteMediaBtn:hover { background: #e74c3c; }
        input[type="file"] { display: none; }
        .control-group { display: flex; align-items: center; gap: 4px; }
      </style>
    </head>
    <body>
      <div id="toolbar">
        <span id="status">Connecting...</span>
        <span id="userBadge">👥 1 Online</span>

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

        <label for="videoUpload" class="btn">Add Video File</label>
        <input type="file" id="videoUpload" accept="video/*">

        <button id="deleteMediaBtn">Delete Selected</button>
      </div>

      <div id="overlayContainer"></div>
      <canvas id="mainCanvas"></canvas>
      <canvas id="cursorCanvas"></canvas>

      <script>
        const status = document.getElementById('status');
        const userBadge = document.getElementById('userBadge');
        const mainCanvas = document.getElementById('mainCanvas');
        const mainCtx = mainCanvas.getContext('2d');
        const cursorCanvas = document.getElementById('cursorCanvas');
        const cursorCtx = cursorCanvas.getContext('2d');
        const overlayContainer = document.getElementById('overlayContainer');

        const colorPicker = document.getElementById('colorPicker');
        const brushSize = document.getElementById('brushSize');
        const eraseBtn = document.getElementById('eraseBtn');
        const undoBtn = document.getElementById('undoBtn');
        const redoBtn = document.getElementById('redoBtn');
        const bgSelect = document.getElementById('bgSelect');
        const imgUpload = document.getElementById('imgUpload');
        const videoUpload = document.getElementById('videoUpload');
        const deleteMediaBtn = document.getElementById('deleteMediaBtn');

        function resizeCanvases() {
          mainCanvas.width = window.innerWidth;
          mainCanvas.height = window.innerHeight;
          cursorCanvas.width = window.innerWidth;
          cursorCanvas.height = window.innerHeight;
          requestRender();
          renderCursors();
        }

        window.addEventListener('resize', resizeCanvases);

        let myUserId = null;
        let isEraserMode = false;
        let drawing = false;
        let lastPos = null;

        const undoStack = [];
        const redoStack = [];
        let currentStrokeId = null;

        const userLayers = {};
        let remoteCursors = {};
        
        let mediaObjects = [];
        let selectedMedia = null;
        let dragMode = null;
        let isDragging = false;
        let dragOffset = { x: 0, y: 0 };
        const HANDLE_SIZE = 12;
        const ROTATE_HANDLE_OFFSET = 30;

        let renderScheduled = false;
        let lastNetworkSend = 0;
        let lastCursorSend = 0;

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

        function updateDeleteBtnVisibility() {
          deleteMediaBtn.style.display = (selectedMedia && selectedMedia.ownerId === myUserId) ? 'inline-block' : 'none';
        }

        function flattenLayersToMain() {
          renderScheduled = false;
          mainCtx.clearRect(0, 0, mainCanvas.width, mainCanvas.height);
          
          mediaObjects.forEach(obj => {
            if (obj.mediaType === 'image' && obj.imgElement && obj.imgElement.complete) {
              mainCtx.save();
              const cx = obj.x + obj.w / 2;
              const cy = obj.y + obj.h / 2;
              mainCtx.translate(cx, cy);
              mainCtx.rotate(obj.angle || 0);

              mainCtx.drawImage(obj.imgElement, -obj.w / 2, -obj.h / 2, obj.w, obj.h);

              if (obj === selectedMedia && obj.ownerId === myUserId) {
                drawSelectionControls(obj);
              }
              mainCtx.restore();
            } else if (obj.mediaType === 'video') {
              updateVideoDOMElement(obj);

              mainCtx.save();
              const cx = obj.x + obj.w / 2;
              const cy = obj.y + obj.h / 2;
              mainCtx.translate(cx, cy);
              mainCtx.rotate(obj.angle || 0);

              if (obj === selectedMedia && obj.ownerId === myUserId) {
                drawSelectionControls(obj);
              }
              mainCtx.restore();
            }
          });

          for (const uid in userLayers) {
            mainCtx.drawImage(userLayers[uid].canvas, 0, 0);
          }
        }

        function drawSelectionControls(obj) {
          mainCtx.strokeStyle = '#00ffcc';
          mainCtx.lineWidth = 2;
          mainCtx.strokeRect(-obj.w / 2, -obj.h / 2, obj.w, obj.h);

          mainCtx.fillStyle = '#00ffcc';
          mainCtx.fillRect(obj.w / 2 - HANDLE_SIZE, obj.h / 2 - HANDLE_SIZE, HANDLE_SIZE, HANDLE_SIZE);

          mainCtx.beginPath();
          mainCtx.moveTo(0, -obj.h / 2);
          mainCtx.lineTo(0, -obj.h / 2 - ROTATE_HANDLE_OFFSET);
          mainCtx.stroke();

          mainCtx.beginPath();
          mainCtx.arc(0, -obj.h / 2 - ROTATE_HANDLE_OFFSET, 6, 0, Math.PI * 2);
          mainCtx.fill();
        }

        function updateVideoDOMElement(obj) {
          let wrapper = document.getElementById('video_wrapper_' + obj.id);
          if (!wrapper) {
            wrapper = document.createElement('div');
            wrapper.id = 'video_wrapper_' + obj.id;
            wrapper.className = 'canvas-video-wrapper';

            const video = document.createElement('video');
            video.src = obj.src;
            video.muted = true;
            video.autoplay = true;
            video.loop = true;
            video.playsInline = true;

            wrapper.appendChild(video);
            overlayContainer.appendChild(wrapper);
            
            video.play().catch(e => console.log('Autoplay blocked:', e));
          }

          wrapper.style.left = obj.x + 'px';
          wrapper.style.top = obj.y + 'px';
          wrapper.style.width = obj.w + 'px';
          wrapper.style.height = obj.h + 'px';
          wrapper.style.transform = \`rotate(\${obj.angle || 0}rad)\`;
        }

        function renderCursors() {
          cursorCtx.clearRect(0, 0, cursorCanvas.width, cursorCanvas.height);

          for (const uid in remoteCursors) {
            if (uid === myUserId) continue;
            const cursor = remoteCursors[uid];
            if (cursor.x === undefined || cursor.y === undefined) continue;

            cursorCtx.save();
            cursorCtx.translate(cursor.x, cursor.y);

            // Draw Pointer Arrow
            cursorCtx.beginPath();
            cursorCtx.moveTo(0, 0);
            cursorCtx.lineTo(0, 16);
            cursorCtx.lineTo(4, 12);
            cursorCtx.lineTo(9, 17);
            cursorCtx.lineTo(12, 15);
            cursorCtx.lineTo(7, 10);
            cursorCtx.lineTo(14, 10);
            cursorCtx.closePath();

            cursorCtx.fillStyle = cursor.color || '#ff0055';
            cursorCtx.fill();
            cursorCtx.strokeStyle = '#ffffff';
            cursorCtx.lineWidth = 1.5;
            cursorCtx.stroke();

            // Draw User Tag
            const label = cursor.name || ('User ' + uid.substring(0, 4));
            cursorCtx.font = '11px sans-serif';
            cursorCtx.fillStyle = 'rgba(0, 0, 0, 0.75)';
            const textWidth = cursorCtx.measureText(label).width;
            cursorCtx.fillRect(14, 14, textWidth + 8, 18);

            cursorCtx.fillStyle = '#ffffff';
            cursorCtx.fillText(label, 18, 27);

            cursorCtx.restore();
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

        function addMediaToCanvas(mediaData) {
          if (mediaData.mediaType === 'image') {
            const img = new Image();
            img.src = mediaData.src;
            const obj = { angle: 0, ...mediaData, imgElement: img };
            img.onload = () => {
              mediaObjects.push(obj);
              requestRender();
            };
          } else if (mediaData.mediaType === 'video') {
            const obj = { angle: 0, ...mediaData };
            mediaObjects.push(obj);
            requestRender();
          }
        }

        function removeMediaById(id) {
          if (selectedMedia && selectedMedia.id === id) {
            selectedMedia = null;
            updateDeleteBtnVisibility();
          }

          const wrapper = document.getElementById('video_wrapper_' + id);
          if (wrapper) wrapper.remove();

          mediaObjects = mediaObjects.filter(m => m.id !== id);
          requestRender();
        }

        function deleteSelectedMedia() {
          if (!selectedMedia || selectedMedia.ownerId !== myUserId) return;
          const idToDelete = selectedMedia.id;
          removeMediaById(idToDelete);

          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: 'delete_media', id: idToDelete }));
          }
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

        function getHitMedia(worldX, worldY) {
          for (let i = mediaObjects.length - 1; i >= 0; i--) {
            const obj = mediaObjects[i];
            if (obj.ownerId !== myUserId) continue;

            const local = toLocalCoords(obj, worldX, worldY);
            if (local.x >= -obj.w / 2 && local.x <= obj.w / 2 &&
                local.y >= -obj.h / 2 && local.y <= obj.h / 2) {
              return obj;
            }
          }
          return null;
        }

        function sendCursorPosition(x, y) {
          const now = Date.now();
          if (now - lastCursorSend > 30) {
            if (socket.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify({ type: 'cursor_move', x, y }));
            }
            lastCursorSend = now;
          }
        }

        mainCanvas.addEventListener('contextmenu', (e) => e.preventDefault());
        cursorCanvas.addEventListener('contextmenu', (e) => e.preventDefault());

        mainCanvas.addEventListener('mousedown', (e) => {
          if (e.button !== 0) return;

          const x = e.clientX;
          const y = e.clientY;

          if (selectedMedia && selectedMedia.ownerId === myUserId) {
            const handle = getHitHandle(selectedMedia, x, y);
            if (handle) {
              dragMode = handle;
              isDragging = true;
              return;
            }
          }

          const hitMedia = getHitMedia(x, y);
          if (hitMedia) {
            selectedMedia = hitMedia;
            dragMode = 'move';
            isDragging = true;
            dragOffset = { x: x - selectedMedia.x, y: y - selectedMedia.y };
            updateDeleteBtnVisibility();
            requestRender();
            return;
          }

          if (selectedMedia) {
            selectedMedia = null;
            updateDeleteBtnVisibility();
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

          sendCursorPosition(x, y);

          if (dragMode === 'move' && selectedMedia && selectedMedia.ownerId === myUserId) {
            selectedMedia.x = x - dragOffset.x;
            selectedMedia.y = y - dragOffset.y;
            requestRender();
            syncMediaUpdateThrottled(selectedMedia);
            return;
          }

          if (dragMode === 'resize' && selectedMedia && selectedMedia.ownerId === myUserId) {
            const local = toLocalCoords(selectedMedia, x, y);
            selectedMedia.w = Math.max(50, local.x * 2);
            selectedMedia.h = Math.max(50, local.y * 2);
            requestRender();
            syncMediaUpdateThrottled(selectedMedia);
            return;
          }

          if (dragMode === 'rotate' && selectedMedia && selectedMedia.ownerId === myUserId) {
            const cx = selectedMedia.x + selectedMedia.w / 2;
            const cy = selectedMedia.y + selectedMedia.h / 2;
            selectedMedia.angle = Math.atan2(y - cy, x - cx) + Math.PI / 2;
            requestRender();
            syncMediaUpdateThrottled(selectedMedia);
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

        // Track cursor even when mouse is simply hovering over canvas
        mainCanvas.addEventListener('mousemove', handlePointerMove);

        window.addEventListener('mouseup', () => {
          if (dragMode && selectedMedia && selectedMedia.ownerId === myUserId) {
            syncMediaUpdate(selectedMedia);
          }
          drawing = false;
          isDragging = false;
          dragMode = null;
          lastPos = null;
        });

        function syncMediaUpdateThrottled(mediaObj) {
          const now = Date.now();
          if (now - lastNetworkSend > 40) {
            syncMediaUpdate(mediaObj);
            lastNetworkSend = now;
          }
        }

        function syncMediaUpdate(mediaObj) {
          if (socket.readyState === WebSocket.OPEN && mediaObj.ownerId === myUserId) {
            socket.send(JSON.stringify({
              type: 'update_media',
              id: mediaObj.id,
              x: mediaObj.x,
              y: mediaObj.y,
              w: mediaObj.w,
              h: mediaObj.h,
              angle: mediaObj.angle
            }));
          }
        }

        imgUpload.addEventListener('change', (e) => {
          const file = e.target.files[0];
          if (file) {
            const reader = new FileReader();
            reader.onload = (event) => {
              const newMediaData = {
                id: Math.random().toString(36).substring(2, 10),
                ownerId: myUserId,
                mediaType: 'image',
                src: event.target.result,
                x: 100, y: 100,
                w: 200, h: 200,
                angle: 0
              };

              addMediaToCanvas(newMediaData);
              selectedMedia = mediaObjects[mediaObjects.length - 1];
              updateDeleteBtnVisibility();

              if (socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({ type: 'add_media', media: newMediaData }));
              }
            };
            reader.readAsDataURL(file);
          }
          e.target.value = '';
        });

        videoUpload.addEventListener('change', (e) => {
          const file = e.target.files[0];
          if (file) {
            const reader = new FileReader();
            reader.onload = (event) => {
              const newMediaData = {
                id: Math.random().toString(36).substring(2, 10),
                ownerId: myUserId,
                mediaType: 'video',
                src: event.target.result,
                x: 150, y: 150,
                w: 320, h: 240,
                angle: 0
              };

              addMediaToCanvas(newMediaData);
              selectedMedia = mediaObjects[mediaObjects.length - 1];
              updateDeleteBtnVisibility();

              if (socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({ type: 'add_media', media: newMediaData }));
              }
            };
            reader.readAsDataURL(file);
          }
          e.target.value = '';
        });

        deleteMediaBtn.addEventListener('click', deleteSelectedMedia);

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
          if (e.key === 'Delete' || e.key === 'Backspace') {
            if (selectedMedia && selectedMedia.ownerId === myUserId) {
              e.preventDefault();
              deleteSelectedMedia();
            }
          }
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
            remoteCursors = message.users || {};
            userBadge.innerText = \`👥 \${Object.keys(remoteCursors).length} Online\`;

            if (message.media) {
              message.media.forEach(m => addMediaToCanvas(m));
            }
            
            rebuildFromHistory(message.history);
            resizeCanvases();
          } 
          else if (message.type === 'user_joined') {
            remoteCursors[message.user.userId] = message.user;
            userBadge.innerText = \`👥 \${Object.keys(remoteCursors).length} Online\`;
            renderCursors();
          }
          else if (message.type === 'user_left') {
            delete remoteCursors[message.userId];
            userBadge.innerText = \`👥 \${Object.keys(remoteCursors).length} Online\`;
            renderCursors();
          }
          else if (message.type === 'cursor_move') {
            if (remoteCursors[message.userId]) {
              remoteCursors[message.userId].x = message.x;
              remoteCursors[message.userId].y = message.y;
              renderCursors();
            }
          }
          else if (message.type === 'stroke') {
            if (message.userId !== myUserId) {
              strokeSegment(message.userId, message.x1, message.y1, message.x2, message.y2, message.color, message.size, message.isEraser);
            }
          }
          else if (message.type === 'add_media') {
            addMediaToCanvas(message.media);
          }
          else if (message.type === 'update_media') {
            if (isDragging && selectedMedia && selectedMedia.id === message.id) return;

            const target = mediaObjects.find(m => m.id === message.id);
            if (target) {
              target.x = message.x;
              target.y = message.y;
              target.w = message.w;
              target.h = message.h;
              target.angle = message.angle;
              requestRender();
            }
          }
          else if (message.type === 'delete_media') {
            removeMediaById(message.id);
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

let undoneHistory = [];

wss.on('connection', (ws) => {
  const userId = Math.random().toString(36).substring(2, 10);
  const userColor = getRandomColor();
  const userName = 'User ' + userId.substring(0, 4);

  connectedUsers[userId] = {
    userId,
    color: userColor,
    name: userName,
    x: 0,
    y: 0
  };

  ws.send(JSON.stringify({ 
    type: 'init', 
    userId, 
    history: drawHistory, 
    media: mediaStore,
    users: connectedUsers 
  }));

  wss.clients.forEach((client) => {
    if (client !== ws && client.readyState === 1) {
      client.send(JSON.stringify({
        type: 'user_joined',
        user: connectedUsers[userId]
      }));
    }
  });

  ws.on('message', (msg) => {
    const data = JSON.parse(msg.toString());

    if (data.type === 'cursor_move') {
      if (connectedUsers[userId]) {
        connectedUsers[userId].x = data.x;
        connectedUsers[userId].y = data.y;

        wss.clients.forEach((client) => {
          if (client !== ws && client.readyState === 1) {
            client.send(JSON.stringify({
              type: 'cursor_move',
              userId,
              x: data.x,
              y: data.y
            }));
          }
        });
      }
    }
    else if (data.type === 'stroke') {
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
    else if (data.type === 'add_media') {
      data.media.ownerId = userId;
      mediaStore.push(data.media);
      wss.clients.forEach((client) => {
        if (client !== ws && client.readyState === 1) {
          client.send(JSON.stringify(data));
        }
      });
    }
    else if (data.type === 'update_media') {
      const target = mediaStore.find(m => m.id === data.id);
      if (target && target.ownerId === userId) {
        target.x = data.x;
        target.y = data.y;
        target.w = data.w;
        target.h = data.h;
        target.angle = data.angle;

        wss.clients.forEach((client) => {
          if (client !== ws && client.readyState === 1) {
            client.send(JSON.stringify(data));
          }
        });
      }
    }
    else if (data.type === 'delete_media') {
      const target = mediaStore.find(m => m.id === data.id);
      if (target && target.ownerId === userId) {
        mediaStore = mediaStore.filter(m => m.id !== data.id);
        wss.clients.forEach((client) => {
          if (client !== ws && client.readyState === 1) {
            client.send(JSON.stringify(data));
          }
        });
      }
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

  ws.on('close', () => {
    delete connectedUsers[userId];
    wss.clients.forEach((client) => {
      if (client.readyState === 1) {
        client.send(JSON.stringify({
          type: 'user_left',
          userId
        }));
      }
    });
  });
});

const listener = server.listen(process.env.PORT || 3000, () => {
  console.log('Server running on port ' + listener.address().port);
});
