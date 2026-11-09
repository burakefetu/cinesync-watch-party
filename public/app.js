const socket = io();

// Uygulama Durumu (State)
let currentRoomId = '';
let currentUser = {
  username: '',
  color: '#8b5cf6'
};
let activeMode = 'youtube'; // 'youtube' | 'video' | 'screen'
let isApplyingRemoteSync = false;
let syncGuardTimeout = null;

// YouTube Player Degiskenleri
let ytPlayer = null;
let ytReady = false;
let pendingYtState = null;
let lastYtTime = 0;
let ytSeekCheckInterval = null;

// HTML5 Video & HLS Degiskenleri
let hlsInstance = null;
const html5Video = document.getElementById('html5-video');

// WebRTC Ekran Paylasimi Degiskenleri
let localScreenStream = null;
let isSharingScreen = false;
const peerConnections = new Map(); // peerId -> RTCPeerConnection
const pendingCandidates = new Map(); // peerId -> RTCIceCandidateInit[]
const screenVideo = document.getElementById('screen-video');

const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' }
  ]
};

// DOM Elemanlari
const joinModal = document.getElementById('join-modal');
const joinForm = document.getElementById('join-form');
const usernameInput = document.getElementById('username-input');
const roomInput = document.getElementById('room-input');
const randomRoomBtn = document.getElementById('random-room-btn');
const colorPicker = document.getElementById('color-picker');
const displayRoomCode = document.getElementById('display-room-code');
const copyInviteBtn = document.getElementById('copy-invite-btn');
const theaterModeBtn = document.getElementById('theater-mode-btn');
const chatSidebar = document.getElementById('chat-sidebar');

const modeTabs = document.querySelectorAll('.mode-tab');
const toolbarYoutube = document.getElementById('toolbar-youtube');
const toolbarVideo = document.getElementById('toolbar-video');
const toolbarScreen = document.getElementById('toolbar-screen');

const viewYoutube = document.getElementById('view-youtube');
const viewVideo = document.getElementById('view-video');
const viewScreen = document.getElementById('view-screen');

const youtubePlaceholder = document.getElementById('youtube-placeholder');
const ytPlayerContainer = document.getElementById('yt-player-container');
const videoPlaceholder = document.getElementById('video-placeholder');
const screenPlaceholder = document.getElementById('screen-placeholder');

const syncStatusText = document.getElementById('sync-status-text');
const userListEl = document.getElementById('user-list');
const userCountEl = document.getElementById('user-count');
const chatMessagesEl = document.getElementById('chat-messages');
const chatForm = document.getElementById('chat-form');
const chatInput = document.getElementById('chat-input');
const emojiOverlay = document.getElementById('emoji-overlay');

// ==========================================
// 1. BAŞLANGIÇ & ODAYA GİRİŞ
// ==========================================

function generateRoomCode() {
  const num = Math.floor(100 + Math.random() * 900);
  return `SINEMA-${num}`;
}

function initJoinModal() {
  const params = new URLSearchParams(window.location.search);
  const roomFromUrl = params.get('room');
  roomInput.value = roomFromUrl ? roomFromUrl.toUpperCase() : generateRoomCode();

  const savedName = localStorage.getItem('cinesync_username');
  if (savedName) {
    usernameInput.value = savedName;
  }

  randomRoomBtn.addEventListener('click', () => {
    roomInput.value = generateRoomCode();
  });

  colorPicker.querySelectorAll('.color-dot').forEach((btn) => {
    btn.addEventListener('click', () => {
      colorPicker.querySelectorAll('.color-dot').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      currentUser.color = btn.dataset.color;
    });
  });

  joinForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const uname = usernameInput.value.trim();
    const rcode = roomInput.value.trim().toUpperCase();
    if (!uname || !rcode) return;

    currentUser.username = uname;
    currentRoomId = rcode;
    localStorage.setItem('cinesync_username', uname);

    displayRoomCode.textContent = currentRoomId;
    const newUrl = `${window.location.pathname}?room=${encodeURIComponent(currentRoomId)}`;
    window.history.replaceState({}, '', newUrl);

    joinModal.classList.add('hidden');
    socket.emit('join-room', {
      roomId: currentRoomId,
      username: currentUser.username,
      color: currentUser.color
    });
  });
}

