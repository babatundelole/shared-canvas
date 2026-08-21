const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const rooms = {};

function getOrCreateRoom(roomId, password = null) {
  if (!rooms[roomId]) {
    rooms[roomId] = {
      password: password,
      drawHistory: [],
      mediaStore: [],
      chatHistory: [],
      connectedUsers: {},
      gameState: {
        board: Array(9).fill(null),
        turn: 'X',
        winner: null,
        players: { X: null, O: null },
        visible: false,
        x: 200, y: 200
      }
    };
  }
  return rooms[roomId];
}

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
        body { margin: 0; background: #111; overflow: hidden; font-family: sans-serif; }
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
        #overlayContainer { position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; z-index: 4; }

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
          border-radius: 12px; font-weight: bold; font-size: 11px; color: #00ffcc; cursor: pointer;
        }
        
        input[type="color"] {
          border: none; width: 26px; height: 26px; border-radius: 50%;
          cursor: pointer; background: transparent;
        }
        
        select, button, label.btn, input[type="text"].room-input, input[type="password"].room-input {
          background: #333; color: white; border: 1px solid #555; padding: 5px 10px;
          border-radius: 4px; font-weight: bold; cursor: pointer; transition: all 0.2s;
          font-size: 12px;
        }
        input[type="text"].room-input, input[type="password"].room-input { cursor: text; width: 80px; }
        button:hover, label.btn:hover, select:hover { background: #444; }
        button.active { background: #e74c3c; border-color: #ff6b6b; }

        #deleteMediaBtn { background: #c0392b; border-color: #e74c3c; display: none; }
        #deleteMediaBtn:hover { background: #e74c3c; }
        input[type="file"] { display: none; }
        .control-group { display: flex; align-items: center; gap: 4px; }

        #followingBanner {
          position: fixed; top: 70px; left: 50%; transform: translateX(-50%); z-index: 10;
          background: #e74c3c; color: white; padding: 6px 14px; border-radius: 20px;
          font-size: 12px; font-weight: bold; display: none; align-items: center; gap: 8px;
          box-shadow: 0 4px 12px rgba(0,0,0,0.4);
        }
        #followingBanner button { background: #fff; color: #111; border: none; border-radius: 10px; padding: 2px 8px; }

        /* User List Popover */
        #userListMenu {
          position: fixed; top: 60px; left: 150px; z-index: 12;
          background: #222; border: 1px solid #444; border-radius: 6px;
          padding: 8px; width: 160px; display: none; flex-direction: column; gap: 6px;
          box-shadow: 0 4px 15px rgba(0,0,0,0.5);
        }
        .user-item {
          display: flex; align-items: center; justify-content: space-between;
          padding: 4px 6px; border-radius: 4px; font-size: 12px; color: #fff; cursor: pointer;
        }
        .user-item:hover { background: #333; }

        /* Profile Modal */
        #profileModal {
          position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
          background: rgba(0,0,0,0.7); z-index: 100; display: flex;
          align-items: center; justify-content: center;
        }
        .modal-content {
          background: #222; color: white; padding: 20px 24px; border-radius: 10px;
          box-shadow: 0 8px 24px rgba(0,0,0,0.6); display: flex; flex-direction: column; gap: 14px;
          min-width: 280px; border: 1px solid #444;
        }
        .modal-content h3 { margin: 0; font-size: 16px; color: #00ffcc; }
        .modal-content input[type="text"] {
          background: #111; border: 1px solid #555; color: #fff; padding: 8px 10px;
          border-radius: 4px; font-size: 13px; outline: none;
        }

        /* Chat Drawer */
        #chatDrawer {
          position: fixed; bottom: 15px; right: 15px; z-index: 10;
          width: 300px; background: rgba(0,0,0,0.9); border: 1px solid #444;
          border-radius: 8px; display: flex; flex-direction: column; overflow: hidden;
          box-shadow: 0 4px 15px rgba(0,0,0,0.6); transition: height 0.3s ease;
        }
        #chatDrawer.collapsed { height: 38px !important; }
        #chatHeader {
          background: #222; padding: 10px 14px; font-weight: bold; font-size: 13px;
          color: #fff; cursor: pointer; display: flex; justify-content: space-between;
          align-items: center; user-select: none; border-bottom: 1px solid #333;
        }
        #chatBadge {
          background: #e74c3c; color: white; font-size: 10px; padding: 2px 6px;
          border-radius: 10px; display: none;
        }
        #chatMessages {
          height: 220px; overflow-y: auto; padding: 10px; display: flex;
          flex-direction: column; gap: 8px; font-size: 12px;
        }
        .chat-msg { word-wrap: break-word; color: #ddd; line-height: 1.4; }
        .chat-msg .author { font-weight: bold; margin-right: 4px; }
        .chat-msg.system { color: #888; font-style: italic; font-size: 11px; }
        #chatInputContainer { display: flex; border-top: 1px solid #333; }
        #chatInput {
          flex: 1; background: #111; border: none; color: #fff; padding: 8px 10px;
          font-size: 12px; outline: none;
        }
        #chatSendBtn {
          background: #00ffcc; color: #111; border: none; font-weight: bold;
          padding: 0 12px; cursor: pointer; font-size: 12px;
        }
        #chatSendBtn:hover { background: #00cca3; }

        /* Tic-Tac-Toe Game Widget */
        #gameWidget {
          position: absolute; width: 220px; background: rgba(20, 20, 20, 0.95);
          border: 2px solid #00ffcc; border-radius: 10px; padding: 12px;
          box-shadow: 0 8px 24px rgba(0,0,0,0.8); z-index: 5; pointer-events: auto;
          display: none; user-select: none;
        }
        #gameHeader {
          display: flex; justify-content: space-between; align-items: center;
          font-size: 13px; font-weight: bold; color: #00ffcc; margin-bottom: 8px;
          cursor: move; padding-bottom: 4px; border-bottom: 1px solid #333;
        }
        #gameStatus { font-size: 11px; color: #aaa; text-align: center; margin-bottom: 8px; }
        .ttt-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
        .ttt-cell {
          width: 60px; height: 60px; background: #222; border: 1px solid #444;
          border-radius: 6px; display: flex; align-items: center; justify-content: center;
          font-size: 24px; font-weight: bold; color: #fff; cursor: pointer; transition: background 0.2s;
        }
        .ttt-cell:hover { background: #333; }
        .ttt-cell.x { color: #00ffcc; }
        .ttt-cell.o { color: #ff0055; }
        #resetGameBtn {
          width: 100%; margin-top: 10px; background: #333; color: #fff; border: 1px solid #555;
          padding: 6px; border-radius: 4px; font-size: 11px; font-weight: bold; cursor: pointer;
        }
        #resetGameBtn:hover { background: #444; }
      </style>
    </head>
    <body>
      <div id="profileModal">
        <div class="modal-content">
          <h3>Set Up Profile</h3>
          <label style="font-size: 12px; color: #aaa;">Display Name:</label>
          <input type="text" id="modalNameInput" placeholder="Enter name...">
          <div style="display: flex; align-items: center; gap: 10px;">
            <label style="font-size: 12px; color: #aaa;">Cursor Color:</label>
            <input type="color" id="modalColorInput">
          </div>
          <button id="saveProfileBtn" style="padding: 8px; background: #00ffcc; color: #111;">Join Canvas</button>
        </div>
      </div>

      <div id="followingBanner">
        <span id="followingText">Following User</span>
        <button id="stopFollowingBtn">Stop</button>
      </div>

      <div id="userListMenu"></div>

      <div id="toolbar">
        <span id="status">Connecting...</span>
        <span id="userBadge">👥 1 Online</span>

        <div class="control-group">
          <label>Room:</label>
          <input type="text" id="roomInput" class="room-input" placeholder="Room ID">
          <input type="password" id="roomPassInput" class="room-input" placeholder="Pass (opt)">
          <button id="joinRoomBtn">Go</button>
        </div>

        <div class="control-group">
          <label>Brush:</label>
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

        <label for="videoUpload" class="btn">Add Video</label>
        <input type="file" id="videoUpload" accept="video/*">

        <button id="toggleGameBtn">🎮 Tic-Tac-Toe</button>
        <button id="resetViewBtn">Reset View</button>
        <button id="deleteMediaBtn">Delete Selected</button>
        <button id="editProfileBtn">Profile</button>
      </div>

      <div id="chatDrawer" class="collapsed">
        <div id="chatHeader">
          <span>💬 Room Chat</span>
          <span id="chatBadge">0</span>
        </div>
        <div id="chatMessages"></div>
        <div id="chatInputContainer">
          <input type="text" id="chatInput" placeholder="Type a message..." maxlength="150">
          <button id="chatSendBtn">Send</button>
        </div>
      </div>

      <!-- Tic-Tac-Toe Widget -->
      <div id="gameWidget">
        <div id="gameHeader">
          <span>🎮 Tic-Tac-Toe</span>
          <span id="closeGameBtn" style="cursor:pointer;">✕</span>
        </div>
        <div id="gameStatus">Waiting for moves...</div>
        <div class="ttt-grid">
          <div class="ttt-cell" data-index="0"></div>
          <div class="ttt-cell" data-index="1"></div>
          <div class="ttt-cell" data-index="2"></div>
          <div class="ttt-cell" data-index="3"></div>
          <div class="ttt-cell" data-index="4"></div>
          <div class="ttt-cell" data-index="5"></div>
          <div class="ttt-cell" data-index="6"></div>
          <div class="ttt-cell" data-index="7"></div>
          <div class="ttt-cell" data-index="8"></div>
        </div>
        <button id="resetGameBtn">Restart Game</button>
      </div>

      <div id="overlayContainer"></div>
      <canvas id="mainCanvas"></canvas>
      <canvas id="cursorCanvas"></canvas>

      <script>
        const urlParams = new URLSearchParams(window.location.search);
        let currentRoom = urlParams.get('room') || 'main';
        document.getElementById('roomInput').value = currentRoom;

        const status = document.getElementById('status');
        const userBadge = document.getElementById('userBadge');
        const userListMenu = document.getElementById('userListMenu');
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
        const roomInput = document.getElementById('roomInput');
        const roomPassInput = document.getElementById('roomPassInput');
        const joinRoomBtn = document.getElementById('joinRoomBtn');
        const resetViewBtn = document.getElementById('resetViewBtn');

        const followingBanner = document.getElementById('followingBanner');
        const followingText = document.getElementById('followingText');
        const stopFollowingBtn = document.getElementById('stopFollowingBtn');

        const profileModal = document.getElementById('profileModal');
        const modalNameInput = document.getElementById('modalNameInput');
        const modalColorInput = document.getElementById('modalColorInput');
        const saveProfileBtn = document.getElementById('saveProfileBtn');
        const editProfileBtn = document.getElementById('editProfileBtn');

        const chatDrawer = document.getElementById('chatDrawer');
        const chatHeader = document.getElementById('chatHeader');
        const chatBadge = document.getElementById('chatBadge');
        const chatMessages = document.getElementById('chatMessages');
        const chatInput = document.getElementById('chatInput');
        const chatSendBtn = document.getElementById('chatSendBtn');

        // Infinite Canvas Viewport State
        let camera = { x: 0, y: 0, zoom: 1 };
        let isPanning = false;
        let panStart = { x: 0, y: 0 };
        let followingUserId = null;

        let myUserId = null;
        let myName = 'User';
        let myCursorColor = '#00ffcc';
        let unreadCount = 0;

        // Room Switcher
        joinRoomBtn.addEventListener('click', () => {
          const targetRoom = roomInput.value.trim() || 'main';
          const pass = roomPassInput.value.trim();
          let url = '?room=' + encodeURIComponent(targetRoom);
          if (pass) url += '&pass=' + encodeURIComponent(pass);
          window.location.href = url;
        });

        resetViewBtn.addEventListener('click', () => {
          camera = { x: 0, y: 0, zoom: 1 };
          stopFollowing();
          requestRender();
          renderCursors();
        });

        // Screen to World Conversion
        function screenToWorld(sx, sy) {
          return {
            x: (sx - camera.x) / camera.zoom,
            y: (sy - camera.y) / camera.zoom
          };
        }

        // World to Screen Conversion
        function worldToScreen(wx, wy) {
          return {
            x: wx * camera.zoom + camera.x,
            y: wy * camera.zoom + camera.y
          };
        }

        function resizeCanvases() {
          mainCanvas.width = window.innerWidth;
          mainCanvas.height = window.innerHeight;
          cursorCanvas.width = window.innerWidth;
          cursorCanvas.height = window.innerHeight;
          requestRender();
          renderCursors();
        }

        window.addEventListener('resize', resizeCanvases);

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
        const roomPass = urlParams.get('pass') || '';
        const socket = new WebSocket(\`\${protocol}//\${location.host}?room=\${encodeURIComponent(currentRoom)}&pass=\${encodeURIComponent(roomPass)}\`);

        socket.onopen = () => {
          status.innerText = "CONNECTED (" + currentRoom + ")";
          status.style.color = "#00ff00";
        };

        socket.onerror = () => {
          status.innerText = "FAILED";
          status.style.color = "#ff0000";
        };

        // Profile Setup
        saveProfileBtn.addEventListener('click', () => {
          if (modalNameInput.value.trim()) {
            myName = modalNameInput.value.trim();
          }
          myCursorColor = modalColorInput.value;
          profileModal.style.display = 'none';

          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({
              type: 'update_profile',
              name: myName,
              color: myCursorColor
            }));
          }
        });

        editProfileBtn.addEventListener('click', () => {
          modalNameInput.value = myName;
          modalColorInput.value = myCursorColor;
          profileModal.style.display = 'flex';
        });

        // User List & Follow Mode
        userBadge.addEventListener('click', () => {
          userListMenu.style.display = userListMenu.style.display === 'flex' ? 'none' : 'flex';
          updateUserListMenu();
        });

        function updateUserListMenu() {
          userListMenu.innerHTML = '';
          for (const uid in remoteCursors) {
            if (uid === myUserId) continue;
            const u = remoteCursors[uid];
            const div = document.createElement('div');
            div.className = 'user-item';
            div.innerHTML = \`<span style="color:\${u.color}">● \${u.name}</span> <small style="color:#aaa">Follow</small>\`;
            div.onclick = () => followUser(uid);
            userListMenu.appendChild(div);
          }
          if (userListMenu.children.length === 0) {
            userListMenu.innerHTML = '<div style="font-size:11px; color:#888;">No other users</div>';
          }
        }

        function followUser(uid) {
          followingUserId = uid;
          userListMenu.style.display = 'none';
          const u = remoteCursors[uid];
          followingText.innerText = 'Following ' + (u ? u.name : 'User');
          followingBanner.style.display = 'flex';
          updateFollowCamera();
        }

        function stopFollowing() {
          followingUserId = null;
          followingBanner.style.display = 'none';
        }

        stopFollowingBtn.addEventListener('click', stopFollowing);

        function updateFollowCamera() {
          if (!followingUserId || !remoteCursors[followingUserId]) return;
          const u = remoteCursors[followingUserId];
          if (u.x !== undefined && u.y !== undefined) {
            camera.x = window.innerWidth / 2 - u.x * camera.zoom;
            camera.y = window.innerHeight / 2 - u.y * camera.zoom;
            requestRender();
            renderCursors();
          }
        }

        // Mouse Wheel Zoom
        window.addEventListener('wheel', (e) => {
          if (e.target.closest('#toolbar') || e.target.closest('#chatDrawer') || e.target.closest('#gameWidget')) return;
          e.preventDefault();
          stopFollowing();

          const zoomFactor = e.deltaY < 0 ? 1.1 : 0.9;
          const mouseX = e.clientX;
          const mouseY = e.clientY;

          const worldPos = screenToWorld(mouseX, mouseY);
          camera.zoom = Math.max(0.1, Math.min(5, camera.zoom * zoomFactor));

          camera.x = mouseX - worldPos.x * camera.zoom;
          camera.y = mouseY - worldPos.y * camera.zoom;

          requestRender();
          renderCursors();
        }, { passive: false });

        // Chat Toggle & Messaging
        chatHeader.addEventListener('click', () => {
          chatDrawer.classList.toggle('collapsed');
          if (!chatDrawer.classList.contains('collapsed')) {
            unreadCount = 0;
            chatBadge.style.display = 'none';
            chatMessages.scrollTop = chatMessages.scrollHeight;
          }
        });

        function sendChatMessage() {
          const text = chatInput.value.trim();
          if (text && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: 'chat_msg', text }));
            chatInput.value = '';
          }
        }

        chatSendBtn.addEventListener('click', sendChatMessage);
        chatInput.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') sendChatMessage();
        });

        function appendChatMessage(author, text, color, isSystem = false) {
          const msgDiv = document.createElement('div');
          msgDiv.className = 'chat-msg' + (isSystem ? ' system' : '');
          
          if (isSystem) {
            msgDiv.innerText = text;
          } else {
            const authorSpan = document.createElement('span');
            authorSpan.className = 'author';
            authorSpan.style.color = color || '#00ffcc';
            authorSpan.innerText = author + ':';
            msgDiv.appendChild(authorSpan);
            msgDiv.appendChild(document.createTextNode(' ' + text));
          }

          chatMessages.appendChild(msgDiv);
          chatMessages.scrollTop = chatMessages.scrollHeight;

          if (chatDrawer.classList.contains('collapsed') && !isSystem) {
            unreadCount++;
            chatBadge.innerText = unreadCount;
            chatBadge.style.display = 'inline-block';
          }
        }

        // Tic-Tac-Toe Game
        const toggleGameBtn = document.getElementById('toggleGameBtn');
        const gameWidget = document.getElementById('gameWidget');
        const gameHeader = document.getElementById('gameHeader');
        const closeGameBtn = document.getElementById('closeGameBtn');
        const gameStatus = document.getElementById('gameStatus');
        const tttCells = document.querySelectorAll('.ttt-cell');
        const resetGameBtn = document.getElementById('resetGameBtn');

        let isDraggingGame = false;
        let gameDragOffset = { x: 0, y: 0 };

        toggleGameBtn.addEventListener('click', () => {
          const isVisible = gameWidget.style.display === 'block';
          const newVisible = !isVisible;
          gameWidget.style.display = newVisible ? 'block' : 'none';
          
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: 'game_toggle', visible: newVisible }));
          }
        });

        closeGameBtn.addEventListener('click', () => {
          gameWidget.style.display = 'none';
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: 'game_toggle', visible: false }));
          }
        });

        gameHeader.addEventListener('mousedown', (e) => {
          isDraggingGame = true;
          gameDragOffset = {
            x: e.clientX - gameWidget.offsetLeft,
            y: e.clientY - gameWidget.offsetTop
          };
        });

        window.addEventListener('mousemove', (e) => {
          if (isDraggingGame) {
            const nx = e.clientX - gameDragOffset.x;
            const ny = e.clientY - gameDragOffset.y;
            gameWidget.style.left = nx + 'px';
            gameWidget.style.top = ny + 'px';

            if (socket.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify({ type: 'game_move_widget', x: nx, y: ny }));
            }
          }
        });

        window.addEventListener('mouseup', () => {
          isDraggingGame = false;
        });

        tttCells.forEach(cell => {
          cell.addEventListener('click', () => {
            const index = parseInt(cell.getAttribute('data-index'));
            if (socket.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify({ type: 'game_click', index }));
            }
          });
        });

        resetGameBtn.addEventListener('click', () => {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: 'game_reset' }));
          }
        });

        function renderGameState(state) {
          if (!state) return;

          gameWidget.style.display = state.visible ? 'block' : 'none';
          gameWidget.style.left = state.x + 'px';
          gameWidget.style.top = state.y + 'px';

          tttCells.forEach((cell, idx) => {
            const val = state.board[idx];
            cell.innerText = val || '';
            cell.className = 'ttt-cell' + (val ? ' ' + val.toLowerCase() : '');
          });

          if (state.winner) {
            gameStatus.innerText = state.winner === 'Draw' ? "Game ended in a Draw!" : \`Player \${state.winner} Wins!\`;
          } else {
            gameStatus.innerText = \`Turn: Player \${state.turn}\`;
          }
        }

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
          
          mainCtx.save();
          mainCtx.translate(camera.x, camera.y);
          mainCtx.scale(camera.zoom, camera.zoom);

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

          mainCtx.restore();
        }

        function drawSelectionControls(obj) {
          mainCtx.strokeStyle = '#00ffcc';
          mainCtx.lineWidth = 2 / camera.zoom;
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

          const screenPos = worldToScreen(obj.x, obj.y);
          wrapper.style.left = screenPos.x + 'px';
          wrapper.style.top = screenPos.y + 'px';
          wrapper.style.width = (obj.w * camera.zoom) + 'px';
          wrapper.style.height = (obj.h * camera.zoom) + 'px';
          wrapper.style.transform = \`rotate(\${obj.angle || 0}rad)\`;
        }

        function renderCursors() {
          cursorCtx.clearRect(0, 0, cursorCanvas.width, cursorCanvas.height);

          for (const uid in remoteCursors) {
            if (uid === myUserId) continue;
            const cursor = remoteCursors[uid];
            if (cursor.x === undefined || cursor.y === undefined) continue;

            const screenPos = worldToScreen(cursor.x, cursor.y);

            cursorCtx.save();
            cursorCtx.translate(screenPos.x, screenPos.y);

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

        function sendCursorPosition(worldX, worldY) {
          const now = Date.now();
          if (now - lastCursorSend > 30) {
            if (socket.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify({ type: 'cursor_move', x: worldX, y: worldY }));
            }
            lastCursorSend = now;
          }
        }

        mainCanvas.addEventListener('contextmenu', (e) => e.preventDefault());
        cursorCanvas.addEventListener('contextmenu', (e) => e.preventDefault());

        mainCanvas.addEventListener('mousedown', (e) => {
          // Pan canvas with Right Click (button 2)
          if (e.button === 2) {
            isPanning = true;
            panStart = { x: e.clientX - camera.x, y: e.clientY - camera.y };
            stopFollowing();
            return;
          }

          if (e.button !== 0) return;

          const worldPos = screenToWorld(e.clientX, e.clientY);

          if (selectedMedia && selectedMedia.ownerId === myUserId) {
            const handle = getHitHandle(selectedMedia, worldPos.x, worldPos.y);
            if (handle) {
              dragMode = handle;
              isDragging = true;
              return;
            }
          }

          const hitMedia = getHitMedia(worldPos.x, worldPos.y);
          if (hitMedia) {
            selectedMedia = hitMedia;
            dragMode = 'move';
            isDragging = true;
            dragOffset = { x: worldPos.x - selectedMedia.x, y: worldPos.y - selectedMedia.y };
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
          lastPos = worldPos;
          handlePointerMove(e);
        });

        function handlePointerMove(e) {
          if (isPanning) {
            camera.x = e.clientX - panStart.x;
            camera.y = e.clientY - panStart.y;
            requestRender();
            renderCursors();
            return;
          }

          const worldPos = screenToWorld(e.clientX, e.clientY);
          sendCursorPosition(worldPos.x, worldPos.y);

          if (dragMode === 'move' && selectedMedia && selectedMedia.ownerId === myUserId) {
            selectedMedia.x = worldPos.x - dragOffset.x;
            selectedMedia.y = worldPos.y - dragOffset.y;
            requestRender();
            syncMediaUpdateThrottled(selectedMedia);
            return;
          }

          if (dragMode === 'resize' && selectedMedia && selectedMedia.ownerId === myUserId) {
            const local = toLocalCoords(selectedMedia, worldPos.x, worldPos.y);
            selectedMedia.w = Math.max(50, local.x * 2);
            selectedMedia.h = Math.max(50, local.y * 2);
            requestRender();
            syncMediaUpdateThrottled(selectedMedia);
            return;
          }

          if (dragMode === 'rotate' && selectedMedia && selectedMedia.ownerId === myUserId) {
            const cx = selectedMedia.x + selectedMedia.w / 2;
            const cy = selectedMedia.y + selectedMedia.h / 2;
            selectedMedia.angle = Math.atan2(worldPos.y - cy, worldPos.x - cx) + Math.PI / 2;
            requestRender();
            syncMediaUpdateThrottled(selectedMedia);
            return;
          }

          if (!drawing) return;

          const currentPos = worldPos;
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
          isPanning = false;
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
            const centerWorld = screenToWorld(window.innerWidth / 2, window.innerHeight / 2);
            const reader = new FileReader();
            reader.onload = (event) => {
              const newMediaData = {
                id: Math.random().toString(36).substring(2, 10),
                ownerId: myUserId,
                mediaType: 'image',
                src: event.target.result,
                x: centerWorld.x - 100, y: centerWorld.y - 100,
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
            const centerWorld = screenToWorld(window.innerWidth / 2, window.innerHeight / 2);
            const reader = new FileReader();
            reader.onload = (event) => {
              const newMediaData = {
                id: Math.random().toString(36).substring(2, 10),
                ownerId: myUserId,
                mediaType: 'video',
                src: event.target.result,
                x: centerWorld.x - 160, y: centerWorld.y - 120,
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
          if (document.activeElement === chatInput || document.activeElement === modalNameInput || document.activeElement === roomInput || document.activeElement === roomPassInput) return;

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

          if (message.type === 'error') {
            alert(message.message);
            window.location.href = '?room=main';
            return;
          }

          if (message.type === 'init') {
            myUserId = message.userId;
            myName = message.user.name;
            myCursorColor = message.user.color;

            modalNameInput.value = myName;
            modalColorInput.value = myCursorColor;

            remoteCursors = message.users || {};
            userBadge.innerText = \`👥 \${Object.keys(remoteCursors).length} Online\`;

            if (message.media) {
              message.media.forEach(m => addMediaToCanvas(m));
            }

            if (message.chats) {
              message.chats.forEach(c => appendChatMessage(c.author, c.text, c.color));
            }

            renderGameState(message.gameState);
            rebuildFromHistory(message.history);
            resizeCanvases();
          } 
          else if (message.type === 'user_joined') {
            remoteCursors[message.user.userId] = message.user;
            userBadge.innerText = \`👥 \${Object.keys(remoteCursors).length} Online\`;
            appendChatMessage(null, \`\${message.user.name} joined the room\`, null, true);
            updateUserListMenu();
            renderCursors();
          }
          else if (message.type === 'user_left') {
            const leftUser = remoteCursors[message.userId];
            if (leftUser) {
              appendChatMessage(null, \`\${leftUser.name} left\`, null, true);
            }
            delete remoteCursors[message.userId];
            userBadge.innerText = \`👥 \${Object.keys(remoteCursors).length} Online\`;
            updateUserListMenu();
            renderCursors();
          }
          else if (message.type === 'update_profile') {
            if (remoteCursors[message.userId]) {
              remoteCursors[message.userId].name = message.name;
              remoteCursors[message.userId].color = message.color;
              updateUserListMenu();
              renderCursors();
            }
          }
          else if (message.type === 'chat_msg') {
            appendChatMessage(message.author, message.text, message.color);
          }
          else if (message.type === 'game_update') {
            renderGameState(message.gameState);
          }
          else if (message.type === 'cursor_move') {
            if (remoteCursors[message.userId]) {
              remoteCursors[message.userId].x = message.x;
              remoteCursors[message.userId].y = message.y;
              if (followingUserId === message.userId) {
                updateFollowCamera();
              }
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

let undoneHistory = {};

function checkTTTWinner(board) {
  const lines = [
    [0, 1, 2], [3, 4, 5], [6, 7, 8],
    [0, 3, 6], [1, 4, 7], [2, 5, 8],
    [0, 4, 8], [2, 4, 6]
  ];
  for (let l of lines) {
    if (board[l[0]] && board[l[0]] === board[l[1]] && board[l[0]] === board[l[2]]) {
      return board[l[0]];
    }
  }
  if (board.every(cell => cell !== null)) return 'Draw';
  return null;
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const roomId = url.searchParams.get('room') || 'main';
  const providedPass = url.searchParams.get('pass') || null;

  if (rooms[roomId] && rooms[roomId].password && rooms[roomId].password !== providedPass) {
    ws.send(JSON.stringify({ type: 'error', message: 'Incorrect room password.' }));
    ws.close();
    return;
  }

  const room = getOrCreateRoom(roomId, providedPass);

  if (!undoneHistory[roomId]) undoneHistory[roomId] = [];

  const userId = Math.random().toString(36).substring(2, 10);
  const userColor = getRandomColor();
  const userName = 'User ' + userId.substring(0, 4);

  room.connectedUsers[userId] = {
    userId,
    color: userColor,
    name: userName,
    ws,
    x: 0,
    y: 0
  };

  function broadcastRoom(data, excludeWs = null) {
    for (let id in room.connectedUsers) {
      const clientWs = room.connectedUsers[id].ws;
      if (clientWs !== excludeWs && clientWs.readyState === 1) {
        clientWs.send(JSON.stringify(data));
      }
    }
  }

  function getSanitizedUsers() {
    const list = {};
    for (let id in room.connectedUsers) {
      const u = room.connectedUsers[id];
      list[id] = { userId: u.userId, color: u.color, name: u.name, x: u.x, y: u.y };
    }
    return list;
  }

  ws.send(JSON.stringify({ 
    type: 'init', 
    userId, 
    user: { userId, color: userColor, name: userName },
    history: room.drawHistory, 
    media: room.mediaStore,
    chats: room.chatHistory,
    gameState: room.gameState,
    users: getSanitizedUsers() 
  }));

  broadcastRoom({
    type: 'user_joined',
    user: { userId, color: userColor, name: userName }
  }, ws);

  ws.on('message', (msg) => {
    const data = JSON.parse(msg.toString());

    if (data.type === 'update_profile') {
      if (room.connectedUsers[userId]) {
        room.connectedUsers[userId].name = data.name;
        room.connectedUsers[userId].color = data.color;

        broadcastRoom({
          type: 'update_profile',
          userId,
          name: data.name,
          color: data.color
        });
      }
    }
    else if (data.type === 'chat_msg') {
      const user = room.connectedUsers[userId];
      const chatItem = {
        author: user ? user.name : 'User',
        text: data.text,
        color: user ? user.color : '#00ffcc'
      };
      
      room.chatHistory.push(chatItem);
      if (room.chatHistory.length > 50) room.chatHistory.shift();

      broadcastRoom({
        type: 'chat_msg',
        ...chatItem
      });
    }
    else if (data.type === 'game_toggle') {
      room.gameState.visible = data.visible;
      broadcastRoom({ type: 'game_update', gameState: room.gameState });
    }
    else if (data.type === 'game_move_widget') {
      room.gameState.x = data.x;
      room.gameState.y = data.y;
      broadcastRoom({ type: 'game_update', gameState: room.gameState }, ws);
    }
    else if (data.type === 'game_click') {
      const idx = data.index;
      if (!room.gameState.board[idx] && !room.gameState.winner) {
        room.gameState.board[idx] = room.gameState.turn;
        const win = checkTTTWinner(room.gameState.board);
        if (win) {
          room.gameState.winner = win;
        } else {
          room.gameState.turn = room.gameState.turn === 'X' ? 'O' : 'X';
        }
        broadcastRoom({ type: 'game_update', gameState: room.gameState });
      }
    }
    else if (data.type === 'game_reset') {
      room.gameState.board = Array(9).fill(null);
      room.gameState.turn = 'X';
      room.gameState.winner = null;
      broadcastRoom({ type: 'game_update', gameState: room.gameState });
    }
    else if (data.type === 'cursor_move') {
      if (room.connectedUsers[userId]) {
        room.connectedUsers[userId].x = data.x;
        room.connectedUsers[userId].y = data.y;

        broadcastRoom({
          type: 'cursor_move',
          userId,
          x: data.x,
          y: data.y
        }, ws);
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

      room.drawHistory.push(strokeData);
      broadcastRoom(strokeData);
    } 
    else if (data.type === 'add_media') {
      data.media.ownerId = userId;
      room.mediaStore.push(data.media);
      broadcastRoom(data, ws);
    }
    else if (data.type === 'update_media') {
      const target = room.mediaStore.find(m => m.id === data.id);
      if (target && target.ownerId === userId) {
        target.x = data.x;
        target.y = data.y;
        target.w = data.w;
        target.h = data.h;
        target.angle = data.angle;

        broadcastRoom(data, ws);
      }
    }
    else if (data.type === 'delete_media') {
      const target = room.mediaStore.find(m => m.id === data.id);
      if (target && target.ownerId === userId) {
        room.mediaStore = room.mediaStore.filter(m => m.id !== data.id);
        broadcastRoom(data, ws);
      }
    }
    else if (data.type === 'undo') {
      const removed = room.drawHistory.filter(item => item.strokeId === data.strokeId);
      room.drawHistory = room.drawHistory.filter(item => item.strokeId !== data.strokeId);
      undoneHistory[roomId].push(...removed);

      broadcastRoom({ type: 'update_history', history: room.drawHistory });
    }
    else if (data.type === 'redo') {
      const restored = undoneHistory[roomId].filter(item => item.strokeId === data.strokeId);
      undoneHistory[roomId] = undoneHistory[roomId].filter(item => item.strokeId !== data.strokeId);
      room.drawHistory.push(...restored);

      broadcastRoom({ type: 'update_history', history: room.drawHistory });
    }
  });

  ws.on('close', () => {
    delete room.connectedUsers[userId];
    broadcastRoom({
      type: 'user_left',
      userId
    });
  });
});

const listener = server.listen(process.env.PORT || 3000, () => {
  console.log('Server running on port ' + listener.address().port);
});
