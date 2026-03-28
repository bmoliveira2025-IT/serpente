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

// =================================================================
// --- CONFIGURAÇÕES DO JOGO (100% Sincronizadas com o Front-end) ---
// =================================================================
const GAME_CONFIG = {
    WORLD_SIZE: 9000,                 
    TOTAL_FOOD: 1500,                 

    SNAKE_INITIAL_LENGTH: 30,         

    // Espessura inicial separada por plataforma:
    SNAKE_INITIAL_RADIUS_MOBILE: 12,
    SNAKE_INITIAL_RADIUS_TABLET: 15,
    SNAKE_INITIAL_RADIUS_PC: 18,

    // O servidor usa o rádio de PC como padrão para os Bots:
    get SNAKE_INITIAL_RADIUS() { return this.SNAKE_INITIAL_RADIUS_PC; },

    SNAKE_MAX_RADIUS: 38,             
    SNAKE_HISTORY_STEP: 1,
    SNAKE_HISTORY_SPACING: 5,
    SNAKE_BASE_SPEED: 4.0,

    SNAKE_HITBOX_SIZE: 0.90,          // Aumentado para cobrir a linha visual exterior desenhada no canvas
    SNAKE_TURN_SPEED: 0.035,
    SNAKE_TURN_SPEED_BOOST: 0.015,

    // --- PROPORÇÃO MATEMÁTICA ABSOLUTA (1.0 de Crescimento = 8.0 de Score) ---
    GROWTH_PER_FOOD: 3.0,             
    SCORE_PER_FOOD: 8,               
    DEATH_GROWTH: 11.25,              // Proporcional para não quebrar rácio: (30 / 8) * 3.0
    DEATH_SCORE: 30,                  
    
    WIDTH_GROWTH_FACTOR: 0.18,        // Curva de crescimento lenta (pára de crescer na largura aos 50k pontos)
    MAX_HISTORY_LENGTH: 50000,        // Permite que a cobra cresça quase infinitamente em comprimento

    // Sincronização do Boost para evitar o ecrã divergir da pontuação
    BOOST_SPEED_MULT: 2.0,            
    BOOST_SCORE_LOSS: 2,              
    BOOST_LENGTH_LOSS: 0.75,          // (2 / 8) * 3.0
    BOOST_MIN_LENGTH: 40,             

    MAGNET_STRENGTH: 0.3,
    MAGNET_RADIUS_MULT: 3.0,

    NUM_BOTS: 30,
    SPAWN_SAFE_RADIUS: 2500,
    BOT_VISION_RADIUS: 1500,

    SERVER_TICK_RATE: 25,
    GRID_SIZE: 450
};

const CENTER = GAME_CONFIG.WORLD_SIZE / 2;
const SERVER_DT = 60 / GAME_CONFIG.SERVER_TICK_RATE;

const players = {};
let bots = [];
const foods = [];
let spatialGrid = {};

const botNames = ['SlitherMaster', 'Viper', 'NeonSnake', 'CobraQueen', 'Toxic', 'Ghost', 'Shadow', 'Flash', 'Apex', 'Titan', 'Zilla', 'Mamba', 'Racer', 'Venom'];

// --- FUNÇÕES UTILITÁRIAS ---

function calculateLengthFromScore(score) {
    return GAME_CONFIG.SNAKE_INITIAL_LENGTH + (score * (GAME_CONFIG.GROWTH_PER_FOOD / GAME_CONFIG.SCORE_PER_FOOD));
}

function getEntityRadius(length) {
    const lenDiff = Math.max(0, length - GAME_CONFIG.SNAKE_INITIAL_LENGTH);
    return Math.min(GAME_CONFIG.SNAKE_MAX_RADIUS, GAME_CONFIG.SNAKE_INITIAL_RADIUS + Math.sqrt(lenDiff) * GAME_CONFIG.WIDTH_GROWTH_FACTOR);
}

function spawnFood() {
    const angle = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * (GAME_CONFIG.WORLD_SIZE / 2 - 50);
    return {
        id: Math.random().toString(36).substr(2, 9),
        x: CENTER + Math.cos(angle) * r, y: CENTER + Math.sin(angle) * r,
        radius: 3, color: ['#ff0055', '#00ffaa', '#00ddff', '#ffdd00', '#ff6600', '#aa00ff'][Math.floor(Math.random() * 6)],
        isDeathFood: false
    };
}

