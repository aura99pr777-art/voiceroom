/* ════════════════════════════════════════════════
   VoiceRoom — app.js
   WebRTC mesh + Socket.io signalling
   ════════════════════════════════════════════════ */

'use strict';

// ── Socket ────────────────────────────────────────
const socket = io();

// ── State ─────────────────────────────────────────
const peers          = {};   // socketId → RTCPeerConnection
const pendingIce     = {};   // socketId → [RTCIceCandidateInit]
const userNames      = {};   // socketId → string
let localStream      = null;
let screenStream     = null;
let isMuted          = false;
let isDeafened       = false;
let isCameraOff      = false;
let isScreenSharing  = false;

// ── URL params ────────────────────────────────────
const params = new URLSearchParams(window.location.search);
const myName = (params.get('name') || 'Anonymous').slice(0, 30);
const roomId = (params.get('room') || 'main').slice(0, 40);

// ── ICE / STUN + TURN config ──────────────────────
// TURN servers relay audio/video when peers are on different home networks
// (symmetric NAT). Without TURN, connections only work on simple NATs.
const ICE_CFG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302'  },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    // Free public TURN relay (Open Relay Project by Metered)
    {
      urls: [
        'turn:openrelay.metered.ca:80',
        'turn:openrelay.metered.ca:443',
        'turn:openrelay.metered.ca:443?transport=tcp',
      ],
      username:   'openrelayproject',
      credential: 'openrelayproject',
    },
  ],
};

// ── DOM shortcuts ─────────────────────────────────
const videoGrid        = document.getElementById('video-grid');
const roomNameEl       = document.getElementById('room-name');
const participantEl    = document.getElementById('participant-count');
const myNameEl         = document.getElementById('my-name-display');
const myAvatarEl       = document.getElementById('my-avatar');

// ══════════════════════════════════════════════════
//  INIT
// ══════════════════════════════════════════════════
async function init () {
  // Update header
  if (roomNameEl)   roomNameEl.textContent   = roomId;
  if (myNameEl)     myNameEl.textContent     = myName;
  if (myAvatarEl) {
    myAvatarEl.textContent    = myName[0].toUpperCase();
    myAvatarEl.style.background = avatarColor(myName);
  }

  // Get local media — try video+audio, fall back to audio-only
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  } catch {
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ video: false, audio: true });
      isCameraOff = true;
    } catch {
      localStream = new MediaStream();
      isCameraOff = true;
      showToast('⚠️ No camera or microphone detected');
    }
  }

  // Always ensure there is a video track so replaceTrack works later for screen share
  if (localStream.getVideoTracks().length === 0) {
    const blankTrack = blankVideoTrack();
    localStream.addTrack(blankTrack);
  }

  addLocalTile();
  updateControls();
  document.title = `VoiceRoom — #${roomId}`;
  socket.emit('join-room', { roomId, name: myName });
}

// ── Blank video track (2 px black canvas, 1 fps) ──
function blankVideoTrack () {
  const cvs = Object.assign(document.createElement('canvas'), { width: 2, height: 2 });
  cvs.getContext('2d').fillRect(0, 0, 2, 2);
  const track = cvs.captureStream(1).getVideoTracks()[0];
  track.enabled = false;
  return track;
}

// ── Avatar colour from string hash ────────────────
function avatarColor (str) {
  const palette = ['#5865f2','#eb459e','#ed4245','#57f287','#1abc9c','#e67e22','#9b59b6','#fee75c'];
  let h = 0;
  for (const c of str) h = (h * 31 + c.charCodeAt(0)) | 0;
  return palette[Math.abs(h) % palette.length];
}

// ══════════════════════════════════════════════════
//  VIDEO TILES
// ══════════════════════════════════════════════════
function addLocalTile () {
  const tile = buildTile('tile-local', myName, /*isLocal=*/true);
  videoGrid.appendChild(tile);
  tile.querySelector('video').srcObject = localStream;
  if (isCameraOff) tile.classList.add('cam-off');
  refreshGrid();
}

