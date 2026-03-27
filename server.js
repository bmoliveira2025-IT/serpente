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

function createBot() {
    const angle = Math.random() * Math.PI * 2;
    const r = Math.random() * (CENTER - 1000);
    const x = CENTER + Math.cos(angle) * r;
    const y = CENTER + Math.sin(angle) * r;
    const initialLen = GAME_CONFIG.SNAKE_INITIAL_LENGTH + Math.floor(Math.random() * 20);
    
    const bot = {
        id: 'bot-' + Math.random().toString(36).substr(2, 9),
        name: botNames[Math.floor(Math.random() * botNames.length)],
        x: x,
        y: y,
        angle: Math.random() * Math.PI * 2,
        targetAngle: Math.random() * Math.PI * 2,
        score: Math.floor(Math.random() * 500) + 100,
        length: initialLen,
        radius: 20,
        history: [],
        skinIndex: Math.floor(Math.random() * 10), // Limitado a 10 skins (0-9)
        isBoosting: false,
        aiTimer: 0,
        speed: 7.2 // Sincronizado com os 3.0 (60fps) do jogador real: 3 * (60/25) = 7.2
    };

    // Pre-fill history to avoid empty segments
    for (let i = 0; i < 200; i++) {
        bot.history.push({ x: bot.x, y: bot.y });
    }
    return bot;
}

for (let i = 0; i < GAME_CONFIG.NUM_BOTS; i++) {
    bots.push(createBot());
}

// Initial food
for (let i = 0; i < GAME_CONFIG.TOTAL_FOOD; i++) {
    foods.push(spawnFood());
}

function checkCollision(head, target) {
    if (!target.history || target.history.length < 2) return false;
    
    // Ponto de colisão um pouco mais à frente (60%) para garantir detecção veloz
    const tipX = head.x + Math.cos(head.angle) * (head.radius * 0.6);
    const tipY = head.y + Math.sin(head.angle) * (head.radius * 0.6);
    
    // Como agora os históricos são esparsos (5-7px entre pontos),
    // checar todos os pontos do array é eficiente e seguro.
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

    // Apenas a quantidade COMIDA QUE ELA COMEU (Crescimento)
    const eatenCount = Math.max(0, Math.floor((snake.length - GAME_CONFIG.SNAKE_INITIAL_LENGTH) / GAME_CONFIG.GROWTH_PER_FOOD));
    if (eatenCount <= 0) return;

    // Distribuir eatenCount ao longo do corpo
    const availableHistory = Math.min(snake.history.length, Math.floor(snake.length * 5));
    const step = Math.max(1, Math.floor(availableHistory / eatenCount));
    
    const newFoods = [];
    for (let i = 0; i < availableHistory && newFoods.length < eatenCount; i += step) {
        const pos = snake.history[i];
        if (pos) {
            const f = {
                id: Math.random().toString(36).substr(2, 9),
                x: pos.x, y: pos.y,
                radius: 3, 
                color: ['#ff0055', '#00ffaa', '#00ddff', '#ffdd00', '#ff6600', '#aa00ff', '#e0e0ff', '#ff00aa'][Math.floor(Math.random() * 8)],
                phase: Math.random() * Math.PI * 2,
                floatOffset: 0,
                isDeathFood: true
            };
            foods.push(f);
            newFoods.push(f);
        }
    }
    if (newFoods.length > 0) {
        io.emit('deathResidue', newFoods);
    }
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
                const newlySpawned = spawnFood();
                foods.push(newlySpawned);
                bot.length += GAME_CONFIG.GROWTH_PER_FOOD;
                bot.score += GAME_CONFIG.SCORE_PER_FOOD;
                
                // Atualizar raio dinamicamente com a mesma fórmula do cliente
                bot.radius = Math.min(
                    GAME_CONFIG.SNAKE_MAX_RADIUS, 
                    GAME_CONFIG.SNAKE_INITIAL_RADIUS + (bot.length - GAME_CONFIG.SNAKE_INITIAL_LENGTH) * GAME_CONFIG.WIDTH_GROWTH_FACTOR
                );

                io.emit('foodEaten', { foodId: f.id, newFood: newlySpawned });
                break;
            }
        }
        
        // Update history (very simplified for server)
        bot.history.unshift({ x: bot.x, y: bot.y });
        bot.history.length = Math.min(bot.history.length, 500); // 500 pontos para cobras longas

        // --- BOT COLLISION ---
        let died = false;
        // Check boundary
        if (Math.hypot(bot.x - CENTER, bot.y - CENTER) > CENTER - 20) {
            died = true;
        }
        // Check bots
        if (!died) {
            for (let other of bots) {
                if (other.id === bot.id) continue;
                if (checkCollision(bot, other)) { died = true; break; }
            }
        }
        // Check players
        if (!died) {
            for (let id in players) {
                if (checkCollision(bot, players[id])) { died = true; break; }
            }
        }

        if (died) {
            dropDeathFood(bot);
            // Respawn bot in a new place
            const fresh = createBot();
            Object.assign(bot, fresh);
        }
    });

    // Broadcast bots regularly
    io.emit('botsUpdated', bots.map(b => ({
        id: b.id, name: b.name, x: b.x, y: b.y, angle: b.angle, 
        score: b.score, length: b.length, radius: b.radius,
        skinIndex: b.skinIndex, history: b.history.slice(0, 200) // Mais histórico para precisão de colisão
    })));
}, 1000 / GAME_CONFIG.SERVER_TICK_RATE);

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
            x: GAME_CONFIG.WORLD_SIZE / 2,
            y: GAME_CONFIG.WORLD_SIZE / 2,
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
            config: GAME_CONFIG
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
        if (players[socket.id]) {
            dropDeathFood(players[socket.id]);
            delete players[socket.id];
        }
        io.emit('playerLeft', socket.id);
    });

    socket.on('die', () => {
        if (players[socket.id]) {
            console.log(`Player died: ${socket.id}`);
            dropDeathFood(players[socket.id]);
            delete players[socket.id];
            io.emit('playerLeft', socket.id);
        }
    });
});

server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