initJoinModal();

// Davet linkini kopyala
copyInviteBtn.addEventListener('click', () => {
  const inviteUrl = `${window.location.origin}/?room=${encodeURIComponent(currentRoomId)}`;
  navigator.clipboard.writeText(inviteUrl).then(() => {
    showToast('🔗 Davet linki kopyalandı! Arkadaşlarına gönderebilirsin.');
  });
});

// Sinema Modu (Sohbeti Gizle / Göster)
theaterModeBtn.addEventListener('click', () => {
  chatSidebar.classList.toggle('hidden');
});

// ==========================================
// 2. MOD GEÇİŞLERİ (YOUTUBE / FİLM / EKRAN)
// ==========================================

modeTabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    const targetMode = tab.dataset.mode;
    if (targetMode === activeMode) return;
    setUIMode(targetMode);
    socket.emit('switch-mode', { mode: targetMode });
  });
});

function setUIMode(mode) {
  activeMode = mode;

  // Sekme aktiflik durumu
  modeTabs.forEach((tab) => {
    tab.classList.toggle('active', tab.dataset.mode === mode);
  });

  // Araç çubuklarını göster/gizle
  toolbarYoutube.classList.toggle('hidden', mode !== 'youtube');
  toolbarVideo.classList.toggle('hidden', mode !== 'video');
  toolbarScreen.classList.toggle('hidden', mode !== 'screen');

  // Sahne görünümlerini göster/gizle
  viewYoutube.classList.toggle('hidden', mode !== 'youtube');
  viewVideo.classList.toggle('hidden', mode !== 'video');
  viewScreen.classList.toggle('hidden', mode !== 'screen');

  // Diğer oynatıcıları duraklat (sesler karışmasın)
  if (mode !== 'youtube' && ytPlayer && ytReady && typeof ytPlayer.pauseVideo === 'function') {
    withSyncGuard(() => ytPlayer.pauseVideo());
  }
  if (mode !== 'video' && !html5Video.paused) {
    withSyncGuard(() => html5Video.pause());
  }
}

function withSyncGuard(fn, durationMs = 650) {
  isApplyingRemoteSync = true;
  clearTimeout(syncGuardTimeout);
  try {
    fn();
  } finally {
    syncGuardTimeout = setTimeout(() => {
      isApplyingRemoteSync = false;
    }, durationMs);
  }
}

// ==========================================
// 3. ÖZELLİK 1: YOUTUBE SENKRONİZASYONU
// ==========================================

function extractYouTubeId(input) {
  if (!input) return null;
  const trimmed = input.trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) {
    return trimmed;
  }
  const regex = /(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?|shorts)\/|.*[?&]v=)|youtu\.be\/)([a-zA-Z0-9_-]{11})/;
  const match = trimmed.match(regex);
  return match ? match[1] : null;
}

// YouTube IFrame API hazır olduğunda çağrılır
window.onYouTubeIframeAPIReady = function () {
  ytPlayer = new YT.Player('youtube-player', {
    width: '100%',
    height: '100%',
    playerVars: {
      autoplay: 0,
      controls: 1,
      rel: 0,
      modestbranding: 1,
      playsinline: 1
    },
    events: {
      onReady: () => {
        ytReady = true;
        if (pendingYtState) {
          applyYouTubeMediaState(pendingYtState);
          pendingYtState = null;
        }
        startYouTubeSeekWatcher();
      },
      onStateChange: onYouTubeStateChange
    }
  });
};

function onYouTubeStateChange(event) {
  if (isApplyingRemoteSync || activeMode !== 'youtube') return;

  const currentTime = ytPlayer.getCurrentTime ? ytPlayer.getCurrentTime() : 0;

  if (event.data === YT.PlayerState.PLAYING) {
    const timeDiff = Math.abs(currentTime - lastYtTime);
    if (timeDiff > 2.2) {
      socket.emit('player-action', { action: 'seek', currentTime });
    }
    socket.emit('player-action', { action: 'play', currentTime });
    updateSyncBanner(`▶️ Sen videoyu başlattın (${formatTime(currentTime)})`);
  } else if (event.data === YT.PlayerState.PAUSED) {
    socket.emit('player-action', { action: 'pause', currentTime });
    updateSyncBanner(`⏸️ Sen videoyu duraklattın (${formatTime(currentTime)})`);
  }

  lastYtTime = currentTime;
}

