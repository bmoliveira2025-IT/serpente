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
// Configurações do Jogo (Sincronizadas com o Cliente)
const GAME_CONFIG = {
    WORLD_SIZE: 9000,                 // Tamanho total da arena
    TOTAL_FOOD: 1500,                 // Quantidade máxima de comida normal

    SNAKE_INITIAL_LENGTH: 30,         // Tamanho inicial
    SNAKE_INITIAL_RADIUS: 18,         // Afinado para um início mais ágil (Sincronizado)
    SNAKE_MAX_RADIUS: 55,             // Limite máximo de grossura (Sincronizado)
    SNAKE_HISTORY_STEP: 1,            // Precisão da física
    SNAKE_HISTORY_SPACING: 5,         // Distância visual entre as listras
    SNAKE_BASE_SPEED: 4.0,            // Velocidade IGUAL para bots e players (Sincronizado)

    SNAKE_HITBOX_SIZE: 0.65,          // Valor de referência (Lógica agora é dinâmica no sistema profissional)
    SNAKE_TURN_SPEED: 0.035,          // Rapidez máxima de curva
    SNAKE_TURN_SPEED_BOOST: 0.015,    // Rapidez de curva ao correr

    GROWTH_PER_FOOD: 1.0,             // Crescimento por comida normal
    SCORE_PER_FOOD: 8,               // Pontos por comida normal
    DEATH_GROWTH: 0.50,               // Crescimento por comida da morte
    DEATH_SCORE: 30,                  // Pontos por comida da morte
    WIDTH_GROWTH_FACTOR: 0.15,        // Crescimento em largura 100% igualitário (Sincronizado)
    MAGNET_STRENGTH: 0.3,             // Atração da comida (desativado)
    MAGNET_RADIUS_MULT: 3.0,          // Área da atração

    BOOST_SPEED_MULT: 2.0,            // Multiplicador de velocidade ao correr
    BOOST_SCORE_LOSS: 2,              // Perda de score contínua
    BOOST_LENGTH_LOSS: 0.2,           // Encolhimento do corpo contínuo
    BOOST_MIN_LENGTH: 10,             // Tamanho mínimo para usar boost
    BOOST_FRAMES_PER_DROP: 2,         // Comida expelida a cada X frames

    NUM_BOTS: 30,                     // Um pouco mais de bots para preencher o mapa
    SPAWN_DELAY: 100,
    SPAWN_SAFE_RADIUS: 2500,          // ⚠️ Aumentado drasticamente: ninguém vê o spawn
    BOT_VISION_RADIUS: 1500,          // ⚠️ IA melhorada: visão ao longe para não colidir
    BOT_AVOID_RADIUS_MULT: 8,         // ⚠️ IA foge de colisões mais depressa

    SERVER_TICK_RATE: 25,             // 40ms interval (25 FPS sync)
    GRID_SIZE: 450                    // Grid de colisão otimizado
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
    const safeDistance = 1500; // Distância mínima para não ser visto ou nascer em cima de alguém

    while (attempts < 100) {
        const x = 500 + Math.random() * (GAME_CONFIG.WORLD_SIZE - 1000);
        const y = 500 + Math.random() * (GAME_CONFIG.WORLD_SIZE - 1000);
        
        let isSafe = true;
        const entities = [...Object.values(players), ...bots];
        
        for (let ent of entities) {
            // 1. Checar cabeça
            const distHead = Math.hypot(x - ent.x, y - ent.y);
            if (distHead < safeDistance) { isSafe = false; break; }

            // 2. Checar TODO o corpo (histórico) - EVITA NASCER EM CIMA DE UMA COBRA LONGA
            if (ent.history) {
                for (let i = 0; i < ent.history.length; i += 2) { // Pular alguns pontos para performance (ainda seguro)
                    const segment = ent.history[i];
                    const distBody = Math.hypot(x - segment.x, y - segment.y);
                    if (distBody < safeDistance / 2) { // Raio menor para o rastro, mas ainda muito seguro
                        isSafe = false;
                        break;
                    }
                }
            }
            if (!isSafe) break;
        }

        if (isSafe) return { x, y };
        attempts++;
    }

    // Fallback se o mapa estiver muito cheio
    return {
        x: 500 + Math.random() * (GAME_CONFIG.WORLD_SIZE - 1000),
        y: 500 + Math.random() * (GAME_CONFIG.WORLD_SIZE - 1000)
    };
}