function buildTile (id, name, isLocal = false) {
  const tile = document.createElement('div');
  tile.className = 'video-tile';
  tile.id = id;

  // <video>
  const video = document.createElement('video');
  video.autoplay   = true;
  video.playsInline = true;
  if (isLocal) video.muted = true;

  // Avatar overlay
  const avatar = document.createElement('div');
  avatar.className = 'tile-avatar';
  avatar.style.background = avatarColor(name);
  avatar.textContent = name[0].toUpperCase();

  // Name tag row
  const nameTag  = document.createElement('div');
  nameTag.className = 'tile-name-tag';

  const micIcon = document.createElement('i');
  micIcon.className = 'fas fa-microphone-slash tile-mic-icon hidden';

  const nameSpan = document.createElement('span');
  nameSpan.textContent = name;

  nameTag.appendChild(micIcon);
  nameTag.appendChild(nameSpan);

  // Screen-share badge
  const badge = document.createElement('div');
  badge.className = 'tile-screen-badge hidden';
  badge.innerHTML = '<i class="fas fa-desktop"></i> Sharing';

  tile.appendChild(video);
  tile.appendChild(avatar);
  tile.appendChild(nameTag);
  tile.appendChild(badge);
  return tile;
}

function refreshGrid () {
  const n    = videoGrid.querySelectorAll('.video-tile').length;
  let cols   = 1;
  if      (n <= 1)  cols = 1;
  else if (n <= 2)  cols = 2;
  else if (n <= 4)  cols = 2;
  else if (n <= 9)  cols = 3;
  else              cols = 4;

  videoGrid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
}

// ══════════════════════════════════════════════════
//  SOCKET EVENTS
// ══════════════════════════════════════════════════

// Existing users when we first join
socket.on('existing-users', async (users) => {
  for (const u of users) {
    userNames[u.socketId] = u.name;
    await sendOffer(u.socketId);
  }
  updateParticipantCount();
});

// A new user joined after us — they will offer us
socket.on('user-joined', ({ socketId, name }) => {
  userNames[socketId] = name;
  updateParticipantCount();
});

// We receive an offer from a new joiner
socket.on('offer', async ({ from, offer, name }) => {
  userNames[from] = name;
  await sendAnswer(from, offer);
  updateParticipantCount();
});

// We receive an answer to our offer
socket.on('answer', async ({ from, answer }) => {
  const pc = peers[from];
  if (!pc) return;
  try {
    await pc.setRemoteDescription(new RTCSessionDescription(answer));
    await flushIce(from);
  } catch (e) {
    console.warn('setRemoteDescription (answer) failed:', e);
  }
});

// ICE candidate from peer
socket.on('ice-candidate', async ({ from, candidate }) => {
  const pc = peers[from];
  if (!pc) return;
  if (pc.remoteDescription?.type) {
    try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch {}
  } else {
    (pendingIce[from] = pendingIce[from] || []).push(candidate);
  }
});

// A peer disconnected
socket.on('user-left', (socketId) => {
  removePeer(socketId);
  updateParticipantCount();
});

// Remote user updated their state
socket.on('user-state', ({ socketId, isMuted: muted, isCameraOff: camOff, isScreenSharing: sharing }) => {
  const tile = document.getElementById(`tile-${socketId}`);
  if (!tile) return;
  if (muted    !== undefined) {
    tile.querySelector('.tile-mic-icon')?.classList.toggle('hidden', !muted);
    tile.classList.toggle('is-muted', muted);
  }
  if (camOff   !== undefined) tile.classList.toggle('cam-off', camOff);
  if (sharing  !== undefined) {
    tile.classList.toggle('screen-sharing', sharing);
    tile.querySelector('.tile-screen-badge')?.classList.toggle('hidden', !sharing);
  }
});

// ── Flush buffered ICE candidates after SRD ───────
async function flushIce (socketId) {
  const pending = pendingIce[socketId];
  if (!pending) return;
  const pc = peers[socketId];
  for (const c of pending) {
    try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch {}
  }
  delete pendingIce[socketId];
}

