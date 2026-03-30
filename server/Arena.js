// server/Arena.js

const CONFIG = {
    mundo: {
        tamanhoRaio: 8000,
        quantidadeComida: 5000, // Reduced for server MVP
        tamanhoComidaMin: 5.0,
        forcaAtracao: 40,
        quantidadeBots: 100
    },
    cobra: {
        espessuraInicial: 18,
        espessuraMaxima: 30,
        comprimentoInicial: 25,
        distanciaGomos: 0.22,
        pontosParaEngrossar: 130,
        pontosParaCrescer: 6,
        custoDoTurbo: 2.5,
        velocidadeBase: 3.5,
        velocidadeTurbo: 7.0
    }
};

function getRandomPosInCircle(p = 50) {
    let r = Math.sqrt(Math.random()) * (CONFIG.mundo.tamanhoRaio - p), t = Math.random() * 2 * Math.PI;
    return { x: CONFIG.mundo.tamanhoRaio + r * Math.cos(t), y: CONFIG.mundo.tamanhoRaio + r * Math.sin(t) };
}

class Arena {
    constructor(id, io) {
        this.id = id;
        this.io = io; // SocketIO instance to broadcast to this room
        this.players = {}; // Key: socket.id
        this.bots = [];
        this.foods = [];
        
        this.frameCount = 0;

        // Populate initial food
        for (let i = 0; i < 1000; i++) this.spawnFood();

        this.loop = setInterval(() => this.tick(), 1000 / 20); // 20 Ticks/sec (Authoritative Tickrate)
        console.log(`[Arena ${this.id}] Server Loop Initialized.`);
    }

    addPlayer(socketId, name, skinId) {
        const p = getRandomPosInCircle(300);
        this.players[socketId] = {
            id: socketId,
            name: name,
            skinId: skinId,
            x: p.x,
            y: p.y,
            angle: Math.random() * Math.PI * 2,
            targetAngle: Math.random() * Math.PI * 2,
            speed: CONFIG.cobra.velocidadeBase,
            isBoosting: false,
            score: 40,
            alive: true,
            radius: CONFIG.cobra.espessuraInicial,
            segments: Array(CONFIG.cobra.comprimentoInicial).fill().map(() => ({ x: p.x, y: p.y }))
        };
    }

    removePlayer(socketId) {
        delete this.players[socketId];
    }

    handleInput(socketId, data) {
        if (this.players[socketId] && this.players[socketId].alive) {
            this.players[socketId].targetAngle = data.angle;
            this.players[socketId].isBoosting = data.isBoosting;
        }
    }

    spawnFood() {
        let p = getRandomPosInCircle(20);
        this.foods.push({
            x: p.x, y: p.y,
            radius: CONFIG.mundo.tamanhoComidaMin + Math.random() * 4,
            value: 2
        });
    }

    tick() {
        this.frameCount++;
        
        let allSnakes = Object.values(this.players).concat(this.bots);
        
        for (let s of allSnakes) {
            if (!s.alive) continue;
            
            // Movement Logic
            const speed = s.isBoosting && s.score > 20 ? CONFIG.cobra.velocidadeTurbo : CONFIG.cobra.velocidadeBase;
            if (s.isBoosting && s.score > 20) s.score -= CONFIG.cobra.custoDoTurbo / 20; // Cost per tick

            s.radius = Math.min(CONFIG.cobra.espessuraInicial + Math.floor(s.score / CONFIG.cobra.pontosParaEngrossar), CONFIG.cobra.espessuraMaxima);
            let tLength = CONFIG.cobra.comprimentoInicial + Math.floor(s.score / CONFIG.cobra.pontosParaCrescer);
            while (s.segments.length < tLength) s.segments.push({ x: s.segments[s.segments.length - 1].x, y: s.segments[s.segments.length - 1].y });

            let diff = s.targetAngle - s.angle;
            while (diff < -Math.PI) diff += Math.PI * 2;
            while (diff > Math.PI) diff -= Math.PI * 2;
            s.angle += diff * 0.15; // Turn speed
            
            s.x += Math.cos(s.angle) * speed;
            s.y += Math.sin(s.angle) * speed;

            // Boundaries (Kill if touching world edge)
            if (Math.hypot(s.x - CONFIG.mundo.tamanhoRaio, s.y - CONFIG.mundo.tamanhoRaio) > CONFIG.mundo.tamanhoRaio) {
                s.alive = false;
                continue;
            }

            // Move segments
            let pX = s.x, pY = s.y, spc = s.radius * CONFIG.cobra.distanciaGomos;
            for (let i = 0; i < s.segments.length; i++) {
                let seg = s.segments[i];
                let dx = pX - seg.x, dy = pY - seg.y, d = Math.sqrt(dx * dx + dy * dy);
                if (d > spc) {
                    let mv = d - spc;
                    seg.x += (dx / d) * mv;
                    seg.y += (dy / d) * mv;
                }
                pX = seg.x; pY = seg.y;
            }
        }

        // --- Network Delta Broadcast ---
        // Sending full array of segments is heavily bandwidth intensive. 
        // We will send only the head positions and angle. Clients can interpolate.
        const snapshot = {
            p: allSnakes.filter(s => s.alive).map(s => ({
                id: s.id, x: Math.round(s.x), y: Math.round(s.y), a: parseFloat(s.angle.toFixed(2)), s: Math.round(s.score)
            })),
            f: this.foods // Temporário: Numa versão final isto seria culling espacial
        };

        this.io.to(this.id).emit('tick', snapshot);
    }
}

module.exports = Arena;
