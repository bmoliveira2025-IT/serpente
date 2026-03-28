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
    TOTAL_FOOD: 2000,                 // Aumentado para manter a abundância com o novo ecossistema

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

    SNAKE_HITBOX_SIZE: 0.65,          // Reduzido para maior precisão (mais difícil de bater)
    SNAKE_TURN_SPEED: 0.035,
    SNAKE_TURN_SPEED_BOOST: 0.015,

    // --- NOVO BALANÇO CHALLENGING (Crescimento reduzido a metade) ---
    GROWTH_PER_FOOD: 1.5,             
    SCORE_PER_FOOD: 8,               
    DEATH_GROWTH: 5.625,              // Proporcional: (30 / 8) * 1.5
    DEATH_SCORE: 30,                  
    
    WIDTH_GROWTH_FACTOR: 0.15,        // Crescimento de largura ainda mais subtil
    MAX_HISTORY_LENGTH: 50000,        

    // Sincronização do Boost para evitar o ecrã divergir da pontuação
    BOOST_SPEED_MULT: 2.0,            
    BOOST_SCORE_LOSS: 2,              
    BOOST_LENGTH_LOSS: 0.375,         
    BOOST_MIN_LENGTH: 40,             
    
    // --- NOVAS CONFIGURAÇÕES DE ECOSSISTEMA DE COMIDA (v1.9.5) ---
    FOOD_GROWTH_RATE: 0.04,           // Velocidade de crescimento das bolinhas normais
    FIREFLY_SPAWN_CHANCE: 0.02,       // 2% de chance de nascer uma presa móvel (Vagalume)
    FIREFLY_SCORE: 75,                // Pontos base do vagalume
    FIREFLY_SPEED: 2.2,               // Velocidade de fuga
    DEATH_FOOD_RADIUS: 5.0,           // Tamanho base maior para restos
    DEATH_DROP_PERCENTAGE: 0.22,      // Drop de ~22% da massa

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