function startYouTubeSeekWatcher() {
  if (ytSeekCheckInterval) clearInterval(ytSeekCheckInterval);
  ytSeekCheckInterval = setInterval(() => {
    if (!ytReady || !ytPlayer || activeMode !== 'youtube' || isApplyingRemoteSync) return;
    if (typeof ytPlayer.getCurrentTime !== 'function') return;
    const state = ytPlayer.getPlayerState();
    const nowTime = ytPlayer.getCurrentTime();
    if (state === YT.PlayerState.PLAYING) {
      const diff = Math.abs(nowTime - lastYtTime);
      // Normalde 1 saniyede ~1 sn ilerler; 2.8 saniyeden fazla fark varsa kullanıcı ileri/geri sarmıştır
      if (diff > 2.8) {
        socket.emit('player-action', { action: 'seek', currentTime: nowTime });
      }
    }
    lastYtTime = nowTime;
  }, 1000);
}

function loadYouTubeVideo(videoId, startSeconds = 0, autoPlay = true) {
  youtubePlaceholder.classList.add('hidden');
  ytPlayerContainer.classList.remove('hidden');

  if (!ytReady || !ytPlayer || typeof ytPlayer.loadVideoById !== 'function') {
    pendingYtState = { youtubeId: videoId, currentTime: startSeconds, isPlaying: autoPlay };
    return;
  }

  withSyncGuard(() => {
    if (autoPlay) {
      ytPlayer.loadVideoById({ videoId, startSeconds });
    } else {
      ytPlayer.cueVideoById({ videoId, startSeconds });
    }
    lastYtTime = startSeconds;
  }, 1000);
}

function applyYouTubeMediaState(mediaState) {
  if (!mediaState || !mediaState.youtubeId) return;
  loadYouTubeVideo(mediaState.youtubeId, mediaState.currentTime || 0, mediaState.isPlaying);
}

// YouTube Form & Hızlı Örnekler
document.getElementById('youtube-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = document.getElementById('youtube-url-input');
  const videoId = extractYouTubeId(input.value);
  if (!videoId) {
    showToast('⚠️ Geçerli bir YouTube linki girin.');
    return;
  }
  loadYouTubeVideo(videoId, 0, true);
  socket.emit('set-media', { mode: 'youtube', youtubeId: videoId });
  input.value = '';
});

document.querySelectorAll('.chip-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const videoId = btn.dataset.yt;
    loadYouTubeVideo(videoId, 0, true);
    socket.emit('set-media', { mode: 'youtube', youtubeId: videoId });
  });
});

document.getElementById('yt-sync-btn').addEventListener('click', () => {
  socket.emit('request-sync');
  showToast('🔄 Oda ile senkronize ediliyor...');
});

// ==========================================
// 4. ÖZELLİK 2: FİLM LİNKİ (.MP4/.M3U8) & LOKAL DOSYA
// ==========================================

function loadHtml5VideoSource(url, startTime = 0, autoPlay = false) {
  videoPlaceholder.classList.add('hidden');
  html5Video.classList.remove('hidden');

  if (hlsInstance) {
    hlsInstance.destroy();
    hlsInstance = null;
  }

  withSyncGuard(() => {
    if (url.includes('.m3u8') && window.Hls && Hls.isSupported()) {
      hlsInstance = new Hls();
      hlsInstance.loadSource(url);
      hlsInstance.attachMedia(html5Video);
      hlsInstance.on(Hls.Events.MANIFEST_PARSED, () => {
        html5Video.currentTime = startTime || 0;
        if (autoPlay) html5Video.play().catch(() => {});
      });
    } else {
      html5Video.src = url;
      html5Video.currentTime = startTime || 0;
      if (autoPlay) html5Video.play().catch(() => {});
    }
  }, 800);
}