function updateSpatialGrid() {
    spatialGrid = {};
    const entities = [...Object.values(players), ...bots];
    entities.forEach(ent => {
        if (ent.isDead) return;
        const gx = Math.floor(ent.x / GAME_CONFIG.GRID_SIZE), gy = Math.floor(ent.y / GAME_CONFIG.GRID_SIZE);
        const headKey = `${gx},${gy}`;
        if (!spatialGrid[headKey]) spatialGrid[headKey] = [];
        spatialGrid[headKey].push(ent);

        if (ent.history) {
            const addedKeys = new Set([headKey]);
            for (let i = 0; i < ent.history.length; i += 15) {
                const seg = ent.history[i];
                if (!seg) continue;
                const sgx = Math.floor(seg.x / GAME_CONFIG.GRID_SIZE), sgy = Math.floor(seg.y / GAME_CONFIG.GRID_SIZE);
                const skey = `${sgx},${sgy}`;
                if (!addedKeys.has(skey)) {
                    if (!spatialGrid[skey]) spatialGrid[skey] = [];
                    spatialGrid[skey].push(ent);
                    addedKeys.add(skey);
                }
            }
        }
    });
}

function getSafePosition() {
    let attempts = 0;
    const safeDistance = GAME_CONFIG.SPAWN_SAFE_RADIUS;
    while (attempts < 100) {
        const angle = Math.random() * Math.PI * 2, r = Math.random() * (CENTER - 1000);
        const x = CENTER + Math.cos(angle) * r, y = CENTER + Math.sin(angle) * r;
        let isSafe = true;
        const entities = [...Object.values(players), ...bots];

        for (let ent of entities) {
            if (Math.hypot(x - ent.x, y - ent.y) < safeDistance) { isSafe = false; break; }
            if (ent.history) {
                for (let i = 0; i < ent.history.length; i += 10) {
                    if (Math.hypot(x - ent.history[i].x, y - ent.history[i].y) < safeDistance / 2) { isSafe = false; break; }
                }
            }
            if (!isSafe) break;
        }
        if (isSafe) return { x, y };
        attempts++;
    }
    const fallbackAngle = Math.random() * Math.PI * 2;
    return { x: CENTER + Math.cos(fallbackAngle) * (CENTER - 500), y: CENTER + Math.sin(fallbackAngle) * (CENTER - 500) };
}

function createBot() {
    const pos = getSafePosition();
    const isBoss = Math.random() < 0.25;

    const initialScore = isBoss ? 500 + Math.random() * 1500 : 50 + Math.random() * 100;
    const initialLength = calculateLengthFromScore(initialScore);
    const initialRadius = getEntityRadius(initialLength);

    return {
        id: 'bot-' + Math.random().toString(36).substr(2, 9),
        name: botNames[Math.floor(Math.random() * botNames.length)] + (isBoss ? ' [BOSS]' : ''),
        x: pos.x, y: pos.y, angle: Math.random() * Math.PI * 2, targetAngle: Math.random() * Math.PI * 2,
        score: initialScore, length: initialLength, radius: initialRadius,
        history: Array.from({ length: Math.min(GAME_CONFIG.MAX_HISTORY_LENGTH, Math.floor(initialLength * GAME_CONFIG.SNAKE_HISTORY_SPACING) + 10) }, () => ({ x: pos.x, y: pos.y })),
        skinIndex: Math.floor(Math.random() * 10), aiTimer: 0, speed: GAME_CONFIG.SNAKE_BASE_SPEED, isDead: false, distAccum: 0
    };
}

function killBot(bot) {
    if (!bot || bot.isDead) return;
    bot.isDead = true;
    dropDeathFood(bot);
    io.emit('botDied', { id: bot.id, x: bot.x, y: bot.y });
    const idx = bots.indexOf(bot);
    if (idx !== -1) bots.splice(idx, 1);
    setTimeout(() => { bots.push(createBot()); }, 500);
}

for (let i = 0; i < GAME_CONFIG.NUM_BOTS; i++) bots.push(createBot());
for (let i = 0; i < GAME_CONFIG.TOTAL_FOOD; i++) foods.push(spawnFood());

