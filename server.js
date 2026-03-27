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
const GAME_CONFIG = {
    WORLD_SIZE: 8000,
    TOTAL_FOOD: 1500,
    NUM_BOTS: 30,
    SNAKE_BASE_SPEED: 3.0,
    GROWTH_PER_FOOD: 0.5,
    SCORE_PER_FOOD: 10,
    SNAKE_INITIAL_LENGTH: 26,
    SNAKE_INITIAL_RADIUS: 20,
    SNAKE_MAX_RADIUS: 36,
    WIDTH_GROWTH_FACTOR: 0.05,
    SERVER_TICK_RATE: 25 // 40ms interval
};

const CENTER = GAME_CONFIG.WORLD_SIZE / 2;

const botNames = [
    'SlitherMaster', 'Viper', 'NeonSnake', 'CobraQueen', 'Toxic', 'Ghost',
    'Shadow', 'Flash', 'Apex', 'Titan', 'Zilla', 'Mamba', 'Racer', 'Venom',
    'Striker', 'Reaper', 'Cyber', 'Oceanic', 'Glitch', 'Zenith', 'Nebula'
];

function spawnFood() {
    const angle = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * (GAME_CONFIG.WORLD_SIZE / 2 - 20);
    return {
        id: Math.random().toString(36).substr(2, 9),
        x: GAME_CONFIG.WORLD_SIZE / 2 + Math.cos(angle) * r,
        y: GAME_CONFIG.WORLD_SIZE / 2 + Math.sin(angle) * r,
        radius: Math.random() * 1 + 2,
        color: ['#ff0055', '#00ffaa', '#00ddff', '#ffdd00', '#ff6600', '#aa00ff', '#e0e0ff', '#ff00aa'][Math.floor(Math.random() * 8)],
        phase: Math.random() * Math.PI * 2,
        floatOffset: Math.random() * Math.PI * 2,
        isDeathFood: false
    };
}

const bots = [];

function getSafePosition() {
    let attempts = 0;
    const safeRadius = 1500;
    while (attempts < 50) {
        const x = 500 + Math.random() * (GAME_CONFIG.WORLD_SIZE - 1000);
        const y = 500 + Math.random() * (GAME_CONFIG.WORLD_SIZE - 1000);
        
        let isSafe = true;
        for (let b of bots) {
            if (Math.hypot(x - b.x, y - b.y) < safeRadius) { isSafe = false; break; }
        }
        if (isSafe) {
            for (let id in players) {
                if (Math.hypot(x - players[id].x, y - players[id].y) < safeRadius) { isSafe = false; break; }
            }
        }
        if (isSafe) return { x, y };
        attempts++;
    }
    return { x: Math.random() * 2000, y: Math.random() * 2000 };
}

function createBot() {
    const pos = getSafePosition();
    const initialLen = GAME_CONFIG.SNAKE_INITIAL_LENGTH + Math.floor(Math.random() * 20);
    const bot = {
        id: 'bot-' + Math.random().toString(36).substr(2, 9),
        name: botNames[Math.floor(Math.random() * botNames.length)],
        x: pos.x, y: pos.y,
        angle: Math.random() * Math.PI * 2,
        targetAngle: Math.random() * Math.PI * 2,
        score: Math.floor(Math.random() * 500) + 100,
        length: initialLen,
        radius: 20,
        history: [],
        skinIndex: Math.floor(Math.random() * 10),
        isBoosting: false,
        aiTimer: 0,
        speed: 7.2 // 3.0 * (60/25)
    };
    for (let i = 0; i < 200; i++) bot.history.push({ x: bot.x, y: bot.y });
    return bot;
}

for (let i = 0; i < GAME_CONFIG.NUM_BOTS; i++) bots.push(createBot());
for (let i = 0; i < GAME_CONFIG.TOTAL_FOOD; i++) foods.push(spawnFood());

function checkCollision(head, target) {
    if (!target.history || target.history.length < 2) return false;
    const tipX = head.x + Math.cos(head.angle) * (head.radius * 0.6);
    const tipY = head.y + Math.sin(head.angle) * (head.radius * 0.6);
    const maxIdx = Math.min(target.history.length, 500); 
    for (let i = 1; i < maxIdx; i++) {
        const seg = target.history[i];
        if (!seg) break;
        const d2 = (tipX - seg.x)**2 + (tipY - seg.y)**2;
        const threshold = (target.radius || 20) * 0.85; 
        if (d2 < threshold**2) return true;
    }
    return false;
}

function dropDeathFood(snake) {
    if (!snake.history || snake.history.length < 2) return;
    const eatenCount = Math.max(0, Math.floor((snake.length - GAME_CONFIG.SNAKE_INITIAL_LENGTH) / GAME_CONFIG.GROWTH_PER_FOOD));
    if (eatenCount <= 0) return;
    const availableHistory = Math.min(snake.history.length, Math.floor(snake.length * 5));
    const step = Math.max(1, Math.floor(availableHistory / eatenCount));
    const newFoods = [];
    for (let i = 0; i < availableHistory && newFoods.length < eatenCount; i += step) {
        const pos = snake.history[i];
        if (pos) {
            const f = {
                id: Math.random().toString(36).substr(2, 9),
                x: pos.x, y: pos.y, radius: 3, 
                color: ['#ff0055', '#00ffaa', '#00ddff', '#ffdd00', '#ff6600', '#aa00ff', '#e0e0ff', '#ff00aa'][Math.floor(Math.random() * 8)],
                phase: Math.random() * Math.PI * 2, floatOffset: 0, isDeathFood: true
            };
            foods.push(f);
            newFoods.push(f);
        }
    }
    if (newFoods.length > 0) io.emit('deathResidue', newFoods);
}

