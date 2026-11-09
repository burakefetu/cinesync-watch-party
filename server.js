const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*'
  }
});

app.use(express.static(path.join(__dirname, 'public')));

// Room state store
const rooms = new Map();

function createDefaultRoomState(roomId) {
  return {
    roomId,
    users: new Map(), // socket.id -> { id, username, color, joinedAt }
    mode: 'youtube', // 'youtube' | 'video' | 'screen'
    mediaState: {
      youtubeId: '',
      videoUrl: '',
      localFileName: '',
      videoSubMode: 'url', // 'url' | 'local'
      isPlaying: false,
      currentTime: 0,
      playbackRate: 1,
      lastUpdated: Date.now()
    },
    screenSharerId: null,
    screenSharerName: null
  };
}

function getEffectiveCurrentTime(mediaState) {
  if (!mediaState.isPlaying) {
    return mediaState.currentTime;
  }
  const elapsedSeconds = ((Date.now() - mediaState.lastUpdated) / 1000) * (mediaState.playbackRate || 1);
  return mediaState.currentTime + Math.max(0, elapsedSeconds);
}

function serializeRoomState(room) {
  return {
    roomId: room.roomId,
    mode: room.mode,
    users: Array.from(room.users.values()),
    mediaState: {
      ...room.mediaState,
      currentTime: getEffectiveCurrentTime(room.mediaState)
    },
    screenSharerId: room.screenSharerId,
    screenSharerName: room.screenSharerName
  };
}

function formatTime(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  const hrs = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

function sendSystemMessage(roomId, text) {
  io.to(roomId).emit('chat-message', {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    type: 'system',
    text,
    time: new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })
  });
}