// --- LÓGICA DE COLISÃO (HITBOX AAA) ---
function checkCollision(head, target) {
    if (!target.history || target.history.length < 2) return false;

    const headRadius = head.radius || GAME_CONFIG.SNAKE_INITIAL_RADIUS;
    const targetRadius = target.radius || GAME_CONFIG.SNAKE_INITIAL_RADIUS;

    // Ponta do nariz empurrada para o limite exterior (0.8)
    const tipX = head.x + Math.cos(head.angle) * (headRadius * 0.8);
    const tipY = head.y + Math.sin(head.angle) * (headRadius * 0.8);

    // Hitbox rigorosa: Nariz contra raio visual efetivo do inimigo
    const thresholdSq = (headRadius * 0.2 + targetRadius * GAME_CONFIG.SNAKE_HITBOX_SIZE) ** 2;

    const spacing = GAME_CONFIG.SNAKE_HISTORY_SPACING;
    const maxIdx = Math.min(Math.floor((target.length || GAME_CONFIG.SNAKE_INITIAL_LENGTH) * spacing), target.history.length - 1, GAME_CONFIG.MAX_HISTORY_LENGTH - 1);

    for (let i = 0; i <= maxIdx; i += spacing) {
        const seg = target.history[i];
        if (!seg || isNaN(seg.x) || isNaN(seg.y)) continue;
        const dSq = (tipX - seg.x) ** 2 + (tipY - seg.y) ** 2;
        if (dSq < thresholdSq) return true;
    }
    return false;
}

function dropDeathFood(snake) {
    if (!snake || !snake.history || snake.history.length === 0) return;
    const newFoods = [];
    const spacing = GAME_CONFIG.SNAKE_HISTORY_SPACING;
    const segments = Math.min(Math.floor(snake.length), Math.floor(snake.history.length / spacing));

    for (let i = 0; i < segments; i++) {
        const pos = i === 0 ? { x: snake.x, y: snake.y } : snake.history[i * spacing];
        if (!pos) continue;

        const f1 = { id: `df_${Date.now()}_${Math.random().toString(36).substr(2)}`, x: pos.x, y: pos.y, radius: GAME_CONFIG.DEATH_FOOD_RADIUS, color: ['#ff0055', '#00ffaa', '#00ddff', '#ffdd00', '#ff6600', '#aa00ff'][Math.floor(Math.random() * 6)], isDeathFood: true };
        const angle = Math.random() * Math.PI * 2, rOffset = Math.random() * (snake.radius * 0.6);
        const f2 = { id: `df_${Date.now()}_${Math.random().toString(36).substr(2)}`, x: pos.x + Math.cos(angle) * rOffset, y: pos.y + Math.sin(angle) * rOffset, radius: GAME_CONFIG.DEATH_FOOD_RADIUS, color: f1.color, isDeathFood: true };

        foods.push(f1, f2);
        newFoods.push(f1, f2);
    }

    if (newFoods.length > 0) io.emit('deathResidue', newFoods);
}

