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
    WORLD_SIZE: 9000,                 // Tamanho total da arena
    TOTAL_FOOD: 1500,                 // Quantidade máxima de comida normal

    SNAKE_INITIAL_LENGTH: 30,         // Tamanho inicial
    SNAKE_INITIAL_RADIUS: 18,         // Raio base
    SNAKE_MAX_RADIUS: 55,             // Limite máximo de grossura
    SNAKE_HISTORY_STEP: 1,            // Passo de precisão da física
    SNAKE_HISTORY_SPACING: 5,         // Distância visual entre as listras
    SNAKE_BASE_SPEED: 4.0,            // Velocidade IGUAL para bots e players

    SNAKE_HITBOX_SIZE: 0.75,          // Hitbox física real do corpo inimigo (75% da largura)
    SNAKE_TURN_SPEED: 0.035,          // Rapidez máxima de curva
    SNAKE_TURN_SPEED_BOOST: 0.015,    // Rapidez de curva ao correr

    GROWTH_PER_FOOD: 1.0,             // Crescimento por comida normal
    SCORE_PER_FOOD: 8,               // Pontos por comida normal
    DEATH_GROWTH: 0.50,               // Crescimento por comida da morte
    DEATH_SCORE: 30,                  // Pontos por comida da morte
    WIDTH_GROWTH_FACTOR: 0.15,        // Crescimento em largura

    NUM_BOTS: 30,                     // Quantidade de Bots
    SPAWN_SAFE_RADIUS: 2500,          // Distância segura de spawn
    BOT_VISION_RADIUS: 1500,          // IA: Campo de visão para evitar colisões

    SERVER_TICK_RATE: 25,             // 40ms interval (25 FPS sync)
    GRID_SIZE: 450                    // Grid de colisão otimizado
};

const CENTER = GAME_CONFIG.WORLD_SIZE / 2;

