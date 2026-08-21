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
        }
        #status { font-weight: bold; font-size: 12px; color: #00ff00; }
        
        input[type="color"] {
          border: none; width: 30px; height: 30px; border-radius: 50%;
          cursor: pointer; background: transparent;
        }
        
        button {
          background: #e74c3c; color: white; border: none; padding: 6px 12px;
          border-radius: 4px; font-weight: bold; cursor: pointer; transition: background 0.2s;
        }
        button:hover { background: #c0392b; }

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
          <input type="range" id="brushSize" min="2" max="30" value="6">
        </div>
        <button id="clearBtn">Clear Canvas</button>
      </div>

      <canvas id="paint"></canvas>

      <script>
        const status = document.getElementById('status');
        const canvas = document.getElementById('paint');
        const ctx = canvas.getContext('2d');
        const colorPicker = document.getElementById('colorPicker');
        const brushSize = document.getElementById('brushSize');
        const clearBtn = document.getElementById('clearBtn');

        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;

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

        let drawing = false;

        function drawPoint(x, y, color, size, send = true) {
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(x, y, size, 0, Math.PI * 2);
          ctx.fill();

          if (send && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: 'draw', x, y, color, size }));
          }
        }

        function clearScreen() {
          ctx.clearRect(0, 0, canvas.width, canvas.height);
        }

        canvas.addEventListener('mousedown', (e) => { 
          drawing = true; 
          drawPoint(e.clientX, e.clientY, colorPicker.value, brushSize.value); 
        });
        
        canvas.addEventListener('mousemove', (e) => { 
          if (drawing) drawPoint(e.clientX, e.clientY, colorPicker.value, brushSize.value); 
        });
        
        window.addEventListener('mouseup', () => drawing = false);

        clearBtn.addEventListener('click', () => {
          clearScreen();
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: 'clear' }));
          }
        });

        socket.onmessage = (e) => {
          const message = JSON.parse(e.data);

          if (message.type === 'history') {
            clearScreen();
            message.data.forEach(pt => drawPoint(pt.x, pt.y, pt.color, pt.size, false));
          } 
          else if (message.type === 'draw') {
            drawPoint(message.x, message.y, message.color, message.size, false);
          }
          else if (message.type === 'clear') {
            clearScreen();
          }
        };
      </script>
    </body>
    </html>
  `);
});

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'history', data: drawHistory }));

  ws.on('message', (msg) => {
    const data = JSON.parse(msg.toString());

    if (data.type === 'draw') {
      drawHistory.push({ x: data.x, y: data.y, color: data.color, size: data.size });
      wss.clients.forEach((client) => {
        if (client !== ws && client.readyState === 1) {
          client.send(JSON.stringify(data));
        }
      });
    } 
    else if (data.type === 'clear') {
      drawHistory = []; // Empty global history on server
      wss.clients.forEach((client) => {
        if (client.readyState === 1) {
          client.send(JSON.stringify({ type: 'clear' }));
        }
      });
    }
  });
});

const listener = server.listen(process.env.PORT || 3000, () => {
  console.log('Server running on port ' + listener.address().port);
});