// --- LOOP PRINCIPAL (TICK) ---
setInterval(() => {
    updateSpatialGrid();

    bots.forEach(bot => {
        if (bot.isDead) return;
        const distToCenter = Math.hypot(bot.x - CENTER, bot.y - CENTER);
        let fleeAngle = null;

        if (distToCenter > CENTER - 350) {
            fleeAngle = Math.atan2(CENTER - bot.y, CENTER - bot.x);
        } else {
            const visionRadius = GAME_CONFIG.BOT_VISION_RADIUS;
            const gx = Math.floor(bot.x / GAME_CONFIG.GRID_SIZE), gy = Math.floor(bot.y / GAME_CONFIG.GRID_SIZE);

            for (let x = -1; x <= 1; x++) {
                for (let y = -1; y <= 1; y++) {
                    const neighbors = spatialGrid[`${gx + x},${gy + y}`];
                    if (neighbors) {
                        for (let other of neighbors) {
                            if (other.id === bot.id || !other.history) continue;
                            for (let i = 0; i < other.history.length; i += 10) {
                                const seg = other.history[i];
                                if (!seg) continue;
                                if (Math.hypot(bot.x - seg.x, bot.y - seg.y) < visionRadius) {
                                    fleeAngle = Math.atan2(bot.y - seg.y, bot.x - seg.x); break;
                                }
                            }
                            if (fleeAngle !== null) break;
                        }
                    }
                    if (fleeAngle !== null) break;
                }
            }
        }

        if (fleeAngle !== null) { bot.targetAngle = fleeAngle; bot.aiTimer = 10; }
        else if (--bot.aiTimer <= 0) { bot.targetAngle += (Math.random() - 0.5) * 2; bot.aiTimer = 40 + Math.random() * 60; }

        let diff = bot.targetAngle - bot.angle;
        while (diff < -Math.PI) diff += Math.PI * 2; while (diff > Math.PI) diff -= Math.PI * 2;
        bot.angle += diff * 0.1 * SERVER_DT;

        const moveSpeed = bot.speed * SERVER_DT;
        bot.x += Math.cos(bot.angle) * moveSpeed; bot.y += Math.sin(bot.angle) * moveSpeed;

        const pVx = Math.cos(bot.angle), pVy = Math.sin(bot.angle);
        bot.distAccum = (bot.distAccum || 0) + moveSpeed;
        while (bot.distAccum >= GAME_CONFIG.SNAKE_HISTORY_STEP) {
            bot.distAccum -= GAME_CONFIG.SNAKE_HISTORY_STEP;
            bot.history.unshift({ x: bot.x - pVx * bot.distAccum, y: bot.y - pVy * bot.distAccum });
        }
        const targetLen = Math.min(GAME_CONFIG.MAX_HISTORY_LENGTH, Math.floor(bot.length * GAME_CONFIG.SNAKE_HISTORY_SPACING) + 1);
        if (bot.history.length > targetLen) bot.history.length = targetLen;

        if (distToCenter > CENTER - bot.radius * 0.8) killBot(bot);

        if (!bot.isDead) {
            const gx = Math.floor(bot.x / GAME_CONFIG.GRID_SIZE), gy = Math.floor(bot.y / GAME_CONFIG.GRID_SIZE);
            let collisionTriggered = false;
            for (let x = -1; x <= 1 && !collisionTriggered; x++) {
                for (let y = -1; y <= 1 && !collisionTriggered; y++) {
                    const neighbors = spatialGrid[`${gx + x},${gy + y}`];
                    if (neighbors) {
                        for (let other of neighbors) {
                            // Se o bot encostar noutra entidade, ELE morre!
                            if (other.id !== bot.id && checkCollision(bot, other)) {
                                killBot(bot); collisionTriggered = true; break;
                            }
                        }
                    }
                }
            }
        }

        for (let i = foods.length - 1; i >= 0; i--) {
            const f = foods[i], distSq = (bot.x - f.x) ** 2 + (bot.y - f.y) ** 2, eatThreshold = bot.radius + (f.radius || 2);
            if (distSq < eatThreshold ** 2) {
                const foodId = f.id; foods.splice(i, 1);
                bot.score += f.isDeathFood ? GAME_CONFIG.DEATH_SCORE : GAME_CONFIG.SCORE_PER_FOOD;

                bot.length = calculateLengthFromScore(bot.score);
                bot.radius = getEntityRadius(bot.length);

                if (foods.length < GAME_CONFIG.TOTAL_FOOD) {
                    const newFood = spawnFood(); foods.push(newFood);
                    io.emit('foodEaten', { foodId, newFood });
                } else {
                    io.emit('foodEaten', { foodId, newFood: null });
                }
            }
        }
    });

    io.emit('botsUpdated', bots.map(b => ({
        id: b.id, name: b.name,
        x: parseFloat(b.x.toFixed(2)),
        y: parseFloat(b.y.toFixed(2)),
        angle: parseFloat(b.angle.toFixed(3)),
        score: Math.round(b.score),
        radius: parseFloat(b.radius.toFixed(1)),
        skinIndex: b.skinIndex,
        length: parseFloat(b.length.toFixed(1)),
        isBoosting: b.isBoosting || false,
        isDead: b.isDead || false
    })));

}, 1000 / GAME_CONFIG.SERVER_TICK_RATE);

// --- ROTAS E SOCKETS ---
app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