function spawnFood(type = 'NORMAL', srcX, srcY, customScore = 0) {
    let x = srcX, y = srcY;

    // Densidade maior no centro (Curva Exponencial) - Paridade v1.9.5
    if (type === 'NORMAL' || type === 'FIREFLY') {
        const angle = Math.random() * Math.PI * 2;
        const r = Math.pow(Math.random(), 1.5) * (CENTER - 50);
        x = CENTER + Math.cos(angle) * r;
        y = CENTER + Math.sin(angle) * r;
    }

    if (type === 'NORMAL' && Math.random() < GAME_CONFIG.FIREFLY_SPAWN_CHANCE) {
        type = 'FIREFLY';
    }

    let radius = 2;
    let scoreValue = GAME_CONFIG.SCORE_PER_FOOD;
    let growthValue = GAME_CONFIG.GROWTH_PER_FOOD;
    let vx = 0, vy = 0;

    if (type === 'FIREFLY') {
        radius = 6 + Math.random() * 2;
        scoreValue = GAME_CONFIG.FIREFLY_SCORE + (Math.random() * 25);
        growthValue = scoreValue * (GAME_CONFIG.GROWTH_PER_FOOD / GAME_CONFIG.SCORE_PER_FOOD);
        const a = Math.random() * Math.PI * 2;
        vx = Math.cos(a) * GAME_CONFIG.FIREFLY_SPEED;
        vy = Math.sin(a) * GAME_CONFIG.FIREFLY_SPEED;
    } else if (type === 'DEATH') {
        radius = GAME_CONFIG.DEATH_FOOD_RADIUS + Math.random() * 2.5;
        scoreValue = customScore;
        growthValue = customScore * (GAME_CONFIG.GROWTH_PER_FOOD / GAME_CONFIG.SCORE_PER_FOOD);
    } else if (type === 'BOOST') {
        radius = 2.5;
        scoreValue = GAME_CONFIG.BOOST_SCORE_LOSS;
        growthValue = GAME_CONFIG.BOOST_LENGTH_LOSS;
    }

    return {
        id: Math.random().toString(36).substr(2, 9),
        type: type,
        x: x, y: y,
        vx: vx, vy: vy,
        radius: radius,
        targetRadius: type === 'NORMAL' ? radius + Math.random() * 3 + 1 : radius,
        color: ['#ff0055', '#00ffaa', '#00ddff', '#ffdd00', '#ff6600', '#aa00ff'][Math.floor(Math.random() * 6)],
        phase: Math.random() * Math.PI * 2,
        scoreValue: scoreValue,
        growthValue: growthValue
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
    if (!snake || !snake.history || snake.score <= 0) return;

    // Cobra larga apenas 22% da sua massa (Paridade v1.9.5)
    const dropPercentage = GAME_CONFIG.DEATH_DROP_PERCENTAGE + (Math.random() * 0.03);
    const totalDropScore = snake.score * dropPercentage;

    const spacing = GAME_CONFIG.SNAKE_HISTORY_SPACING;
    const segments = Math.min(Math.floor(snake.length), Math.floor(snake.history.length / spacing));

    // 2 a 3 orbes por segmento corporal
    const numFoods = Math.max(1, segments * 2);
    const scorePerFood = totalDropScore / numFoods;
    const newFoods = [];

    for (let i = 0; i < segments; i++) {
        const pos = i === 0 ? { x: snake.x, y: snake.y } : snake.history[i * spacing];
        if (!pos) continue;

        const r1 = Math.random() * (snake.radius * 0.6), a1 = Math.random() * Math.PI * 2;
        const f1 = spawnFood('DEATH', pos.x + Math.cos(a1) * r1, pos.y + Math.sin(a1) * r1, scorePerFood);
        
        const r2 = Math.random() * (snake.radius * 0.6), a2 = Math.random() * Math.PI * 2;
        const f2 = spawnFood('DEATH', pos.x + Math.cos(a2) * r2, pos.y + Math.sin(a2) * r2, scorePerFood);

        foods.push(f1, f2);
        newFoods.push(f1, f2);
    }

    if (newFoods.length > 0) io.emit('deathResidue', newFoods);
}

// --- LOOP PRINCIPAL (TICK) ---
setInterval(() => {
    updateSpatialGrid();

    // --- DINÂMICA DA COMIDA (v1.9.5) ---
    const dt = SERVER_DT;
    for (let f of foods) {
        // Crescimento Orgânico
        if (f.type === 'NORMAL' && f.radius < f.targetRadius) {
            f.radius += GAME_CONFIG.FOOD_GROWTH_RATE * dt;
            f.scoreValue += (GAME_CONFIG.FOOD_GROWTH_RATE * 2) * dt;
            f.growthValue = f.scoreValue * (GAME_CONFIG.GROWTH_PER_FOOD / GAME_CONFIG.SCORE_PER_FOOD);
        }

        // IA de Fuga dos Vagalumes
        if (f.type === 'FIREFLY') {
            for (let pId in players) {
                const p = players[pId];
                if (!p.isDead) {
                    const dToPlayer = Math.hypot(p.x - f.x, p.y - f.y);
                    if (dToPlayer < 400) {
                        const escapeAngle = Math.atan2(f.y - p.y, f.x - p.x);
                        f.vx += Math.cos(escapeAngle) * 0.3 * dt;
                        f.vy += Math.sin(escapeAngle) * 0.3 * dt;
                    }
                }
            }

            let speed = Math.hypot(f.vx, f.vy);
            if (speed > GAME_CONFIG.FIREFLY_SPEED * 2) {
                f.vx = (f.vx / speed) * GAME_CONFIG.FIREFLY_SPEED * 2;
                f.vy = (f.vy / speed) * GAME_CONFIG.FIREFLY_SPEED * 2;
            } else if (speed < GAME_CONFIG.FIREFLY_SPEED) {
                f.vx *= 1.05; f.vy *= 1.05;
            }

            f.x += f.vx * dt; f.y += f.vy * dt;
            if (Math.hypot(f.x - CENTER, f.y - CENTER) > CENTER - 50) { f.vx *= -1; f.vy *= -1; }
        }
    }

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
            const f = foods[i], distSq = (bot.x - f.x) ** 2 + (bot.y - f.y) ** 2, eatThreshold = bot.radius + (f.radius || 2.5);
            if (distSq < eatThreshold ** 2) {
                const foodId = f.id; foods.splice(i, 1);
                
                const pts = f.scoreValue || GAME_CONFIG.SCORE_PER_FOOD;
                const growth = f.growthValue || GAME_CONFIG.GROWTH_PER_FOOD;

                bot.score += pts;
                bot.length = calculateLengthFromScore(bot.score);
                bot.radius = getEntityRadius(bot.length);

                if (foods.length < GAME_CONFIG.TOTAL_FOOD) {
                    const newFood = spawnFood('NORMAL'); foods.push(newFood);
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