// Doğrudan Film/Video Linki Formu
document.getElementById('video-url-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = document.getElementById('video-url-input');
  const url = input.value.trim();
  if (!url) return;

  loadHtml5VideoSource(url, 0, false);
  socket.emit('set-media', {
    mode: 'video',
    videoSubMode: 'url',
    videoUrl: url
  });
  input.value = '';
});

// Örnek Film Butonları
document.querySelectorAll('.chip-video-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const url = btn.dataset.url;
    loadHtml5VideoSource(url, 0, false);
    socket.emit('set-media', {
      mode: 'video',
      videoSubMode: 'url',
      videoUrl: url
    });
  });
});

// Bilgisayardan Lokal Film Dosyası Seçme
document.getElementById('local-video-input').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const fileUrl = URL.createObjectURL(file);
  loadHtml5VideoSource(fileUrl, 0, false);

  socket.emit('set-media', {
    mode: 'video',
    videoSubMode: 'local',
    localFileName: file.name,
    fileSize: file.size
  });

  showToast(`📁 "${file.name}" yüklendi. Arkadaşların da aynı dosyayı seçtiğinde başlatabilirsin!`);
});

// Altyazı (.srt veya .vtt) Yükleme & Otomatik SRT->VTT Dönüştürücü
document.getElementById('subtitle-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const text = await file.text();
  let vttText = text;

  if (file.name.toLowerCase().endsWith('.srt')) {
    vttText = 'WEBVTT\n\n' + text.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
  }

  const blob = new Blob([vttText], { type: 'text/vtt' });
  const trackUrl = URL.createObjectURL(blob);

  // Eski altyazıları temizle
  html5Video.querySelectorAll('track').forEach((t) => t.remove());

  const track = document.createElement('track');
  track.kind = 'subtitles';
  track.label = file.name;
  track.srclang = 'tr';
  track.src = trackUrl;
  track.default = true;
  html5Video.appendChild(track);

  if (html5Video.textTracks && html5Video.textTracks[0]) {
    html5Video.textTracks[0].mode = 'showing';
  }

  showToast(`💬 Altyazı eklendi: ${file.name}`);
});

document.getElementById('video-sync-btn').addEventListener('click', () => {
  socket.emit('request-sync');
  showToast('🔄 Oda ile senkronize ediliyor...');
});

// HTML5 Video Oynatıcı Olayları (Play / Pause / Seek)
html5Video.addEventListener('play', () => {
  if (isApplyingRemoteSync || activeMode !== 'video') return;
  socket.emit('player-action', {
    action: 'play',
    currentTime: html5Video.currentTime
  });
  updateSyncBanner(`▶️ Sen filmi başlattın (${formatTime(html5Video.currentTime)})`);
});

html5Video.addEventListener('pause', () => {
  if (isApplyingRemoteSync || activeMode !== 'video') return;
  socket.emit('player-action', {
    action: 'pause',
    currentTime: html5Video.currentTime
  });
  updateSyncBanner(`⏸️ Sen filmi duraklattın (${formatTime(html5Video.currentTime)})`);
});

html5Video.addEventListener('seeked', () => {
  if (isApplyingRemoteSync || activeMode !== 'video') return;
  socket.emit('player-action', {
    action: 'seek',
    currentTime: html5Video.currentTime
  });
});

// ==========================================
// 5. UZAKTAN GELEN SENKRONİZASYON OLAYLARI
// ==========================================