io.on('connection', (socket) => {
    socket.on('join', (data) => {
        const pos = getSafePosition();
        players[socket.id] = {
            id: socket.id, name: data.name || 'Convidado',
            x: pos.x, y: pos.y, angle: 0, score: 0,
            length: GAME_CONFIG.SNAKE_INITIAL_LENGTH, radius: GAME_CONFIG.SNAKE_INITIAL_RADIUS,
            // CORREÇÃO CRÍTICA 1: Iniciar corpo na entrada. Sem isto, o bot atravessava um fantasma.
            history: Array.from({ length: Math.min(GAME_CONFIG.MAX_HISTORY_LENGTH, Math.floor(GAME_CONFIG.SNAKE_INITIAL_LENGTH * GAME_CONFIG.SNAKE_HISTORY_SPACING) + 10) }, () => ({ x: pos.x, y: pos.y })),
            skinIndex: data.skinIndex || 0, isDead: false
        };
        socket.emit('init', { id: socket.id, players, foods, config: GAME_CONFIG });

        socket.broadcast.emit('playerJoined', players[socket.id]);
    });

    socket.on('update', (data) => {
        const p = players[socket.id];
        if (p) {
            const dx = data.x - p.x;
            const dy = data.y - p.y;
            const distMoved = Math.hypot(dx, dy);

            p.x = data.x;
            p.y = data.y;
            p.angle = data.angle;
            p.isBoosting = data.isBoosting;

            p.score = Math.max(0, data.score || 0);
            p.length = calculateLengthFromScore(p.score);
            p.radius = getEntityRadius(p.length);

            if (!p.history) p.history = [];

            // CORREÇÃO CRÍTICA 2: O sistema agora rastreia o movimento EXATAMENTE como no cliente
            // Não há mais perda de decimais (pixels engolidos) que deixavam o rabo curto
            if (distMoved > 0.001) {
                const pVx = dx / distMoved;
                const pVy = dy / distMoved;

                p.distAccum = (p.distAccum || 0) + distMoved;
                while (p.distAccum >= GAME_CONFIG.SNAKE_HISTORY_STEP) {
                    p.distAccum -= GAME_CONFIG.SNAKE_HISTORY_STEP;
                    p.history.unshift({
                        x: p.x - pVx * p.distAccum,
                        y: p.y - pVy * p.distAccum
                    });
                }
            }

            const targetLen = Math.min(GAME_CONFIG.MAX_HISTORY_LENGTH, Math.floor(p.length * GAME_CONFIG.SNAKE_HISTORY_SPACING) + 1);
            if (p.history.length > targetLen) p.history.length = targetLen;

            socket.broadcast.emit('playerUpdated', {
                id: p.id,
                x: parseFloat(p.x.toFixed(2)),
                y: parseFloat(p.y.toFixed(2)),
                angle: parseFloat(p.angle.toFixed(3)),
                score: Math.round(p.score),
                length: parseFloat(p.length.toFixed(1)),
                radius: parseFloat(p.radius.toFixed(1)),
                isBoosting: p.isBoosting,
                isDead: p.isDead || false,
                skinIndex: p.skinIndex
            });
        }
    });

    socket.on('eatFood', (foodId) => {
        const p = players[socket.id];
        if (!p) return;
        const idx = foods.findIndex(f => f.id === foodId);
        if (idx !== -1) {
            if (Math.hypot(p.x - foods[idx].x, p.y - foods[idx].y) < p.radius + 150) {
                foods.splice(idx, 1);

                let newFood = null;
                if (foods.length < GAME_CONFIG.TOTAL_FOOD) {
                    newFood = spawnFood();
                    foods.push(newFood);
                }
                io.emit('foodEaten', { foodId, newFood });
            }
        }
    });

    socket.on('playerDied', () => {
        const p = players[socket.id];
        if (p && !p.isDead) {
            p.isDead = true;
            dropDeathFood(p);
            io.emit('botDied', { id: p.id, x: p.x, y: p.y });
            delete players[socket.id];
            io.emit('playerLeft', socket.id);
        }
    });

    socket.on('disconnect', () => {
        const p = players[socket.id];
        if (p && !p.isDead) {
            dropDeathFood(p);
            delete players[socket.id];
            io.emit('playerLeft', socket.id);
        }
    });
});

server.listen(PORT, () => console.log(`Rodando em http://localhost:${PORT}`));