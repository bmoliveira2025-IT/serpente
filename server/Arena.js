// server/Arena.js

const CONFIG = {
    mundo: {
        tamanhoRaio: 8000,          // Tamanho do raio circular do mapa. Aumentar cria um oceano maior.
        quantidadeComida: 5000,     // Total de comidas (pontos) espalhados pelo mapa a qualquer momento.
        tamanhoComidaMin: 5.0,      // O tamanho visual mínimo que a comida tem.
        forcaAtracao: 40,           // (Rever) Força do magnetismo se fôssemos usar atração na cobra.
        quantidadeBots: 100         // Quantos Bots automáticos (Inimigos) rodam simultaneamente na nuvem.
    },
    cobra: {
        mobile: {
            espessuraInicial: 22,       // Grossura da cobra ao nascer (mais grosso no telemóvel para visibilidade)
            espessuraMaxima: 40,        // Limite máximo de grossura que ela pode atingir ficando gigante
            comprimentoInicial: 20,     // Gomos corporais no nascimento (Mais curto no mobile evita lag de ecrã pequeno)
            distanciaGomos: 0.22,       // Espaçamento percentual entre as "bolas" do corpo (Não mexer, afeta o LERP)
            pontosParaEngrossar: 150,   // Quantos pontos o jogador tem de comer para a largura da cobra crescer +1 pixel
            pontosParaCrescer: 5,       // Quantos pontos necessários para adicionar um novo "gomo" na cauda
            custoDoTurbo: 2.5,          // Quantos pontos a cobra perde por segundo quando aperta o botão de Acelerar
            velocidadeBase: 6.0,        // Velocidade cruzeiro sem apertar botões no Mobile
            velocidadeTurbo: 8.5        // Velocidade final quando dispara no Mobile
        },
        pc: {
            espessuraInicial: 18,       // Grossura da cobra ao nascer para utilizadores de rato/teclado
            espessuraMaxima: 30,        // O PC tem o ecrã largo, então 30 já parece gigante
            comprimentoInicial: 25,     // Gomos iniciais (Começa um pouco mais comprida no PC)
            distanciaGomos: 0.22,       // Espaçamento entre gomos
            pontosParaEngrossar: 130,   // Engrossa ligeiramente mais rápido no PC
            pontosParaCrescer: 6,       // Precisa de 6 pontos para acrescentar cauda
            custoDoTurbo: 2.5,          // Custo constante de acelerar
            velocidadeBase: 6.5,        // Velocidade base que testámos (mais rápida que a versão offline)
            velocidadeTurbo: 9.0        // Disparo mais rápido devido a resposta de milissegundos do rato
        }
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

        // Limita a quantidade de bots dependendo se for teste rápido ou oci
        const numBots = CONFIG.mundo.quantidadeBots || 50;

        // Populate initial food and bots
        for (let i = 0; i < 1000; i++) this.spawnFood();
        for (let i = 0; i < numBots; i++) this.spawnBot();

        this.loop = setInterval(() => this.tick(), 1000 / 20); // 20 Ticks/sec (Authoritative Tickrate)
        console.log(`[Arena ${this.id}] Server Loop Initialized.`);
    }

    spawnBot() {
        const p = getRandomPosInCircle(400);
        this.bots.push({
            id: 'bot_' + Math.random().toString(36).substr(2, 9),
            name: "Inimigo",
            skinId: Math.floor(Math.random() * 5),
            conf: CONFIG.cobra.pc, // Bots usam as regras do PC
            x: p.x,
            y: p.y,
            angle: Math.random() * Math.PI * 2,
            targetAngle: Math.random() * Math.PI * 2,
            speed: CONFIG.cobra.pc.velocidadeBase,
            isBoosting: false,
            score: 40 + Math.random() * 100, // Bots já começam ligeiramente maiores
            alive: true,
            radius: CONFIG.cobra.pc.espessuraInicial,
            segments: Array(CONFIG.cobra.pc.comprimentoInicial).fill().map(() => ({ x: p.x, y: p.y }))
        });
    }

    addPlayer(socketId, name, skinId, isMobile = false) {
        const p = getRandomPosInCircle(300);
        const playerConf = isMobile ? CONFIG.cobra.mobile : CONFIG.cobra.pc;
        
        this.players[socketId] = {
            id: socketId,
            name: name,
            skinId: skinId,
            conf: playerConf,
            x: p.x,
            y: p.y,
            angle: Math.random() * Math.PI * 2,
            targetAngle: Math.random() * Math.PI * 2,
            speed: playerConf.velocidadeBase,
            isBoosting: false,
            score: 40,
            alive: true,
            radius: playerConf.espessuraInicial,
            segments: Array(playerConf.comprimentoInicial).fill().map(() => ({ x: p.x, y: p.y }))
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
            
            // Lógica de Movimento com Base na Plataforma (PC vs Mobile)
            const speed = s.isBoosting && s.score > 20 ? s.conf.velocidadeTurbo : s.conf.velocidadeBase;
            if (s.isBoosting && s.score > 20) s.score -= s.conf.custoDoTurbo / 20; // Cost per tick

            s.radius = Math.min(s.conf.espessuraInicial + Math.floor(s.score / s.conf.pontosParaEngrossar), s.conf.espessuraMaxima);
            let tLength = s.conf.comprimentoInicial + Math.floor(s.score / s.conf.pontosParaCrescer);
            while (s.segments.length < tLength) s.segments.push({ x: s.segments[s.segments.length - 1].x, y: s.segments[s.segments.length - 1].y });

            let diff = s.targetAngle - s.angle;
            while (diff < -Math.PI) diff += Math.PI * 2;
            while (diff > Math.PI) diff -= Math.PI * 2;
            s.angle += diff * 0.15; // Velocidade de rotação
            
            // Inteligência Artificial Passiva (Nuvem)
            if (s.id.startsWith('bot_')) {
                // 1% de chance a cada 50ms (Tick) de o Bot decidir virar aleatoriamente
                if (Math.random() < 0.03) {
                    s.targetAngle += (Math.random() - 0.5) * 1.5;
                }
            }
            
            s.x += Math.cos(s.angle) * speed;
            s.y += Math.sin(s.angle) * speed;

            // Limites Geográficos Morte instantânea ao tocar nas bordas
            if (Math.hypot(s.x - CONFIG.mundo.tamanhoRaio, s.y - CONFIG.mundo.tamanhoRaio) > CONFIG.mundo.tamanhoRaio) {
                s.alive = false;
                continue;
            }

            // Move os gomos traseiros em fila india (Sincronizado Mestre)
            let pX = s.x, pY = s.y, spc = s.radius * s.conf.distanciaGomos;
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