socket.on('player-sync', ({ action, currentTime, isPlaying, actor }) => {
  if (activeMode === 'youtube' && ytReady && ytPlayer && typeof ytPlayer.seekTo === 'function') {
    withSyncGuard(() => {
      const localTime = ytPlayer.getCurrentTime ? ytPlayer.getCurrentTime() : 0;
      if (action === 'seek' || action === 'force-sync' || Math.abs(localTime - currentTime) > 1.5) {
        ytPlayer.seekTo(currentTime, true);
        lastYtTime = currentTime;
      }
      if (isPlaying) {
        ytPlayer.playVideo();
      } else {
        ytPlayer.pauseVideo();
      }
    }, 850);
  } else if (activeMode === 'video' && !html5Video.classList.contains('hidden')) {
    withSyncGuard(() => {
      if (action === 'seek' || action === 'force-sync' || Math.abs(html5Video.currentTime - currentTime) > 1.5) {
        html5Video.currentTime = currentTime;
      }
      if (isPlaying) {
        html5Video.play().catch(() => {
          showToast('🔇 Tarayıcı otomatik oynatmayı engelledi, videoya bir kez tıklayın.');
        });
      } else {
        html5Video.pause();
      }
    }, 750);
  }

  const actionLabels = {
    play: `▶️ ${actor} videoyu başlattı (${formatTime(currentTime)})`,
    pause: `⏸️ ${actor} videoyu duraklattı (${formatTime(currentTime)})`,
    seek: `⏩ ${actor} videoyu ${formatTime(currentTime)} konumuna sardı`,
    'force-sync': `🔄 Oda ile ${formatTime(currentTime)} saniyesine hizalandı`
  };
  if (actionLabels[action]) {
    updateSyncBanner(actionLabels[action]);
  }
});

// ==========================================
// 6. ÖZELLİK 3: WEBRTC EKRAN PAYLAŞIMI
// ==========================================

const startScreenBtn = document.getElementById('start-screen-btn');
const stopScreenBtn = document.getElementById('stop-screen-btn');
const screenStatusBadge = document.getElementById('screen-status-badge');
const screenStatusText = document.getElementById('screen-status-text');

startScreenBtn.addEventListener('click', async () => {
  try {
    localScreenStream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        cursor: 'always',
        frameRate: { ideal: 30, max: 60 }
      },
      audio: true
    });

    isSharingScreen = true;
    screenPlaceholder.classList.add('hidden');
    screenVideo.classList.remove('hidden');
    screenVideo.srcObject = localScreenStream;
    screenVideo.muted = true; // Kendi ekran sesimizin yankı yapmaması için

    startScreenBtn.classList.add('hidden');
    stopScreenBtn.classList.remove('hidden');
    screenStatusBadge.textContent = 'CANLI YAYINDA';
    screenStatusBadge.classList.add('sharing');
    screenStatusText.textContent = 'Ekranınızı şu anda odadaki arkadaşlarınızla paylaşıyorsunuz.';

    // Tarayıcının kendi "Paylaşımı Durdur" butonuna basılırsa
    localScreenStream.getVideoTracks()[0].addEventListener('ended', () => {
      stopScreenSharing();
    });

    socket.emit('start-screen-share');
  } catch (err) {
    showToast('⚠️ Ekran paylaşımı iptal edildi veya izin verilmedi.');
  }
});

stopScreenBtn.addEventListener('click', () => {
  stopScreenSharing();
});

function stopScreenSharing() {
  if (!isSharingScreen) return;
  isSharingScreen = false;

  if (localScreenStream) {
    localScreenStream.getTracks().forEach((track) => track.stop());
    localScreenStream = null;
  }

  peerConnections.forEach((pc) => pc.close());
  peerConnections.clear();

  screenVideo.srcObject = null;
  screenVideo.classList.add('hidden');
  screenPlaceholder.classList.remove('hidden');

  startScreenBtn.classList.remove('hidden');
  stopScreenBtn.classList.add('hidden');
  screenStatusBadge.textContent = 'HAZIR';
  screenStatusBadge.classList.remove('sharing');
  screenStatusText.textContent =
    'Tarayıcı sekmesini (Netflix, BluTV, Web vb.) veya tüm ekranınızı ses dahil arkadaşlarınızla paylaşın.';

  socket.emit('stop-screen-share');
}

async function createOfferForViewer(viewerId) {
  if (!localScreenStream) return;

  if (peerConnections.has(viewerId)) {
    peerConnections.get(viewerId).close();
  }

  const pc = new RTCPeerConnection(rtcConfig);
  peerConnections.set(viewerId, pc);

  localScreenStream.getTracks().forEach((track) => {
    pc.addTrack(track, localScreenStream);
  });

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('webrtc-ice-candidate', {
        targetId: viewerId,
        candidate: event.candidate
      });
    }
  };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  socket.emit('webrtc-offer', {
    targetId: viewerId,
    sdp: pc.localDescription
  });
}