// Cálculo do Delta Time do servidor em relação aos 60 FPS do Front-end
// Isso garante que os bots se movem à mesma velocidade no servidor e no ecrã!
const SERVER_DT = 60 / GAME_CONFIG.SERVER_TICK_RATE;

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
    const entities = [...Object.values(players), ...bots];
    entities.forEach(ent => {
        if (ent.isDead) return;

        // Registrar a cabeça
        const gx = Math.floor(ent.x / GAME_CONFIG.GRID_SIZE);
        const gy = Math.floor(ent.y / GAME_CONFIG.GRID_SIZE);
        const headKey = `${gx},${gy}`;
        if (!spatialGrid[headKey]) spatialGrid[headKey] = [];
        spatialGrid[headKey].push(ent);

        // Registrar o corpo (amostrado para performance)
        if (ent.history) {
            const addedKeys = new Set([headKey]);
            for (let i = 0; i < ent.history.length; i += 15) {
                const seg = ent.history[i];
                if (!seg) continue;
                const sgx = Math.floor(seg.x / GAME_CONFIG.GRID_SIZE);
                const sgy = Math.floor(seg.y / GAME_CONFIG.GRID_SIZE);
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
        const angle = Math.random() * Math.PI * 2;
        const r = Math.random() * (CENTER - 1000);
        const x = CENTER + Math.cos(angle) * r;
        const y = CENTER + Math.sin(angle) * r;

        let isSafe = true;
        const entities = [...Object.values(players), ...bots];

        for (let ent of entities) {
            if (Math.hypot(x - ent.x, y - ent.y) < safeDistance) { isSafe = false; break; }
            if (ent.history) {
                for (let i = 0; i < ent.history.length; i += 10) {
                    if (Math.hypot(x - ent.history[i].x, y - ent.history[i].y) < safeDistance / 2) {
                        isSafe = false; break;
                    }
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

    const initialScore = isBoss ? 500 + Math.random() * 1500 : 100;
    const initialLength = isBoss ? 80 + Math.random() * 150 : GAME_CONFIG.SNAKE_INITIAL_LENGTH;
    const initialRadius = Math.min(GAME_CONFIG.SNAKE_MAX_RADIUS, GAME_CONFIG.SNAKE_INITIAL_RADIUS + (initialLength - GAME_CONFIG.SNAKE_INITIAL_LENGTH) * GAME_CONFIG.WIDTH_GROWTH_FACTOR);

    return {
        id: 'bot-' + Math.random().toString(36).substr(2, 9),
        name: botNames[Math.floor(Math.random() * botNames.length)] + (isBoss ? ' [BOSS]' : ''),
        x: pos.x, y: pos.y,
        angle: Math.random() * Math.PI * 2,
        targetAngle: Math.random() * Math.PI * 2,
        score: initialScore,
        length: initialLength,
        radius: initialRadius,
        // Usar Array.from evita bugs de referência de memória na criação da cauda
        history: Array.from({ length: Math.floor(initialLength * GAME_CONFIG.SNAKE_HISTORY_SPACING) + 10 }, () => ({ x: pos.x, y: pos.y })),
        skinIndex: Math.floor(Math.random() * 10),
        aiTimer: 0,
        speed: GAME_CONFIG.SNAKE_BASE_SPEED,
        isDead: false,
        distAccum: 0
    };
}

function killBot(bot) {
    if (!bot || bot.isDead) return;
    bot.isDead = true;

    console.log(`Bot ${bot.name} (${bot.id}) morreu.`);
    dropDeathFood(bot);

    io.emit('botDied', { id: bot.id, x: bot.x, y: bot.y });

    const idx = bots.indexOf(bot);
    if (idx !== -1) bots.splice(idx, 1);

    setTimeout(() => {
        bots.push(createBot());
    }, 500);
}

for (let i = 0; i < GAME_CONFIG.NUM_BOTS; i++) bots.push(createBot());
for (let i = 0; i < GAME_CONFIG.TOTAL_FOOD; i++) foods.push(spawnFood());

// --- LÓGICA DE COLISÃO (ALINHADA COM O CLIENTE) ---
function checkCollision(head, target) {
    if (!target.history || target.history.length < 2) return false;

    const headRadius = head.radius || GAME_CONFIG.SNAKE_INITIAL_RADIUS;
    const targetRadius = target.radius || GAME_CONFIG.SNAKE_INITIAL_RADIUS;

    // A ponta exata do "nariz"
    const tipX = head.x + Math.cos(head.angle) * (headRadius * 0.65);
    const tipY = head.y + Math.sin(head.angle) * (headRadius * 0.65);

    // Hitbox estrita idêntica ao front-end
    const myHitboxR = headRadius * 0.35;
    const targetHitboxR = targetRadius * GAME_CONFIG.SNAKE_HITBOX_SIZE;
    const thresholdSq = (myHitboxR + targetHitboxR) ** 2;

    const spacing = GAME_CONFIG.SNAKE_HISTORY_SPACING;
    const maxIdx = Math.min(Math.floor((target.length || GAME_CONFIG.SNAKE_INITIAL_LENGTH) * spacing), target.history.length - 1);

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
    const segments = Math.floor(snake.length);

    for (let i = 0; i < segments; i++) {
        const pos = i === 0 ? { x: snake.x, y: snake.y } : snake.history[i * spacing];
        if (!pos) continue;

        // Comida central
        const f1 = {
            id: `df_${Date.now()}_${Math.random()}`,
            x: pos.x, y: pos.y, radius: GAME_CONFIG.DEATH_FOOD_RADIUS,
            color: ['#ff0055', '#00ffaa', '#00ddff', '#ffdd00', '#ff6600', '#aa00ff'][Math.floor(Math.random() * 6)],
            isDeathFood: true
        };
        // Comida lateral
        const rOffset = Math.random() * (snake.radius * 0.6);
        const angle = Math.random() * Math.PI * 2;
        const f2 = {
            id: `df_${Date.now()}_${Math.random()}`,
            x: pos.x + Math.cos(angle) * rOffset, y: pos.y + Math.sin(angle) * rOffset,
            radius: GAME_CONFIG.DEATH_FOOD_RADIUS,
            color: f1.color, isDeathFood: true
        };

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
            const gx = Math.floor(bot.x / GAME_CONFIG.GRID_SIZE);
            const gy = Math.floor(bot.y / GAME_CONFIG.GRID_SIZE);

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
                                    fleeAngle = Math.atan2(bot.y - seg.y, bot.x - seg.x);
                                    break;
                                }
                            }
                            if (fleeAngle !== null) break;
                        }
                    }
                    if (fleeAngle !== null) break;
                }
            }
        }

        if (fleeAngle !== null) {
            bot.targetAngle = fleeAngle;
            bot.aiTimer = 10;
        } else if (--bot.aiTimer <= 0) {
            bot.targetAngle += (Math.random() - 0.5) * 2;
            bot.aiTimer = 40 + Math.random() * 60;
        }

        let diff = bot.targetAngle - bot.angle;
        while (diff < -Math.PI) diff += Math.PI * 2;
        while (diff > Math.PI) diff -= Math.PI * 2;
        bot.angle += diff * 0.1 * SERVER_DT;

        // Aplicamos o SERVER_DT para o bot ter a mesma velocidade real que tem no Front-end
        const moveSpeed = bot.speed * SERVER_DT;
        bot.x += Math.cos(bot.angle) * moveSpeed;
        bot.y += Math.sin(bot.angle) * moveSpeed;

        // Construção do Histórico igualitária
        const pVx = Math.cos(bot.angle), pVy = Math.sin(bot.angle);
        bot.distAccum = (bot.distAccum || 0) + moveSpeed;
        while (bot.distAccum >= GAME_CONFIG.SNAKE_HISTORY_STEP) {
            bot.distAccum -= GAME_CONFIG.SNAKE_HISTORY_STEP;
            bot.history.unshift({ x: bot.x - pVx * bot.distAccum, y: bot.y - pVy * bot.distAccum });
        }
        const targetLen = Math.floor(bot.length * GAME_CONFIG.SNAKE_HISTORY_SPACING) + 1;
        if (bot.history.length > targetLen) bot.history.length = targetLen;

        if (distToCenter > CENTER - bot.radius * 0.8) killBot(bot);

        // --- BOTS COLISÃO (O Servidor apenas mata os BOTS) ---
        if (!bot.isDead) {
            const gx = Math.floor(bot.x / GAME_CONFIG.GRID_SIZE);
            const gy = Math.floor(bot.y / GAME_CONFIG.GRID_SIZE);
            let collisionTriggered = false;

            for (let x = -1; x <= 1 && !collisionTriggered; x++) {
                for (let y = -1; y <= 1 && !collisionTriggered; y++) {
                    const neighbors = spatialGrid[`${gx + x},${gy + y}`];
                    if (neighbors) {
                        for (let other of neighbors) {
                            if (other.id !== bot.id && checkCollision(bot, other)) {
                                killBot(bot);
                                collisionTriggered = true;
                                break;
                            }
                        }
                    }
                }
            }
        }

        // --- BOTS COMEM COMIDA ---
        for (let i = foods.length - 1; i >= 0; i--) {
            const f = foods[i];
            const distSq = (bot.x - f.x) ** 2 + (bot.y - f.y) ** 2;
            const eatThreshold = bot.radius + (f.radius || 2);

            if (distSq < eatThreshold ** 2) {
                const foodId = f.id;
                foods.splice(i, 1);

                bot.score += f.isDeathFood ? GAME_CONFIG.DEATH_SCORE : GAME_CONFIG.SCORE_PER_FOOD;
                bot.length += f.isDeathFood ? GAME_CONFIG.DEATH_GROWTH : GAME_CONFIG.GROWTH_PER_FOOD;
                bot.radius = Math.min(GAME_CONFIG.SNAKE_MAX_RADIUS, GAME_CONFIG.SNAKE_INITIAL_RADIUS + (bot.length - GAME_CONFIG.SNAKE_INITIAL_LENGTH) * GAME_CONFIG.WIDTH_GROWTH_FACTOR);

                const newFood = spawnFood();
                foods.push(newFood);
                io.emit('foodEaten', { foodId, newFood });
            }
        }
    });

    io.emit('botsUpdated', bots.map(b => ({
        id: b.id, name: b.name, x: Math.round(b.x), y: Math.round(b.y), angle: b.angle,
        score: b.score, radius: Math.round(b.radius), skinIndex: b.skinIndex,
        length: b.length, isBoosting: b.isBoosting || false, isDead: b.isDead || false
    })));

    // NOTA IMPORTANTE: Removi o bloco que matava os players do lado do servidor à força.
    // Agora o servidor confia no evento "playerDied" do cliente. Adeus Ghost Deaths!

    Object.keys(players).forEach(id => {
        const p = players[id];
        io.emit('playerUpdated', {
            id: p.id, x: Math.round(p.x), y: Math.round(p.y), angle: p.angle,
            score: p.score, length: p.length, radius: Math.round(p.radius),
            isBoosting: p.isBoosting, isDead: p.isDead || false, skinIndex: p.skinIndex
        });
    });
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
            history: [], skinIndex: data.skinIndex || 0, isDead: false
        };
        socket.emit('init', { id: socket.id, players, foods, config: GAME_CONFIG });
    });

    socket.on('update', (data) => {
        const p = players[socket.id];
        if (p) {
            p.x = data.x; p.y = data.y; p.angle = data.angle;
            p.score = data.score; p.length = data.length; p.radius = data.radius; p.isBoosting = data.isBoosting;

            if (!p.history) p.history = [];

            // Guardar pontos do player de forma eficiente para a colisão dos bots funcionar
            if (!p.lastHistoryX) { p.lastHistoryX = p.x; p.lastHistoryY = p.y; }
            const distSinceLast = Math.hypot(p.x - p.lastHistoryX, p.y - p.lastHistoryY);

            if (distSinceLast >= GAME_CONFIG.SNAKE_HISTORY_STEP) {
                p.history.unshift({ x: p.x, y: p.y });
                p.lastHistoryX = p.x;
                p.lastHistoryY = p.y;
                const targetLen = Math.floor(p.length * GAME_CONFIG.SNAKE_HISTORY_SPACING) + 1;
                if (p.history.length > targetLen) p.history.length = targetLen;
            }
        }
    });

    socket.on('eatFood', (foodId) => {
        const p = players[socket.id];
        if (!p) return;
        const idx = foods.findIndex(f => f.id === foodId);
        if (idx !== -1) {
            const dist = Math.hypot(p.x - foods[idx].x, p.y - foods[idx].y);
            if (dist < p.radius + 150) { // Tolerância anti-lag
                foods.splice(idx, 1);
                const newFood = spawnFood();
                foods.push(newFood);
                io.emit('foodEaten', { foodId, newFood });
            }
        }
    });

    // O servidor agora confia plenamente na deteção super-precisa de 60fps do cliente
    socket.on('playerDied', () => {
        const p = players[socket.id];
        if (p && !p.isDead) {
            p.isDead = true;
            dropDeathFood(p);

            // Reutiliza o evento botDied para avisar a todos os clientes que houve uma morte ali
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