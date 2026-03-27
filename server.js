const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
    }
});

const PORT = process.env.PORT || 3000;

// Game State
const players = {};
const foods = [];
const WORLD_SIZE = 8000;
const TOTAL_FOOD = 1500;

function spawnFood() {
    const angle = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * (WORLD_SIZE / 2 - 20);
    return {
        id: Math.random().toString(36).substr(2, 9),
        x: WORLD_SIZE / 2 + Math.cos(angle) * r,
        y: WORLD_SIZE / 2 + Math.sin(angle) * r,
        radius: Math.random() * 1 + 2,
        color: ['#ff0055', '#00ffaa', '#00ddff', '#ffdd00', '#ff6600', '#aa00ff', '#e0e0ff', '#ff00aa'][Math.floor(Math.random() * 8)],
        phase: Math.random() * Math.PI * 2,
        floatOffset: Math.random() * Math.PI * 2,
        isDeathFood: false
    };
}

// Initial food
for (let i = 0; i < TOTAL_FOOD; i++) {
    foods.push(spawnFood());
}

app.use(express.static(__dirname));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'cobra.html'));
});

io.on('connection', (socket) => {
    console.log(`Player connected: ${socket.id}`);

    socket.on('join', (data) => {
        players[socket.id] = {
            id: socket.id,
            name: data.name || 'Convidado',
            x: WORLD_SIZE / 2,
            y: WORLD_SIZE / 2,
            angle: 0,
            score: 0,
            length: 23,
            radius: 20,
            history: [],
            skinIndex: data.skinIndex || 0,
            isBoosting: false
        };

        // Send current state to the new player
        socket.emit('init', {
            id: socket.id,
            players,
            foods,
            config: {
                WORLD_SIZE,
                TOTAL_FOOD
            }
        });

        // Notify others
        socket.broadcast.emit('playerJoined', players[socket.id]);
    });

    socket.on('update', (data) => {
        if (players[socket.id]) {
            Object.assign(players[socket.id], data);
            // Broadcast update to others (maybe use rooms or throttle if needed)
            socket.broadcast.emit('playerUpdated', players[socket.id]);
        }
    });

    socket.on('eatFood', (foodId) => {
        const index = foods.findIndex(f => f.id === foodId);
        if (index !== -1) {
            const food = foods[index];
            foods.splice(index, 1);
            
            // New food
            const newFood = spawnFood();
            foods.push(newFood);

            io.emit('foodEaten', { foodId, newFood });
        }
    });

    socket.on('disconnect', () => {
        console.log(`Player disconnected: ${socket.id}`);
        delete players[socket.id];
        io.emit('playerLeft', socket.id);
    });

    socket.on('die', () => {
        if (players[socket.id]) {
            console.log(`Player died: ${socket.id}`);
            delete players[socket.id];
            io.emit('playerLeft', socket.id);
        }
    });
});

server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