socket.on('screen-share-peers', ({ peerIds }) => {
  peerIds.forEach((peerId) => {
    createOfferForViewer(peerId);
  });
});

socket.on('viewer-joined-screen', ({ viewerId }) => {
  if (isSharingScreen) {
    createOfferForViewer(viewerId);
  }
});

socket.on('screen-share-started', ({ sharerId, sharerName }) => {
  setUIMode('screen');
  if (sharerId !== socket.id) {
    screenStatusBadge.textContent = 'CANLI İZLENİYOR';
    screenStatusBadge.classList.add('sharing');
    screenStatusText.textContent = `🖥️ ${sharerName} şu anda ekranını paylaşıyor.`;
    startScreenBtn.classList.add('hidden');
  }
});

socket.on('screen-share-stopped', () => {
  peerConnections.forEach((pc) => pc.close());
  peerConnections.clear();

  screenVideo.srcObject = null;
  screenVideo.classList.add('hidden');
  screenPlaceholder.classList.remove('hidden');

  startScreenBtn.classList.remove('hidden');
  stopScreenBtn.classList.add('hidden');
  screenStatusBadge.textContent = 'HAZIR';
  screenStatusBadge.classList.remove('sharing');
  screenStatusText.textContent = 'Ekran paylaşımı sona erdi.';
});

socket.on('webrtc-offer', async ({ senderId, senderName, sdp }) => {
  if (peerConnections.has(senderId)) {
    peerConnections.get(senderId).close();
  }

  const pc = new RTCPeerConnection(rtcConfig);
  peerConnections.set(senderId, pc);

  pc.ontrack = (event) => {
    screenPlaceholder.classList.add('hidden');
    screenVideo.classList.remove('hidden');
    screenVideo.muted = false;
    if (screenVideo.srcObject !== event.streams[0]) {
      screenVideo.srcObject = event.streams[0];
      screenVideo.play().catch(() => {
        showToast('🔊 Yayını duymak ve izlemek için ekrandaki oynatıcıya tıklayın.');
      });
    }
  };

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('webrtc-ice-candidate', {
        targetId: senderId,
        candidate: event.candidate
      });
    }
  };

  await pc.setRemoteDescription(new RTCSessionDescription(sdp));

  // Bekleyen ICE adayları varsa ekle
  if (pendingCandidates.has(senderId)) {
    for (const cand of pendingCandidates.get(senderId)) {
      await pc.addIceCandidate(new RTCIceCandidate(cand));
    }
    pendingCandidates.delete(senderId);
  }

  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);

  socket.emit('webrtc-answer', {
    targetId: senderId,
    sdp: pc.localDescription
  });

  updateSyncBanner(`🖥️ ${senderName} ekran paylaşımına bağlandı`);
});

socket.on('webrtc-answer', async ({ senderId, sdp }) => {
  const pc = peerConnections.get(senderId);
  if (!pc) return;
  await pc.setRemoteDescription(new RTCSessionDescription(sdp));

  if (pendingCandidates.has(senderId)) {
    for (const cand of pendingCandidates.get(senderId)) {
      await pc.addIceCandidate(new RTCIceCandidate(cand));
    }
    pendingCandidates.delete(senderId);
  }
});

socket.on('webrtc-ice-candidate', async ({ senderId, candidate }) => {
  const pc = peerConnections.get(senderId);
  if (pc && pc.remoteDescription && pc.remoteDescription.type) {
    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (e) {}
  } else {
    if (!pendingCandidates.has(senderId)) {
      pendingCandidates.set(senderId, []);
    }
    pendingCandidates.get(senderId).push(candidate);
  }
});

// ==========================================
// 7. ODA DURUMU, SOHBET (CHAT) VE EMOJİLER
// ==========================================

