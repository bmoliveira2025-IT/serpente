const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

const PORT = process.env.PORT || 3000;

// Configurações do Jogo
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
    SERVER_TICK_RATE: 25, // 40ms interval
    GRID_SIZE: 400 // Tamanho de cada célula para o sistema de colisão otimizado
};

const CENTER = GAME_CONFIG.WORLD_SIZE / 2;

// Estado do Jogo
const players = {};
let bots = [];
const foods = [];
let spatialGrid = {}; // Sistema de busca por proximidade

const botNames = ['SlitherMaster', 'Viper', 'NeonSnake', 'CobraQueen', 'Toxic', 'Ghost', 'Shadow', 'Flash', 'Apex', 'Titan', 'Zilla', 'Mamba', 'Racer', 'Venom'];

// --- FUNÇÕES UTILITÁRIAS ---

function spawnFood() {
    const angle = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * (GAME_CONFIG.WORLD_SIZE / 2 - 50);
    return {
        id: Math.random().toString(36).substr(2, 9),
        x: CENTER + Math.cos(angle) * r,
        y: CENTER + Math.sin(angle) * r,
        radius: 3,
        color: ['#ff0055', '#00ffaa', '#00ddff', '#ffdd00', '#ff6600', '#aa00ff'][Math.floor(Math.random() * 6)],
        isDeathFood: false
    };
}

function updateSpatialGrid() {
    spatialGrid = {};
    // Adicionar jogadores e bots ao grid para detecção rápida
    const entities = [...Object.values(players), ...bots];
    entities.forEach(ent => {
        const gx = Math.floor(ent.x / GAME_CONFIG.GRID_SIZE);
        const gy = Math.floor(ent.y / GAME_CONFIG.GRID_SIZE);
        const key = `${gx},${gy}`;
        if (!spatialGrid[key]) spatialGrid[key] = [];
        spatialGrid[key].push(ent);
    });
}

function getSafePosition() {
    // Tenta posições aleatórias evitando o centro populado
    return {
        x: 500 + Math.random() * (GAME_CONFIG.WORLD_SIZE - 1000),
        y: 500 + Math.random() * (GAME_CONFIG.WORLD_SIZE - 1000)
    };
}

function createBot() {
    const pos = getSafePosition();
    return {
        id: 'bot-' + Math.random().toString(36).substr(2, 9),
        name: botNames[Math.floor(Math.random() * botNames.length)],
        x: pos.x, y: pos.y,
        angle: Math.random() * Math.PI * 2,
        targetAngle: Math.random() * Math.PI * 2,
        score: 100,
        length: GAME_CONFIG.SNAKE_INITIAL_LENGTH,
        radius: GAME_CONFIG.SNAKE_INITIAL_RADIUS,
        history: Array(50).fill({ x: pos.x, y: pos.y }), // Histórico inicial reduzido
        skinIndex: Math.floor(Math.random() * 10),
        aiTimer: 0,
        speed: 7.2
    };
}

// Inicialização
for (let i = 0; i < GAME_CONFIG.NUM_BOTS; i++) bots.push(createBot());
for (let i = 0; i < GAME_CONFIG.TOTAL_FOOD; i++) foods.push(spawnFood());

// --- LÓGICA DE COLISÃO ---

function checkCollision(head, target) {
    if (!target.history || target.history.length < 5) return false;

    const tipX = head.x + Math.cos(head.angle) * (head.radius * 0.6);
    const tipY = head.y + Math.sin(head.angle) * (head.radius * 0.6);

    // Checar apenas os pontos necessários do histórico
    for (let i = 2; i < target.history.length; i += 2) {
        const seg = target.history[i];
        const d2 = (tipX - seg.x) ** 2 + (tipY - seg.y) ** 2;
        const threshold = (target.radius || 20) * 0.9;
        if (d2 < threshold ** 2) return true;
    }
    return false;
}

function dropDeathFood(snake) {
    if (!snake || !snake.history || snake.history.length === 0) return;

    // A cobra deixa 50% do que "cresceu" além do tamanho inicial
    const eatenCount = Math.max(1, Math.floor((snake.length - GAME_CONFIG.SNAKE_INITIAL_LENGTH) / 1.5));
    if (eatenCount <= 0) return;

    const step = Math.max(1, Math.floor(snake.history.length / eatenCount));
    const newFoods = [];

    for (let i = 0; i < snake.history.length && newFoods.length < eatenCount; i += step) {
        const pos = snake.history[i];
        if (!pos) continue;
        const f = { ...spawnFood(true, pos.x, pos.y), id: `df_${Date.now()}_${Math.random()}` };
        foods.push(f);
        newFoods.push(f);
    }
    
    if (newFoods.length > 0) {
        io.emit('deathResidue', newFoods);
    }
}

// --- LOOP PRINCIPAL (TICK) ---

