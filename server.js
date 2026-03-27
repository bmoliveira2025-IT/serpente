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
const NUM_BOTS = 30; // Mais bots para preencher o mundo sincronizado
const CENTER = WORLD_SIZE / 2;

const botNames = [
    'SlitherMaster', 'Viper', 'NeonSnake', 'CobraQueen', 'Toxic', 'Ghost',
    'Shadow', 'Flash', 'Apex', 'Titan', 'Zilla', 'Mamba', 'Racer', 'Venom',
    'Striker', 'Reaper', 'Cyber', 'Oceanic', 'Glitch', 'Zenith', 'Nebula'
];

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

const bots = [];

function createBot() {
    const angle = Math.random() * Math.PI * 2;
    const r = Math.random() * (CENTER - 1000);
    const x = CENTER + Math.cos(angle) * r;
    const y = CENTER + Math.sin(angle) * r;
    
    return {
        id: 'bot-' + Math.random().toString(36).substr(2, 9),
        name: botNames[Math.floor(Math.random() * botNames.length)],
        x: x,
        y: y,
        angle: Math.random() * Math.PI * 2,
        targetAngle: Math.random() * Math.PI * 2,
        score: Math.floor(Math.random() * 500) + 100,
        length: 26,
        radius: 20,
        history: [],
        skinIndex: Math.floor(Math.random() * 10), // Limitado a 10 skins (0-9)
        isBoosting: false,
        aiTimer: 0,
        speed: 3.0
    };
}

for (let i = 0; i < NUM_BOTS; i++) {
    bots.push(createBot());
}

// Initial food
for (let i = 0; i < TOTAL_FOOD; i++) {
    foods.push(spawnFood());
}

// Bot & World Update Loop (~25Hz)
setInterval(() => {
    bots.forEach(bot => {
        // Simple AI: Wander
        if (--bot.aiTimer <= 0) {
            bot.targetAngle = (Math.random() - 0.5) * 2 * Math.PI;
            bot.aiTimer = 40 + Math.random() * 60;
        }

        // Smooth angle
        let diff = bot.targetAngle - bot.angle;
        while (diff < -Math.PI) diff += Math.PI * 2;
        while (diff > Math.PI) diff -= Math.PI * 2;
        bot.angle += diff * 0.1;

        // Move
        bot.x += Math.cos(bot.angle) * bot.speed;
        bot.y += Math.sin(bot.angle) * bot.speed;

        // Boundary check
        if (Math.hypot(bot.x - CENTER, bot.y - CENTER) > CENTER - 200) {
            bot.targetAngle = Math.atan2(CENTER - bot.y, CENTER - bot.x);
        }

        // Food Collection (Simple)
        for (let i = 0; i < foods.length; i += 20) {
            const f = foods[i];
            const d = Math.hypot(bot.x - f.x, bot.y - f.y);
            if (d < bot.radius + f.radius) {
                foods.splice(i, 1);
                foods.push(spawnFood());
                bot.length += 0.5;
                bot.score += 10;
                io.emit('foodEaten', { foodId: f.id, newFood: foods[foods.length - 1] });
                break;
            }
        }
        
        // Update history (very simplified for server)
        bot.history.unshift({ x: bot.x, y: bot.y });
        bot.history.length = Math.min(bot.history.length, 150);
    });

    // Broadcast bots regularly
    io.emit('botsUpdated', bots.map(b => ({
        id: b.id, name: b.name, x: b.x, y: b.y, angle: b.angle, 
        score: b.score, length: b.length, radius: b.radius,
        skinIndex: b.skinIndex, history: b.history.slice(0, 50)
    })));
}, 40);

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
            bots: bots.map(b => ({
                id: b.id, name: b.name, x: b.x, y: b.y, angle: b.angle, 
                score: b.score, length: b.length, radius: b.radius,
                skinIndex: b.skinIndex, history: b.history.slice(0, 50)
            })),
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
