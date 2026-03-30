const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*' }
});

// Serve frontend static files
app.use(express.static(__dirname));

const Arena = require('./server/Arena.js'); // The Authoritative Physics Engine

// Matchmaking System: Arena instances
const arenas = {}; // Map of arenaId -> Arena Instance
const MAX_PLAYERS_PER_ARENA = 150; // Bots + Humans

// Gateway Load Balancer simulation
function getAvailableArena(io) {
    for (const id in arenas) {
        if (Object.keys(arenas[id].players).length < MAX_PLAYERS_PER_ARENA) {
            return id;
        }
    }
    // Spin up a new Arena instance
    const newId = 'arena_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
    arenas[newId] = new Arena(newId, io); // Boot up the Physics Server!
    console.log(`[Agones/Fleet Simulator] Spun up new Arena instance: ${newId}`);
    return newId;
}

io.on('connection', (socket) => {
    console.log('User connected to Gateway:', socket.id);

    // Initial Matchmaking request
    socket.on('join', (data) => {
        const arenaId = getAvailableArena(io); // Pass IO to Arena
        socket.join(arenaId); // Assign to Socket.io Room (Channel/Shard)
        
        const arena = arenas[arenaId];
        arena.addPlayer(socket.id, data.name || 'Lenda', data.skinId || 0);
        
        // Notify player of their assigned dedicated Server/Room
        socket.emit('match_found', { 
            arenaId: arenaId, 
            playerState: arena.players[socket.id],
            population: Object.keys(arena.players).length
        });
        
        console.log(`[Matchmaker] Sent player ${data.name} to ${arenaId}`);
    });

    socket.on('input', (data) => {
        // Find which arena the player is in
        for (const roomId of socket.rooms) {
            if (arenas[roomId] && arenas[roomId].players[socket.id]) {
                arenas[roomId].handleInput(socket.id, data);
                break;
            }
        }
    });

    socket.on('disconnect', () => {
        console.log('User disconnected from Gateway:', socket.id);
        for (const id in arenas) {
            if (arenas[id].players[socket.id]) {
                arenas[id].removePlayer(socket.id);
                console.log(`[Matchmaker] Removed player from ${id}`);
                // Clean up empty arenas
                if (Object.keys(arenas[id].players).length === 0) {
                    clearInterval(arenas[id].loop);
                    console.log(`[Agones/Fleet Simulator] Shutting down empty Arena instance: ${id}`);
                    delete arenas[id];
                }
                break;
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`[MMO] Server running on port ${PORT}`);
});