socket.on('room-state', (state) => {
  setUIMode(state.mode || 'youtube');
  renderUserList(state.users || []);

  if (state.mediaState) {
    if (state.mode === 'youtube' && state.mediaState.youtubeId) {
      applyYouTubeMediaState(state.mediaState);
    } else if (state.mode === 'video' && state.mediaState.videoSubMode === 'url' && state.mediaState.videoUrl) {
      loadHtml5VideoSource(
        state.mediaState.videoUrl,
        state.mediaState.currentTime || 0,
        state.mediaState.isPlaying
      );
    }
  }

  if (state.screenSharerId && state.screenSharerId !== socket.id) {
    setUIMode('screen');
    screenStatusBadge.textContent = 'CANLI İZLENİYOR';
    screenStatusBadge.classList.add('sharing');
    screenStatusText.textContent = `🖥️ ${state.screenSharerName || 'Bir kullanıcı'} ekranını paylaşıyor...`;
    startScreenBtn.classList.add('hidden');
  }
});

socket.on('mode-changed', ({ mode, actor }) => {
  setUIMode(mode);
  updateSyncBanner(`🎬 ${actor} izleme modunu değiştirdi`);
});

socket.on('media-changed', ({ mode, mediaState, actor }) => {
  setUIMode(mode);
  if (mode === 'youtube' && mediaState.youtubeId) {
    applyYouTubeMediaState(mediaState);
  } else if (mode === 'video' && mediaState.videoSubMode === 'url' && mediaState.videoUrl) {
    loadHtml5VideoSource(mediaState.videoUrl, 0, false);
  }
  updateSyncBanner(`🎬 ${actor} yeni bir medya açtı`);
});

socket.on('local-file-selected', ({ actor, fileName }) => {
  setUIMode('video');
  updateSyncBanner(`📁 ${actor}: "${fileName}" dosyasını seçti`);
});

socket.on('user-list', (users) => {
  renderUserList(users);
});

function renderUserList(users) {
  userCountEl.textContent = users.length;
  userListEl.innerHTML = '';
  users.forEach((u) => {
    const chip = document.createElement('div');
    chip.className = 'user-chip';
    const dot = document.createElement('span');
    dot.className = 'user-dot';
    dot.style.backgroundColor = u.color || '#8b5cf6';

    const nameSpan = document.createElement('span');
    nameSpan.textContent = u.id === socket.id ? `${u.username} (Sen)` : u.username;

    chip.appendChild(dot);
    chip.appendChild(nameSpan);
    userListEl.appendChild(chip);
  });
}

// Canlı Sohbet
chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;
  socket.emit('chat-message', { text });
  chatInput.value = '';
});

socket.on('chat-message', (msg) => {
  const div = document.createElement('div');
  if (msg.type === 'system') {
    div.className = 'chat-msg system';
    div.textContent = msg.text;
  } else {
    div.className = 'chat-msg';
    const header = document.createElement('div');
    header.className = 'chat-msg-header';

    const sender = document.createElement('span');
    sender.className = 'chat-sender';
    sender.style.color = msg.color || '#8b5cf6';
    sender.textContent = msg.sender;

    const time = document.createElement('span');
    time.className = 'chat-time';
    time.textContent = msg.time;

    header.appendChild(sender);
    header.appendChild(time);

    const body = document.createElement('div');
    body.textContent = msg.text;

    div.appendChild(header);
    div.appendChild(body);
  }

  chatMessagesEl.appendChild(div);
  chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
});

// Uçuşan Emoji Tepkileri
document.querySelectorAll('.emoji-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const emoji = btn.dataset.emoji;
    socket.emit('emoji-reaction', { emoji });
  });
});

socket.on('emoji-reaction', ({ emoji, sender, color }) => {
  const el = document.createElement('div');
  el.className = 'floating-emoji';
  const randomLeft = 12 + Math.floor(Math.random() * 76);
  el.style.left = `${randomLeft}%`;

  const charSpan = document.createElement('span');
  charSpan.className = 'emoji-char';
  charSpan.textContent = emoji;

  const authorSpan = document.createElement('span');
  authorSpan.className = 'emoji-author';
  authorSpan.style.color = color || '#fff';
  authorSpan.textContent = sender;

  el.appendChild(charSpan);
  el.appendChild(authorSpan);
  emojiOverlay.appendChild(el);

  setTimeout(() => {
    el.remove();
  }, 3200);
});

// Yardımcı Fonksiyonlar
function updateSyncBanner(text) {
  syncStatusText.textContent = text;
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

function showToast(message) {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.remove();
  }, 3500);
}
