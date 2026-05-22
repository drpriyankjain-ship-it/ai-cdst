/* NurseAI Web — Audio Recording via MediaRecorder API */

let mediaRecorder = null;
let audioChunks = [];
let recordingStartTime = null;
let timerInterval = null;
let onTimerCb = null;
let stream = null;

export async function requestMicPermission() {
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach(t => t.stop());
    return true;
  } catch { return false; }
}

function getPreferredMime() {
  // Safari supports mp4, Chrome/Firefox support webm
  if (MediaRecorder.isTypeSupported('audio/mp4')) return 'audio/mp4';
  if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) return 'audio/webm;codecs=opus';
  if (MediaRecorder.isTypeSupported('audio/webm')) return 'audio/webm';
  return '';
}

export async function startRecording(onTimer) {
  try {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
      stream?.getTracks().forEach(t => t.stop());
    }

    stream = await navigator.mediaDevices.getUserMedia({
      audio: { sampleRate: 22050, channelCount: 1, echoCancellation: true, noiseSuppression: true }
    });

    const mimeType = getPreferredMime();
    const options = mimeType ? { mimeType } : {};

    audioChunks = [];
    mediaRecorder = new MediaRecorder(stream, options);

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) audioChunks.push(e.data);
    };

    mediaRecorder.start(1000); // collect chunks every 1s
    recordingStartTime = Date.now();
    onTimerCb = onTimer;

    if (timerInterval) clearInterval(timerInterval);
    timerInterval = setInterval(() => {
      if (onTimerCb && recordingStartTime) {
        onTimerCb(Math.floor((Date.now() - recordingStartTime) / 1000));
      }
    }, 500);

    return true;
  } catch (err) {
    console.error('startRecording error:', err);
    return false;
  }
}

export function stopRecording() {
  return new Promise((resolve) => {
    if (!mediaRecorder || mediaRecorder.state === 'inactive') {
      resolve(null);
      return;
    }

    mediaRecorder.onstop = () => {
      const mimeType = mediaRecorder.mimeType || getPreferredMime() || 'audio/webm';
      const blob = new Blob(audioChunks, { type: mimeType });
      const duration = recordingStartTime ? (Date.now() - recordingStartTime) / 1000 : 0;

      // Cleanup
      if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
      stream?.getTracks().forEach(t => t.stop());
      stream = null;
      audioChunks = [];
      recordingStartTime = null;
      onTimerCb = null;
      mediaRecorder = null;

      resolve({ blob, duration, mimeType });
    };

    mediaRecorder.stop();
  });
}

export function isCurrentlyRecording() {
  return mediaRecorder !== null && mediaRecorder.state === 'recording';
}

export function getRecordingDuration() {
  if (!recordingStartTime) return 0;
  return Math.floor((Date.now() - recordingStartTime) / 1000);
}

export function formatDuration(totalSeconds) {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function createAudioFormData(blob, fieldName = 'audio', filename = 'recording') {
  const fd = new FormData();
  const ext = blob.type?.includes('mp4') ? '.m4a' : '.webm';
  fd.append(fieldName, blob, `${filename}${ext}`);
  return fd;
}