function createBot() {
    const pos = getSafePosition();
    const isBoss = Math.random() < 0.25; // 25% de chance de ser um bot grande
    
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
        history: Array.from({ length: Math.floor(initialLength * 5) + 10 }, () => ({ x: pos.x, y: pos.y })),
        skinIndex: Math.floor(Math.random() * 10),
        aiTimer: 0,
        speed: GAME_CONFIG.SNAKE_BASE_SPEED,
        isDead: false
    };
}

function killBot(bot) {
    if (!bot || bot.isDead) return;
    bot.isDead = true;

    console.log(`Bot ${bot.name} (${bot.id}) morreu.`);
    dropDeathFood(bot);

    io.emit('botDied', { id: bot.id, x: bot.x, y: bot.y });

    // Remover e renascer um novo bot rapidamente
    const idx = bots.indexOf(bot);
    if (idx !== -1) bots.splice(idx, 1);
    
    setTimeout(() => {
        bots.push(createBot());
    }, 500);
}

// Inicialização
for (let i = 0; i < GAME_CONFIG.NUM_BOTS; i++) bots.push(createBot());
for (let i = 0; i < GAME_CONFIG.TOTAL_FOOD; i++) foods.push(spawnFood());

// --- LÓGICA DE COLISÃO ---

function checkCollision(head, target) {
    if (!target.history || target.history.length < 2) return false;

    // SISTEMA PROFISSIONAL: Recuamos o ponto da cabeça e usamos raio dinâmico
    const tipX = head.x + Math.cos(head.angle) * (head.radius * 0.3);
    const tipY = head.y + Math.sin(head.angle) * (head.radius * 0.3);
    
    const headRadius = head.radius || 20;
    const targetRadius = target.radius || 20;

    // A hitbox real agora soma a nossa cabeça (30% do raio) com o corpo do inimigo (50% do raio dele)
    const thresholdSq = (headRadius * 0.3 + targetRadius * 0.5) ** 2;

    // NECK IMMUNITY: Ignora o início do pescoço (evita double-kills estranhos)
    const startIndex = 20; // Equivalente a spacing * 4 no cliente

    // 1. Checar cabeça do alvo (Só se não for nós mesmos e não estivermos no neck immunity zone)
    const dHead2 = (tipX - target.x) ** 2 + (tipY - target.y) ** 2;
    if (dHead2 < thresholdSq) return true;

    // 2. Checar corpo (histórico)
    for (let i = startIndex; i < target.history.length; i += 2) {
        const seg = target.history[i];
        if (!seg) continue;

        // GHOST PREVENTER: Ignora pontos condensados de spawn
        if (i > 50 && Math.abs(seg.x - target.x) < 2 && Math.abs(seg.y - target.y) < 2) continue;

        const d2 = (tipX - seg.x) ** 2 + (tipY - seg.y) ** 2;
        if (d2 < thresholdSq) return true;
    }
    return false;
}