setInterval(() => {
    updateSpatialGrid();

    bots.forEach(bot => {
        // AI Simples e suave
        const distToCenter = Math.hypot(bot.x - CENTER, bot.y - CENTER);
        if (distToCenter > CENTER - 400) {
            bot.targetAngle = Math.atan2(CENTER - bot.y, CENTER - bot.x);
        } else if (--bot.aiTimer <= 0) {
            bot.targetAngle += (Math.random() - 0.5) * 2;
            bot.aiTimer = 40 + Math.random() * 60;
        }

        let diff = bot.targetAngle - bot.angle;
        while (diff < -Math.PI) diff += Math.PI * 2;
        while (diff > Math.PI) diff -= Math.PI * 2;
        bot.angle += diff * 0.1;

        bot.x += Math.cos(bot.angle) * bot.speed;
        bot.y += Math.sin(bot.angle) * bot.speed;

        // Histórico otimizado
        bot.history.unshift({ x: bot.x, y: bot.y });
        if (bot.history.length > 300) bot.history.pop();

        // Colisões (Bordas)
        if (distToCenter > CENTER - 20) {
            dropDeathFood(bot);
            Object.assign(bot, createBot());
        }

        // Colisões (Outras Cobras usando o Grid)
        const gx = Math.floor(bot.x / GAME_CONFIG.GRID_SIZE);
        const gy = Math.floor(bot.y / GAME_CONFIG.GRID_SIZE);

        for (let x = -1; x <= 1; x++) {
            for (let y = -1; y <= 1; y++) {
                const neighbors = spatialGrid[`${gx + x},${gy + y}`];
                if (neighbors) {
                    neighbors.forEach(other => {
                        if (other.id !== bot.id && checkCollision(bot, other)) {
                            dropDeathFood(bot);
                            Object.assign(bot, createBot());
                        }
                    });
                }
            }
        }

        // --- BOTS COMENTO COMIDA ---
        for (let i = foods.length - 1; i >= 0; i--) {
            const f = foods[i];
            const distSq = (bot.x - f.x) ** 2 + (bot.y - f.y) ** 2;
            const eatThreshold = bot.radius + (f.radius || 2);
            
            if (distSq < eatThreshold ** 2) {
                const foodId = f.id;
                foods.splice(i, 1);
                
                const growth = f.isDeathFood ? 0.35 : 0.15;
                bot.score += f.isDeathFood ? 5 : 1;
                bot.length += growth;
                bot.radius = Math.min(GAME_CONFIG.SNAKE_MAX_RADIUS, GAME_CONFIG.SNAKE_INITIAL_RADIUS + (bot.length - GAME_CONFIG.SNAKE_INITIAL_LENGTH) * GAME_CONFIG.WIDTH_GROWTH_FACTOR);
                
                const newFood = spawnFood();
                foods.push(newFood);
                io.emit('foodEaten', { foodId, newFood });
            }
        }
    });

    // Enviar dados compactados para os clientes (AGORA COM O LENGTH)
    io.emit('botsUpdated', bots.map(b => ({
        id: b.id,
        name: b.name,
        x: Math.round(b.x),
        y: Math.round(b.y),
        angle: b.angle,
        score: b.score,
        radius: Math.round(b.radius),
        skinIndex: b.skinIndex,
        length: b.length,          // <-- A CORREÇÃO ESTÁ AQUI
        isBoosting: b.isBoosting || false
    })));
}, 1000 / GAME_CONFIG.SERVER_TICK_RATE);

// --- ROTAS E SOCKETS ---

app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'cobra.html')));

io.on('connection', (socket) => {
    socket.on('join', (data) => {
        const pos = getSafePosition();
        players[socket.id] = {
            id: socket.id, name: data.name || 'Convidado',
            x: pos.x, y: pos.y, angle: 0, score: 0,
            length: 23, radius: 20, history: [],
            skinIndex: data.skinIndex || 0
        };
        socket.emit('init', { id: socket.id, players, foods, config: GAME_CONFIG });
    });

    socket.on('update', (data) => {
        const p = players[socket.id];
        if (p) {
            // Atualizar posição básica
            p.x = data.x;
            p.y = data.y;
            p.angle = data.angle;
            p.score = data.score;
            p.length = data.length;
            p.radius = data.radius;
            p.isBoosting = data.isBoosting;

            // MANTER HISTÓRICO NO SERVIDOR (Necessário para os bots colidirem com você!)
            if (!p.history) p.history = [];
            
            // Só adiciona ao histórico se moveu uma distância mínima (5 pixels) para evitar "pilhas" de pontos
            if (!p.lastHistoryX) { p.lastHistoryX = p.x; p.lastHistoryY = p.y; }
            const distSinceLast = Math.hypot(p.x - p.lastHistoryX, p.y - p.lastHistoryY);
            
            if (distSinceLast >= 5) {
                p.history.unshift({ x: p.x, y: p.y });
                p.lastHistoryX = p.x;
                p.lastHistoryY = p.y;
                
                // Limitar tamanho do histórico para otimizar performance
                if (p.history.length > 300) p.history.pop();
            }

            socket.broadcast.emit('playerUpdated', p);
        }
    });

    socket.on('eatFood', (foodId) => {
        const p = players[socket.id];
        if (!p) return;
        const idx = foods.findIndex(f => f.id === foodId);
        if (idx !== -1) {
            // Anti-cheat: Verifica distância básica antes de aceitar
            const dist = Math.hypot(p.x - foods[idx].x, p.y - foods[idx].y);
            if (dist < p.radius + 100) {
                foods.splice(idx, 1);
                const newFood = spawnFood();
                foods.push(newFood);
                io.emit('foodEaten', { foodId, newFood });
            }
        }
    });

    socket.on('playerDied', () => {
        const p = players[socket.id];
        if (p) {
            console.log(`Jogador ${p.name} morreu. Gerando resíduo.`);
            dropDeathFood(p);
            delete players[socket.id];
            io.emit('playerLeft', socket.id);
        }
    });

    socket.on('disconnect', () => {
        if (players[socket.id]) {
            dropDeathFood(players[socket.id]);
            delete players[socket.id];
        }
        io.emit('playerLeft', socket.id);
    });
});

server.listen(PORT, () => console.log(`Rodando em http://localhost:${PORT}`));