io.on('connection', (socket) => {
  let currentRoomId = null;

  socket.on('join-room', ({ roomId, username, color }) => {
    const cleanRoomId = (roomId || 'SINEMA-1').trim().toUpperCase();
    const cleanName = (username || 'Misafir').trim().slice(0, 24);
    const userColor = color || '#8b5cf6';

    if (currentRoomId) {
      socket.leave(currentRoomId);
    }

    currentRoomId = cleanRoomId;
    socket.join(cleanRoomId);

    if (!rooms.has(cleanRoomId)) {
      rooms.set(cleanRoomId, createDefaultRoomState(cleanRoomId));
    }

    const room = rooms.get(cleanRoomId);
    const userObj = {
      id: socket.id,
      username: cleanName,
      color: userColor,
      joinedAt: Date.now()
    };
    room.users.set(socket.id, userObj);

    // Send full state to the joining user
    socket.emit('room-state', serializeRoomState(room));

    // Broadcast updated user list to everyone in the room
    io.to(cleanRoomId).emit('user-list', Array.from(room.users.values()));

    sendSystemMessage(cleanRoomId, `👋 ${cleanName} odaya katıldı.`);

    // If someone is actively sharing their screen, ask the sharer to connect to this new viewer
    if (room.screenSharerId && room.screenSharerId !== socket.id) {
      io.to(room.screenSharerId).emit('viewer-joined-screen', {
        viewerId: socket.id,
        viewerName: cleanName
      });
    }
  });

  // Switch between 'youtube', 'video', 'screen'
  socket.on('switch-mode', ({ mode }) => {
    if (!currentRoomId || !rooms.has(currentRoomId)) return;
    const room = rooms.get(currentRoomId);
    const user = room.users.get(socket.id);
    if (!user) return;

    if (!['youtube', 'video', 'screen'].includes(mode)) return;

    // Pause existing playback when switching modes
    room.mediaState.currentTime = getEffectiveCurrentTime(room.mediaState);
    room.mediaState.isPlaying = false;
    room.mediaState.lastUpdated = Date.now();
    room.mode = mode;

    const modeNames = {
      youtube: 'YouTube Senkronizasyon',
      video: 'Film / Video Oynatıcı',
      screen: 'Canlı Ekran Paylaşımı'
    };

    io.to(currentRoomId).emit('mode-changed', {
      mode,
      actor: user.username,
      mediaState: room.mediaState
    });

    sendSystemMessage(currentRoomId, `🎬 ${user.username}, izleme modunu "${modeNames[mode]}" olarak değiştirdi.`);
  });

  // Set YouTube video ID, direct video URL, or local file name
  socket.on('set-media', (payload) => {
    if (!currentRoomId || !rooms.has(currentRoomId)) return;
    const room = rooms.get(currentRoomId);
    const user = room.users.get(socket.id);
    if (!user) return;

    if (payload.mode === 'youtube' && payload.youtubeId) {
      room.mode = 'youtube';
      room.mediaState.youtubeId = payload.youtubeId;
      room.mediaState.currentTime = 0;
      room.mediaState.isPlaying = true;
      room.mediaState.lastUpdated = Date.now();

      io.to(currentRoomId).emit('media-changed', {
        mode: 'youtube',
        mediaState: room.mediaState,
        actor: user.username
      });
      sendSystemMessage(currentRoomId, `▶️ ${user.username} yeni bir YouTube videosu açtı.`);
    } else if (payload.mode === 'video') {
      room.mode = 'video';
      if (payload.videoSubMode === 'url' && payload.videoUrl) {
        room.mediaState.videoSubMode = 'url';
        room.mediaState.videoUrl = payload.videoUrl;
        room.mediaState.currentTime = 0;
        room.mediaState.isPlaying = false;
        room.mediaState.lastUpdated = Date.now();

        io.to(currentRoomId).emit('media-changed', {
          mode: 'video',
          mediaState: room.mediaState,
          actor: user.username
        });
        sendSystemMessage(currentRoomId, `🎞️ ${user.username} doğrudan film/video linki yükledi.`);
      } else if (payload.videoSubMode === 'local' && payload.localFileName) {
        room.mediaState.videoSubMode = 'local';
        room.mediaState.localFileName = payload.localFileName;
        room.mediaState.isPlaying = false;
        room.mediaState.lastUpdated = Date.now();

        io.to(currentRoomId).emit('local-file-selected', {
          actor: user.username,
          fileName: payload.localFileName,
          fileSize: payload.fileSize
        });
        sendSystemMessage(
          currentRoomId,
          `📁 ${user.username} bilgisayarından "${payload.localFileName}" dosyasını seçti.`
        );
      }
    }
  });

  // Synchronized Play / Pause / Seek / RateChange
  socket.on('player-action', ({ action, currentTime, playbackRate }) => {
    if (!currentRoomId || !rooms.has(currentRoomId)) return;
    const room = rooms.get(currentRoomId);
    const user = room.users.get(socket.id);
    if (!user) return;

    const numericTime = typeof currentTime === 'number' && !isNaN(currentTime) ? Math.max(0, currentTime) : 0;

    if (action === 'play') {
      room.mediaState.isPlaying = true;
      room.mediaState.currentTime = numericTime;
      room.mediaState.lastUpdated = Date.now();
    } else if (action === 'pause') {
      room.mediaState.isPlaying = false;
      room.mediaState.currentTime = numericTime;
      room.mediaState.lastUpdated = Date.now();
    } else if (action === 'seek') {
      room.mediaState.currentTime = numericTime;
      room.mediaState.lastUpdated = Date.now();
    } else if (action === 'rate' && playbackRate) {
      room.mediaState.currentTime = getEffectiveCurrentTime(room.mediaState);
      room.mediaState.playbackRate = playbackRate;
      room.mediaState.lastUpdated = Date.now();
    }

    // Broadcast to all OTHER users in the room
    socket.to(currentRoomId).emit('player-sync', {
      action,
      currentTime: room.mediaState.currentTime,
      isPlaying: room.mediaState.isPlaying,
      playbackRate: room.mediaState.playbackRate,
      actor: user.username,
      serverTimestamp: Date.now()
    });

    if (action === 'seek') {
      sendSystemMessage(currentRoomId, `⏩ ${user.username} videoyu ${formatTime(numericTime)} konumuna sardı.`);
    }
  });

  // Manual or periodic sync check
  socket.on('request-sync', () => {
    if (!currentRoomId || !rooms.has(currentRoomId)) return;
    const room = rooms.get(currentRoomId);
    socket.emit('player-sync', {
      action: 'force-sync',
      currentTime: getEffectiveCurrentTime(room.mediaState),
      isPlaying: room.mediaState.isPlaying,
      playbackRate: room.mediaState.playbackRate,
      actor: 'Sistem',
      serverTimestamp: Date.now()
    });
  });

  // WebRTC Screen Sharing Signaling
  socket.on('start-screen-share', () => {
    if (!currentRoomId || !rooms.has(currentRoomId)) return;
    const room = rooms.get(currentRoomId);
    const user = room.users.get(socket.id);
    if (!user) return;

    room.mode = 'screen';
    room.screenSharerId = socket.id;
    room.screenSharerName = user.username;

    const peerIds = Array.from(room.users.keys()).filter((id) => id !== socket.id);

    // Notify everyone in the room that screen sharing started
    io.to(currentRoomId).emit('screen-share-started', {
      sharerId: socket.id,
      sharerName: user.username
    });

    // Send list of current room peers to the sharer so they can initiate WebRTC offers
    socket.emit('screen-share-peers', { peerIds });

    sendSystemMessage(currentRoomId, `🖥️ ${user.username} ekranını paylaşmaya başladı.`);
  });

  socket.on('stop-screen-share', () => {
    if (!currentRoomId || !rooms.has(currentRoomId)) return;
    const room = rooms.get(currentRoomId);
    const user = room.users.get(socket.id);

    if (room.screenSharerId === socket.id) {
      room.screenSharerId = null;
      room.screenSharerName = null;
      io.to(currentRoomId).emit('screen-share-stopped', {
        sharerId: socket.id
      });
      if (user) {
        sendSystemMessage(currentRoomId, `🛑 ${user.username} ekran paylaşımını durdurdu.`);
      }
    }
  });

  socket.on('webrtc-offer', ({ targetId, sdp }) => {
    if (!currentRoomId || !rooms.has(currentRoomId)) return;
    const room = rooms.get(currentRoomId);
    const user = room.users.get(socket.id);
    io.to(targetId).emit('webrtc-offer', {
      senderId: socket.id,
      senderName: user ? user.username : 'Kullanıcı',
      sdp
    });
  });

  socket.on('webrtc-answer', ({ targetId, sdp }) => {
    io.to(targetId).emit('webrtc-answer', {
      senderId: socket.id,
      sdp
    });
  });

  socket.on('webrtc-ice-candidate', ({ targetId, candidate }) => {
    io.to(targetId).emit('webrtc-ice-candidate', {
      senderId: socket.id,
      candidate
    });
  });

  // Live Chat & Floating Emoji Reactions
  socket.on('chat-message', ({ text }) => {
    if (!currentRoomId || !rooms.has(currentRoomId)) return;
    const room = rooms.get(currentRoomId);
    const user = room.users.get(socket.id);
    if (!user || !text || !text.trim()) return;

    const cleanText = text.trim().slice(0, 600);
    io.to(currentRoomId).emit('chat-message', {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      type: 'user',
      senderId: socket.id,
      sender: user.username,
      color: user.color,
      text: cleanText,
      time: new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })
    });
  });

  socket.on('emoji-reaction', ({ emoji }) => {
    if (!currentRoomId || !rooms.has(currentRoomId)) return;
    const room = rooms.get(currentRoomId);
    const user = room.users.get(socket.id);
    if (!user || !emoji) return;

    io.to(currentRoomId).emit('emoji-reaction', {
      emoji,
      sender: user.username,
      color: user.color
    });
  });

  socket.on('disconnect', () => {
    if (!currentRoomId || !rooms.has(currentRoomId)) return;
    const room = rooms.get(currentRoomId);
    const user = room.users.get(socket.id);

    room.users.delete(socket.id);

    if (room.screenSharerId === socket.id) {
      room.screenSharerId = null;
      room.screenSharerName = null;
      io.to(currentRoomId).emit('screen-share-stopped', { sharerId: socket.id });
    }

    if (room.users.size === 0) {
      rooms.delete(currentRoomId);
    } else {
      io.to(currentRoomId).emit('user-list', Array.from(room.users.values()));
      if (user) {
        sendSystemMessage(currentRoomId, `👋 ${user.username} odadan ayrıldı.`);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🍿 Watch Party sunucusu çalışıyor: http://localhost:${PORT}`);
});