function dropDeathFood(snake) {
    if (!snake || !snake.history || snake.history.length === 0) return;

    const newFoods = [];
    const historySampleRate = 7; // Soltar comida a cada 7 segmentos para marcar bem o corpo

    for (let i = 0; i < snake.history.length; i += historySampleRate) {
        const pos = snake.history[i];
        if (!pos) continue;
        
        const f = { 
            id: `df_${Date.now()}_${Math.random()}`,
            x: pos.x + (Math.random() - 0.5) * 10, // Pequena variação aleatória para não ficar uma linha perfeita demais
            y: pos.y + (Math.random() - 0.5) * 10,
            radius: 4, 
            color: (i === 0) ? '#ffffff' : ['#ff0055', '#00ffaa', '#00ddff', '#ffdd00', '#ff6600', '#aa00ff'][Math.floor(Math.random() * 6)],
            isDeathFood: true 
        };
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
        if (bot.isDead) {
            bot.deathTimer = Math.max(0, (bot.deathTimer || 1.0) - 0.04);
            return;
        }
        
        const distToCenter = Math.hypot(bot.x - CENTER, bot.y - CENTER);
        
        let fleeAngle = null;
        if (distToCenter > CENTER - 350) {
            // Fuga da borda
            fleeAngle = Math.atan2(CENTER - bot.y, CENTER - bot.x);
        } else {
            // Desvio de outras cobras
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
        bot.angle += diff * 0.1;

        bot.x += Math.cos(bot.angle) * bot.speed;
        bot.y += Math.sin(bot.angle) * bot.speed;

        bot.history.unshift({ x: bot.x, y: bot.y });
        if (bot.history.length > 300) bot.history.pop();

        if (distToCenter > CENTER - bot.radius * 0.8) {
            killBot(bot);
        }

        // --- BOTS COLISÃO (Authoritative) ---
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
                                console.log(`Bot ${bot.name} (${bot.id}) morreu: Colidiu com ${other.name || other.id}`);
                                killBot(bot);
                                collisionTriggered = true;
                                break;
                            }
                        }
                    }
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
        length: b.length,
        isBoosting: b.isBoosting || false,
        isDead: b.isDead || false,
        deathTimer: b.deathTimer !== undefined ? b.deathTimer : 1.0
    })));

    // --- PLAYERS COLISÃO (Authoritative) ---
    Object.keys(players).forEach(id => {
        const p = players[id];
        if (p.isDead) return;

        const gx = Math.floor(p.x / GAME_CONFIG.GRID_SIZE);
        const gy = Math.floor(p.y / GAME_CONFIG.GRID_SIZE);
        let collisionTriggered = false;

        for (let x = -1; x <= 1 && !collisionTriggered; x++) {
            for (let y = -1; y <= 1 && !collisionTriggered; y++) {
                const neighbors = spatialGrid[`${gx + x},${gy + y}`];
                if (neighbors) {
                    for (let other of neighbors) {
                        if (other.id !== p.id && checkCollision(p, other)) {
                            console.log(`Jogador ${p.name} morreu: Colidiu no servidor.`);
                            
                            // Notificar o próprio jogador para ele entrar em DYING
                            io.to(id).emit('youDied');
                            
                            // Processar morte no servidor
                            dropDeathFood(p);
                            io.emit('botDied', { id: p.id, x: p.x, y: p.y }); 
                            delete players[id];
                            io.emit('playerLeft', id);
                            
                            collisionTriggered = true;
                            break;
                        }
                    }
                }
            }
        }
    });

    // Enviar dados compactados para os clientes
    Object.keys(players).forEach(id => {
        const p = players[id];
        if (p.isDead) {
            p.deathTimer = Math.max(0, (p.deathTimer || 1.0) - 0.02);
        }
        io.emit('playerUpdated', {
            id: p.id,
            x: p.x, y: p.y, angle: p.angle,
            score: p.score, length: p.length, radius: p.radius,
            isBoosting: p.isBoosting,
            isDead: p.isDead || false,
            deathTimer: p.deathTimer !== undefined ? p.deathTimer : 1.0,
            skinIndex: p.skinIndex
        });
    });
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
        if (p && !p.isDead) {
            dropDeathFood(p);
            io.emit('botDied', { id: p.id, x: p.x, y: p.y }); 

            // Remover Imediatamente para evitar animação residual
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