// ══════════════════════════════════════════════════
//  WebRTC PEER MANAGEMENT
// ══════════════════════════════════════════════════
async function createPC (socketId) {
  const pc = new RTCPeerConnection(ICE_CFG);
  peers[socketId] = pc;

  // Add all local tracks
  for (const track of localStream.getTracks()) {
    pc.addTrack(track, localStream);
  }

  // If already screen sharing, immediately substitute the video sender
  if (isScreenSharing && screenStream) {
    const st = screenStream.getVideoTracks()[0];
    const vs = pc.getSenders().find(s => s.track?.kind === 'video');
    if (vs && st) await vs.replaceTrack(st);
  }

  // ICE candidate trickle
  pc.onicecandidate = ({ candidate }) => {
    if (candidate) socket.emit('ice-candidate', { to: socketId, candidate });
  };

  // Remote track arrives → attach to tile
  pc.ontrack = ({ streams }) => {
    const stream = streams?.[0];
    if (!stream) return;

    let tile = document.getElementById(`tile-${socketId}`);
    if (!tile) {
      tile = buildTile(`tile-${socketId}`, userNames[socketId] || 'User', false);
      videoGrid.appendChild(tile);
      refreshGrid();
    }
    const video = tile.querySelector('video');
    if (video.srcObject !== stream) video.srcObject = stream;
    if (isDeafened) video.muted = true;
  };

  // Clean up on failure
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
      removePeer(socketId);
      updateParticipantCount();
    }
  };

  return pc;
}

async function sendOffer (socketId) {
  const pc = await createPC(socketId);
  const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
  await pc.setLocalDescription(offer);
  socket.emit('offer', { to: socketId, offer, name: myName });
}

async function sendAnswer (socketId, offer) {
  const pc = await createPC(socketId);
  await pc.setRemoteDescription(new RTCSessionDescription(offer));
  await flushIce(socketId);
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  socket.emit('answer', { to: socketId, answer });
}

function removePeer (socketId) {
  peers[socketId]?.close();
  delete peers[socketId];
  delete userNames[socketId];
  delete pendingIce[socketId];
  const tile = document.getElementById(`tile-${socketId}`);
  if (tile) {
    tile.style.animation = 'tileOut .3s ease forwards';
    setTimeout(() => { tile.remove(); refreshGrid(); }, 320);
  }
}

// ══════════════════════════════════════════════════
//  CONTROLS
// ══════════════════════════════════════════════════

// ── Mute / Unmute ─────────────────────────────────
function toggleMute () {
  isMuted = !isMuted;
  localStream.getAudioTracks().forEach(t => { t.enabled = !isMuted; });
  const localTile = document.getElementById('tile-local');
  localTile?.querySelector('.tile-mic-icon')?.classList.toggle('hidden', !isMuted);
  localTile?.classList.toggle('is-muted', isMuted);
  updateControls();
  socket.emit('user-state', { isMuted });
}

// ── Deafen / Undeafen ─────────────────────────────
function toggleDeafen () {
  isDeafened = !isDeafened;

  // Mute / unmute all remote audio
  document.querySelectorAll('.video-tile:not(#tile-local) video')
    .forEach(v => { v.muted = isDeafened; });

  // Discord behaviour: deafen also mutes yourself
  if (isDeafened && !isMuted) {
    isMuted = true;
    localStream.getAudioTracks().forEach(t => { t.enabled = false; });
    document.getElementById('tile-local')?.querySelector('.tile-mic-icon')?.classList.remove('hidden');
    document.getElementById('tile-local')?.classList.add('is-muted');
    socket.emit('user-state', { isMuted: true });
  }

  updateControls();
}

// ── Camera on / off ───────────────────────────────
function toggleCamera () {
  isCameraOff = !isCameraOff;
  localStream.getVideoTracks().forEach(t => { t.enabled = !isCameraOff; });
  document.getElementById('tile-local')?.classList.toggle('cam-off', isCameraOff);
  updateControls();
  socket.emit('user-state', { isCameraOff });
}

// ── Screen share ──────────────────────────────────
async function toggleScreenShare () {
  isScreenSharing ? await stopScreenShare() : await startScreenShare();
}

async function startScreenShare () {
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: { cursor: 'always' },
      audio: false,
    });
  } catch (e) {
    if (e.name !== 'NotAllowedError') showToast('Screen share unavailable in this browser');
    screenStream = null;
    return;
  }

  const screenTrack = screenStream.getVideoTracks()[0];

  // Replace the video sender in every peer connection
  for (const pc of Object.values(peers)) {
    const vs = pc.getSenders().find(s => s.track?.kind === 'video');
    if (vs) await vs.replaceTrack(screenTrack).catch(() => {});
  }

  // Update local tile preview
  const localVideo = document.querySelector('#tile-local video');
  if (localVideo) {
    localVideo.srcObject = new MediaStream([screenTrack]);
    document.getElementById('tile-local')?.classList.remove('cam-off');
  }

  isScreenSharing = true;
  const lt = document.getElementById('tile-local');
  lt?.classList.add('screen-sharing');
  lt?.querySelector('.tile-screen-badge')?.classList.remove('hidden');

  updateControls();
  socket.emit('user-state', { isScreenSharing: true });
  showToast('🖥️ Screen sharing started');

  // Auto-stop when user clicks browser's "Stop sharing"
  screenTrack.onended = () => stopScreenShare();
}