// --- Grid & AI Optimization ---
const GRID_SIZE = 400;
let spatialGrid = {};

function updateGrid(entity) {
    const gx = Math.floor(entity.x / GRID_SIZE);
    const gy = Math.floor(entity.y / GRID_SIZE);
    const key = `${gx},${gy}`;
    if (!spatialGrid[key]) spatialGrid[key] = [];
    spatialGrid[key].push(entity);
}

function updateBotAI(bot) {
    const distToCenter = Math.hypot(bot.x - CENTER, bot.y - CENTER);
    if (distToCenter > CENTER - 500) {
        bot.targetAngle = Math.atan2(CENTER - bot.y, CENTER - bot.x);
    } else if (--bot.aiTimer <= 0) {
        bot.targetAngle += (Math.random() - 0.5) * 1.5;
        bot.aiTimer = 30 + Math.random() * 50;
    }
    let diff = bot.targetAngle - bot.angle;
    while (diff < -Math.PI) diff += Math.PI * 2;
    while (diff > Math.PI) diff -= Math.PI * 2;
    bot.angle += diff * 0.15;
}

setInterval(() => {
    spatialGrid = {};
    for (let id in players) updateGrid(players[id]);
    bots.forEach(bot => {
        updateBotAI(bot);
        bot.x += Math.cos(bot.angle) * bot.speed;
        bot.y += Math.sin(bot.angle) * bot.speed;
        for (let i = 0; i < foods.length; i += 20) {
            const f = foods[i];
            const d = Math.hypot(bot.x - f.x, bot.y - f.y);
            if (d < bot.radius + f.radius) {
                foods.splice(i, 1);
                const newlySpawned = spawnFood();
                foods.push(newlySpawned);
                bot.length += GAME_CONFIG.GROWTH_PER_FOOD;
                bot.score += GAME_CONFIG.SCORE_PER_FOOD;
                bot.radius = Math.min(GAME_CONFIG.SNAKE_MAX_RADIUS, GAME_CONFIG.SNAKE_INITIAL_RADIUS + (bot.length - GAME_CONFIG.SNAKE_INITIAL_LENGTH) * GAME_CONFIG.WIDTH_GROWTH_FACTOR);
                io.emit('foodEaten', { foodId: f.id, newFood: newlySpawned });
                break;
            }
        }
        bot.history.unshift({ x: bot.x, y: bot.y });
        bot.history.length = Math.min(bot.history.length, 500);
        let died = false;
        if (Math.hypot(bot.x - CENTER, bot.y - CENTER) > CENTER - 20) died = true;
        if (!died) {
            const gx = Math.floor(bot.x / GRID_SIZE);
            const gy = Math.floor(bot.y / GRID_SIZE);
            for (let ox = -1; ox <= 1; ox++) {
                for (let oy = -1; oy <= 1; oy++) {
                    const key = `${gx + ox},${gy + oy}`;
                    const neighbors = spatialGrid[key] || [];
                    for (let other of neighbors) {
                        if (other.id === bot.id) continue;
                        if (checkCollision(bot, other)) { died = true; break; }
                    }
                    if (died) break;
                }
                if (died) break;
            }
        }
        if (died) {
            dropDeathFood(bot);
            const fresh = createBot();
            Object.assign(bot, fresh);
        }
        updateGrid(bot);
    });
    io.emit('botsUpdated', bots.map(b => ({
        id: b.id, name: b.name, x: b.x, y: b.y, angle: b.angle, 
        score: b.score, length: b.length, radius: b.radius,
        skinIndex: b.skinIndex, history: b.history.slice(0, 200)
    })));
}, 1000 / GAME_CONFIG.SERVER_TICK_RATE);

app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'cobra.html')));

io.on('connection', (socket) => {
    socket.on('join', (data) => {
        const pos = getSafePosition();
        players[socket.id] = {
            id: socket.id, name: data.name || 'Convidado',
            x: pos.x, y: pos.y, angle: 0, score: 0, length: 23, radius: 20,
            history: [], skinIndex: data.skinIndex || 0, isBoosting: false
        };
        socket.emit('init', {
            id: socket.id, players,
            bots: bots.map(b => ({
                id: b.id, name: b.name, x: b.x, y: b.y, angle: b.angle, 
                score: b.score, length: b.length, radius: b.radius,
                skinIndex: b.skinIndex, history: b.history.slice(0, 50)
            })),
            foods, config: GAME_CONFIG
        });
        socket.broadcast.emit('playerJoined', players[socket.id]);
    });

    socket.on('update', (data) => {
        if (players[socket.id]) {
            Object.assign(players[socket.id], data);
            socket.broadcast.emit('playerUpdated', players[socket.id]);
        }
    });

    socket.on('eatFood', (foodId) => {
        const p = players[socket.id];
        if (!p) return;
        const index = foods.findIndex(f => f.id === foodId);
        if (index !== -1) {
            const food = foods[index];
            if (Math.hypot(p.x - food.x, p.y - food.y) < p.radius + 100) { 
                foods.splice(index, 1);
                const newFood = spawnFood();
                foods.push(newFood);
                io.emit('foodEaten', { foodId, newFood });
            }
        }
    });

    socket.on('disconnect', () => {
        if (players[socket.id]) {
            dropDeathFood(players[socket.id]);
            delete players[socket.id];
        }
        io.emit('playerLeft', socket.id);
    });

    socket.on('die', () => {
        if (players[socket.id]) {
            dropDeathFood(players[socket.id]);
            delete players[socket.id];
            io.emit('playerLeft', socket.id);
        }
    });
});

server.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));