async function stopScreenShare () {
  if (!screenStream) return;
  screenStream.getTracks().forEach(t => t.stop());
  screenStream = null;

  const camTrack = localStream.getVideoTracks()[0];

  for (const pc of Object.values(peers)) {
    const vs = pc.getSenders().find(s => s.track?.kind === 'video');
    if (vs) await vs.replaceTrack(camTrack || null).catch(() => {});
  }

  // Restore local tile
  const localVideo = document.querySelector('#tile-local video');
  if (localVideo) localVideo.srcObject = localStream;
  if (isCameraOff) document.getElementById('tile-local')?.classList.add('cam-off');

  isScreenSharing = false;
  const lt = document.getElementById('tile-local');
  lt?.classList.remove('screen-sharing');
  lt?.querySelector('.tile-screen-badge')?.classList.add('hidden');

  updateControls();
  socket.emit('user-state', { isScreenSharing: false });
  showToast('Screen sharing stopped');
}

// ── Leave ─────────────────────────────────────────
function leaveRoom () {
  localStream?.getTracks().forEach(t => t.stop());
  screenStream?.getTracks().forEach(t => t.stop());
  Object.values(peers).forEach(pc => pc.close());
  socket.disconnect();
  window.location.href = '/';
}

// ══════════════════════════════════════════════════
//  UI HELPERS
// ══════════════════════════════════════════════════
function updateControls () {
  const $mute   = document.getElementById('btn-mute');
  const $deaf   = document.getElementById('btn-deaf');
  const $cam    = document.getElementById('btn-camera');
  const $screen = document.getElementById('btn-screen');

  if ($mute) {
    $mute.classList.toggle('active', isMuted);
    $mute.querySelector('.ctrl-icon').innerHTML =
      isMuted ? '<i class="fas fa-microphone-slash"></i>' : '<i class="fas fa-microphone"></i>';
    $mute.querySelector('.ctrl-label').textContent = isMuted ? 'Unmute' : 'Mute';
  }

  if ($deaf) {
    $deaf.classList.toggle('active', isDeafened);
    $deaf.querySelector('.ctrl-icon').innerHTML =
      isDeafened ? '<i class="fas fa-ear-deaf"></i>' : '<i class="fas fa-headphones"></i>';
    $deaf.querySelector('.ctrl-label').textContent = isDeafened ? 'Undeafen' : 'Deafen';
  }

  if ($cam) {
    $cam.classList.toggle('active', isCameraOff);
    $cam.querySelector('.ctrl-icon').innerHTML =
      isCameraOff ? '<i class="fas fa-video-slash"></i>' : '<i class="fas fa-video"></i>';
    $cam.querySelector('.ctrl-label').textContent = isCameraOff ? 'Start Video' : 'Stop Video';
  }

  if ($screen) {
    $screen.classList.toggle('screen-on', isScreenSharing);
    $screen.querySelector('.ctrl-label').textContent = isScreenSharing ? 'Stop Share' : 'Screen';
  }
}

function updateParticipantCount () {
  if (!participantEl) return;
  const n = Object.keys(peers).length + 1;
  participantEl.textContent = `${n} participant${n !== 1 ? 's' : ''}`;
}

// ── Toast ─────────────────────────────────────────
let _toastTimer = null;
function showToast (msg, ms = 3000) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.add('hidden'), ms);
}

// ── Copy invite link ──────────────────────────────
function copyInvite () {
  const url = `${location.origin}/?room=${encodeURIComponent(roomId)}`;
  navigator.clipboard.writeText(url).then(
    ()  => showToast('✅ Invite link copied!'),
    ()  => showToast('Room code: ' + roomId),
  );
}

// ── Boot ──────────────────────────────────────────
init();
